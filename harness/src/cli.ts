import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runEvaluation } from "./runner.ts";
import { runRetrievalEval } from "./retrieval-eval.ts";
import { validateJudge } from "./judge-validation.ts";
import { listModels } from "./llm.ts";
import { discoverProfiles, resolveProfile, type ReadyProfile } from "./profiles.ts";
import { LADDER, runLadder } from "./ladder.ts";
import { runComparison } from "./compare.ts";
import { readBaseline } from "./baseline.ts";
import { CODE_CHANGES, CODE_VERSION } from "./schema.ts";
import type {
  BaselineSnapshot,
  ChunkingStrategy,
  EvalDataset,
  EvalRun,
  ExperimentReport,
  JudgeValidation,
  LadderStep,
  RetrievalConfig,
} from "./schema.ts";

/**
 * 评测流水线入口。
 *
 *   node --experimental-strip-types src/cli.ts experiment <dataset> <repoRoot> [--out report.json]
 *   node --experimental-strip-types src/cli.ts recall    <dataset> <repoRoot> [--out report.json]
 *   node --experimental-strip-types src/cli.ts run       <dataset> <repoRoot> <strategyId> [--out run.json]
 *   node --experimental-strip-types src/cli.ts ladder    <dataset.json> <repoRoot> [--out report.json] [--reuse report.json]
  node --experimental-strip-types src/cli.ts report    <run.json...> [--out report.json]
 *   node --experimental-strip-types src/cli.ts models

 * 换模型跑：--model qwen；换打分模型：--judge-model glm。
 * 两个参数只影响这一次调用，不改 .env。
 */

export const STRATEGIES: Record<string, ChunkingStrategy> = {
  "fixed-800": {
    id: "fixed-800",
    label: "固定窗口 800 字符",
    kind: "fixed-window",
    windowSize: 800,
    overlap: 120,
  },
  "fixed-400": {
    id: "fixed-400",
    label: "固定窗口 400 字符",
    kind: "fixed-window",
    windowSize: 400,
    overlap: 60,
  },
  "function-level": {
    id: "function-level",
    label: "函数级切分",
    kind: "function-level",
    minFunctionLines: 3,
  },
};

/**
 * 横向对比时三种切分策略共用的检索配置。
 *
 * 三种策略必须用同一套检索器，否则分数的变化说不清是切分造成的还是检索造成的。
 * 这里用的是工具迭代到最后一轮定下来的那套配置（BM25 + 结构感知重排 + 中英术语扩展），
 * 也就是评测台实际会跑的那一套——在最好的操作点上比较切分方式。
 */
const DEFAULT_RETRIEVAL: RetrievalConfig = {
  topK: 6,
  rerank: true,
  rerankMode: "structure-aware",
  queryExpansion: true,
};

function usage(): never {
  console.error(
    `用法:
  node --experimental-strip-types src/cli.ts experiment <dataset.json> <repoRoot> [--out report.json] [--baseline 旧报告.json] [--model 档案] [--judge-model 档案]
  node --experimental-strip-types src/cli.ts recall <dataset.json> <repoRoot> [--out report.json]
  node --experimental-strip-types src/cli.ts run <dataset.json> <repoRoot> <strategyId> [--out run.json] [--limit N] [--model 档案] [--judge-model 档案]
  node --experimental-strip-types src/cli.ts ladder <dataset.json> <repoRoot> [--out report.json] [--reuse report.json] [--baseline 旧报告.json] [--model 档案] [--judge-model 档案]
  node --experimental-strip-types src/cli.ts report <run.json...> [--out report.json]
  node --experimental-strip-types src/cli.ts models [--model 档案]
  node --experimental-strip-types src/cli.ts compare <dataset.json> <repoRoot> [--out comparison.json] [--report 旧报告.json] [--report-out 新报告.json] [--agents a,b] [--judges a,b] [--step v7]

可用策略: ${Object.keys(STRATEGIES).join(", ")}

模型档案在 harness/.env 里按前缀分组配置（如 LLM_ / QWEN_ / GLM_），
--model 指定被测模型，--judge-model 指定打分模型，不给就用 .env 里的默认档案。

compare 命令跑多模型对比：所有被测模型用同一份配置，每把尺子都量一遍。
--agents / --judges 用逗号分隔档案 id，--judges 的第一个是主尺子。`,
  );
  process.exit(1);
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

/**
 * 这次跑用哪个模型打分、哪个模型被测。
 *
 * 默认两个都是 .env 里的默认档案；--judge-model 可以把打分换成别家模型，
 * 用来排除 judge 偏袒自己那家模型的情况。
 */
function selectModels(
  env: Record<string, string | undefined>,
  args: string[],
): { agent: ReadyProfile; judge: ReadyProfile } {
  const agent = resolveProfile(env, flagValue(args, "--model"));
  const judgeId = flagValue(args, "--judge-model");
  const judge = judgeId ? resolveProfile(env, judgeId) : agent;
  return { agent, judge };
}

async function readDataset(path: string): Promise<EvalDataset> {
  return JSON.parse(await readFile(path, "utf8")) as EvalDataset;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
}

/**
 * 读取上一版报告，作为「优化前后」的对照基线。
 *
 * 基线必须是旧报告里真实跑出来的记录，不能凭记忆手写数字，
 * 否则站上的「前后对比」就成了自我表扬。
 */
async function readBaselineFrom(
  path: string | undefined,
): Promise<BaselineSnapshot | undefined> {
  if (!path) return undefined;
  const previous = JSON.parse(await readFile(path, "utf8")) as ExperimentReport;
  const snapshot = readBaseline(previous);
  if (!snapshot) {
    console.log(`基线报告 ${path} 里没有可用的横向对比记录，跳过对照`);
    return undefined;
  }
  console.log(
    `对照基线：${path}（代码版本 ${snapshot.codeVersion}，` +
      `成功率 ${(snapshot.summary.successRate * 100).toFixed(1)}%，` +
      `${snapshot.chunking.label}）`,
  );
  return snapshot;
}

/**
 * 读取 harness/.env，让 API Key 只存在于本地文件，不进命令行也不进版本库。
 * 已经存在的环境变量优先，不被文件覆盖。
 */
function loadDotEnv(): void {
  const envPath = join(process.cwd(), ".env");
  try {
    process.loadEnvFile(envPath);
  } catch {
    // 没有 .env 就直接用环境变量，不是错误
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command) usage();

  loadDotEnv();

  if (command === "experiment" || command === "recall") {
    const [datasetPath, repoRoot] = args;
    if (!datasetPath || !repoRoot) usage();

    const outputPath =
      flagValue(args, "--out") ?? join(process.cwd(), "out", "report.json");
    const dataset = await readDataset(datasetPath);
    const strategies = Object.values(STRATEGIES);

    console.log(`检索层评测：${dataset.questions.length} 题 × ${strategies.length} 种切分策略`);
    const strategyMetrics = await runRetrievalEval({
      dataset,
      repoRoot,
      strategies,
      retrieval: DEFAULT_RETRIEVAL,
    });

    for (const metrics of strategyMetrics) {
      console.log(
        `  ${metrics.strategy.id.padEnd(15)} recall@1 ${(metrics.recallAt1 * 100).toFixed(1)}%  ` +
          `recall@3 ${(metrics.recallAt3 * 100).toFixed(1)}%  ` +
          `recall@6 ${(metrics.recallAt6 * 100).toFixed(1)}%  ` +
          `MRR ${metrics.mrr.toFixed(3)}  块数 ${metrics.chunkCount}`,
      );
    }

    const runs: EvalRun[] = [];
    let selection: { agent: ReadyProfile; judge: ReadyProfile } | null = null;
    if (command === "experiment") {
      try {
        selection = selectModels(process.env, args);
      } catch (error) {
        console.log(
          `\n${error instanceof Error ? error.message : String(error)}`,
        );
        console.log("跳过生成层评测（检索层结果不受影响）。");
      }
    }
    const llm = selection?.agent.config ?? null;
    const judgeLlm = selection?.judge.config ?? null;
    let judgeValidation: JudgeValidation = {
      sampled: 0,
      agreement: 0,
      meanJudgeScore: 0,
      meanHumanScore: 0,
      exactAgreement: 0,
      note: "尚未运行 judge 自检",
    };

    if (command === "experiment" && llm && judgeLlm) {
      console.log(
        `\n被测模型 ${selection!.agent.label}（${llm.model}）` +
          `，打分模型 ${selection!.judge.label}（${judgeLlm.model}）`,
      );
      console.log(`\njudge 自检：让 judge 给人工参考答案打分（模型 ${judgeLlm.model}）`);
      const validation = await validateJudge(dataset, judgeLlm, {
        onProgress: (done, total) =>
          console.log(`  (${done}/${total}) judge 自检`),
      });
      judgeValidation = validation.summary;
      console.log(
        `  一致率 ${(judgeValidation.agreement * 100).toFixed(1)}%（${judgeValidation.sampled} 题）` +
          `  judge 均分 ${judgeValidation.meanJudgeScore.toFixed(2)} vs 人工均分 ${judgeValidation.meanHumanScore.toFixed(2)}`,
      );

      for (const strategy of strategies) {
        console.log(`\n生成层评测：${strategy.label}（模型 ${llm.model}）`);
        const run = await runEvaluation({
          dataset,
          repoRoot,
          chunking: strategy,
          retrieval: DEFAULT_RETRIEVAL,
          llm,
          judgeLlm,
          successThreshold: 4,
          runId: `${strategy.id}-${Date.now()}`,
          onProgress: (done, total, message) =>
            console.log(`  (${done}/${total}) ${message}`),
        });
        run.origin = "strategy-compare";
        runs.push(run);

        const metrics = strategyMetrics.find(
          (item) => item.strategy.id === strategy.id,
        );
        if (metrics) {
          metrics.successRate = run.summary.successRate;
          metrics.avgJudgeScore = run.summary.avgJudgeScore;
          metrics.avgLatencyMs = run.summary.avgLatencyMs;
          metrics.p95LatencyMs = run.summary.p95LatencyMs;
          metrics.avgCost = run.summary.avgCost;
          metrics.totalCost = run.summary.totalCost;
          metrics.totalTokens = run.summary.totalTokens;
        }
      }
    } else if (command === "experiment") {
      console.log(
        "\n没有可用的模型档案，跳过生成层评测（检索层结果不受影响）。",
      );
    }

    const report: ExperimentReport = {
      datasetId: dataset.id,
      repo: dataset.repo,
      costCurrency: llm?.currency ?? "¥",
      judgeValidation,
      strategies: strategyMetrics,
      runs,
      ladderRuns: [],
      ladder: [],
      baseline: await readBaselineFrom(flagValue(args, "--baseline")),
      changes: CODE_CHANGES[CODE_VERSION] ?? [],
    };

    await writeJson(outputPath, report);
    console.log(`\n报告已写入 ${outputPath}`);
    return;
  }

  if (command === "ladder") {
    const [datasetPath, repoRoot] = args;
    if (!datasetPath || !repoRoot) usage();

    const outputPath =
      flagValue(args, "--out") ?? join(process.cwd(), "out", "report.json");
    const reusePath = flagValue(args, "--reuse");
    const limit = Number(flagValue(args, "--limit") ?? "0") || undefined;

    const dataset = await readDataset(datasetPath);
    const { agent, judge } = selectModels(process.env, args);
    const llm = agent.config;
    const judgeLlm = judge.config;
    console.log(
      `被测模型 ${agent.label}（${llm.model}），打分模型 ${judge.label}（${judgeLlm.model}）`,
    );

    let previous: ExperimentReport | null = null;
    if (reusePath) {
      previous = JSON.parse(
        await readFile(reusePath, "utf8"),
      ) as ExperimentReport;
      console.log(`复用 ${reusePath} 的 judge 自检与已有运行记录`);
    }

    // judge 自检必须在同一批协议里重跑：阶梯的分数全靠这把尺子。
    console.log(`judge 自检：让 judge 给人工参考答案打分（模型 ${judgeLlm.model}）`);
    const validation = await validateJudge(dataset, judgeLlm, {
      onProgress: (done, total) =>
        console.log(`  (${done}/${total}) judge 自检`),
    });
    const judgeValidation = validation.summary;
    console.log(
      `  一致率 ${(judgeValidation.agreement * 100).toFixed(1)}%（${judgeValidation.sampled} 题）` +
        `  judge 均分 ${judgeValidation.meanJudgeScore.toFixed(2)} vs 人工均分 ${judgeValidation.meanHumanScore.toFixed(2)}`,
    );

    console.log(`\n迭代阶梯：${dataset.questions.length} 题 × ${LADDER.length} 轮`);
    const { steps, runs: ladderRuns } = await runLadder({
      dataset,
      repoRoot,
      llm,
      judgeLlm,
      successThreshold: 4,
      reuseRuns: [...(previous?.runs ?? []), ...(previous?.ladderRuns ?? [])],
      limit,
      onProgress: (step, done, total, message) =>
        console.log(`  (${done}/${total}) ${message}`),
    });

    for (const step of steps) {
      console.log(
        `  ${step.id} 成功率 ${(step.summary.successRate * 100).toFixed(1)}%` +
          `  recall@1 ${(step.retrievalMetrics.recallAt1 * 100).toFixed(1)}%` +
          `  成本 ¥${step.summary.totalCost.toFixed(4)}  — ${step.title}`,
      );
    }

    // 横向策略对比那一段仍然要，站点上两个板块共用一份报告。
    const strategyMetrics = await runRetrievalEval({
      dataset,
      repoRoot,
      strategies: Object.values(STRATEGIES),
      retrieval: DEFAULT_RETRIEVAL,
    });

    // 只保留当前代码版本、且题数完整跑完的记录。改过切分/检索实现之后，
    // 旧记录和新的不是同一份东西；--limit 跑出来的也不完整。
    // 混进报告里等于报告自相矛盾。
    const reusable = (run: EvalRun): boolean =>
      run.codeVersion === CODE_VERSION &&
      run.cases.length === dataset.questions.length;

    // runs 只放横向对比的记录：阶梯的记录单独放 ladderRuns，
    // 否则站点上的胜负矩阵会把阶梯的五轮也算成五列策略。
    const strategyRuns = (previous?.runs ?? []).filter(
      (run) => reusable(run) && run.origin !== "ladder",
    );

    // runRetrievalEval 只算检索层，生成层的数字得从复用来的运行记录里回填，
    // 否则报告里的策略只有召回没有成功率，站点的生成层区块整块都不会渲染。
    for (const run of strategyRuns) {
      const metrics = strategyMetrics.find(
        (item) => item.strategy.id === run.chunking.id,
      );
      if (!metrics) continue;
      metrics.successRate = run.summary.successRate;
      metrics.avgJudgeScore = run.summary.avgJudgeScore;
      metrics.avgLatencyMs = run.summary.avgLatencyMs;
      metrics.p95LatencyMs = run.summary.p95LatencyMs;
      metrics.avgCost = run.summary.avgCost;
      metrics.totalCost = run.summary.totalCost;
      metrics.totalTokens = run.summary.totalTokens;
    }

    const report: ExperimentReport = {
      datasetId: dataset.id,
      repo: dataset.repo,
      costCurrency: llm.currency ?? "¥",
      judgeValidation,
      strategies: strategyMetrics,
      runs: strategyRuns,
      ladderRuns,
      ladder: steps,
      // --baseline 没给时沿用被复用报告里已有的基线，
      // 否则复用旧运行记录重跑一遍就会把对照弄丢。
      baseline:
        (await readBaselineFrom(flagValue(args, "--baseline"))) ??
        previous?.baseline,
      changes: CODE_CHANGES[CODE_VERSION] ?? [],
    };

    await writeJson(outputPath, report);
    console.log(`\n报告已写入 ${outputPath}`);
    return;
  }

  if (command === "run") {
    const [datasetPath, repoRoot, strategyId] = args;
    if (!datasetPath || !repoRoot || !strategyId) usage();

    // --step 直接复用阶梯某一轮的完整配置（切分 + 检索 + 提示词），
    // 这样多模型对比跑的就是同一套配置，能和阶梯那一轮的数字直接对照。
    const stepId = flagValue(args, "--step");
    const step = stepId ? LADDER.find((item) => item.id === stepId) : undefined;
    if (stepId && !step) {
      console.error(`阶梯里没有 ${stepId} 这一轮`);
      process.exit(1);
    }

    const strategy = step ? step.chunking : STRATEGIES[strategyId];
    if (!strategy) {
      console.error(`未知策略 ${strategyId}`);
      process.exit(1);
    }
    const retrieval = step ? step.retrieval : DEFAULT_RETRIEVAL;
    const promptVersion = step?.promptVersion;

    const outputPath =
      flagValue(args, "--out") ?? join(process.cwd(), "out", "run.json");
    const limit = Number(flagValue(args, "--limit") ?? "0") || undefined;

    const dataset = await readDataset(datasetPath);
    const { agent, judge } = selectModels(process.env, args);
    const llm = agent.config;
    const judgeLlm = judge.config;

    const run = await runEvaluation({
      dataset,
      repoRoot,
      chunking: strategy,
      retrieval,
      llm,
      judgeLlm,
      successThreshold: 4,
      runId: `${strategy.id}-${Date.now()}`,
      promptVersion,
      limit,
      onProgress: (done, total, message) =>
        console.log(`(${done}/${total}) ${message}`),
    });

    await writeJson(outputPath, run);

    console.log("\n=== 运行摘要 ===");
    console.log(`策略          : ${strategy.label}`);
    console.log(`检索配置      : top-${retrieval.topK} / ${retrieval.rerankMode ?? "none"} / 展开=${retrieval.queryExpansion ?? false}`);
    console.log(`提示词版本    : ${promptVersion ?? "base"}`);
    console.log(`被测模型      : ${agent.label}（${run.model}）`);
    console.log(`打分模型      : ${judge.label}（${run.judgeModel}）`);
    console.log(`成功率(>=4分) : ${(run.summary.successRate * 100).toFixed(1)}%`);
    console.log(`平均证据召回  : ${(run.summary.avgEvidenceRecall * 100).toFixed(1)}%`);
    console.log(`平均延迟      : ${run.summary.avgLatencyMs.toFixed(0)}ms`);
    console.log(`总成本        : ${run.summary.totalCost.toFixed(4)}`);
    console.log(`报告已写入    : ${outputPath}`);
    return;
  }

  if (command === "report") {
    const paths = args.filter((arg) => !arg.startsWith("--") && !isFlagValue(args, arg));
    const outputPath =
      flagValue(args, "--out") ?? join(process.cwd(), "out", "report.json");

    const runs: EvalRun[] = [];
    for (const path of paths) {
      runs.push(JSON.parse(await readFile(path, "utf8")) as EvalRun);
    }
    if (runs.length === 0) usage();

    const report: ExperimentReport = {
      datasetId: runs[0].datasetId,
      repo: runs[0].repo,
      costCurrency: "¥",
      judgeValidation: {
        sampled: 0,
        agreement: 0,
        meanJudgeScore: 0,
        meanHumanScore: 0,
        exactAgreement: 0,
        note: "report 命令只合并运行记录，judge 自检需用 experiment 命令生成",
      },
      strategies: [],
      runs,
      ladderRuns: [],
      ladder: [],
    };

    await writeJson(outputPath, report);
    console.log(`报告已写入 ${outputPath}`);
    console.log(`已合并 ${runs.length} 次运行记录`);
    return;
  }

  if (command === "compare") {
    const [datasetPath, repoRoot] = args;
    if (!datasetPath || !repoRoot) usage();

    const outputPath =
      flagValue(args, "--out") ?? join(process.cwd(), "out", "comparison.json");
    const reportPath = flagValue(args, "--report");
    const reportOutPath = flagValue(args, "--report-out");
    const limit = Number(flagValue(args, "--limit") ?? "0") || undefined;

    // 默认用阶梯的最后一轮：多模型对比要和已发布的数字同配置，
    // 换一份配置就没有对照的意义了。
    const stepId = flagValue(args, "--step");
    const step = stepId
      ? LADDER.find((item) => item.id === stepId)
      : LADDER[LADDER.length - 1];
    if (!step) {
      console.error(`阶梯里没有 ${stepId} 这一轮`);
      process.exit(1);
    }

    const dataset = await readDataset(datasetPath);

    const ready = discoverProfiles(process.env)
      .filter((profile) => profile.config && profile.missing.length === 0)
      .map((profile) => profile as ReadyProfile);
    if (ready.length === 0) {
      console.error("harness/.env 里没有配置完整的模型档案");
      process.exit(1);
    }

    const pick = (flag: string | undefined, what: string): ReadyProfile[] => {
      if (!flag) return ready;
      const ids = flag
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      return ids.map((id) => {
        const match = ready.find(
          (profile) => profile.id.toLowerCase() === id.toLowerCase(),
        );
        if (!match) {
          throw new Error(
            `没有名为 ${id} 的${what}档案。可用的：${ready
              .map((profile) => profile.id)
              .join(" / ")}`,
          );
        }
        return match;
      });
    };

    const agents = pick(flagValue(args, "--agents"), "被测模型");
    const judges = pick(flagValue(args, "--judges"), "打分模型");
    const primary = judges[0];

    let baseReport: ExperimentReport | undefined;
    let reuseRuns: EvalRun[] = [];
    if (reportPath) {
      baseReport = JSON.parse(
        await readFile(reportPath, "utf8"),
      ) as ExperimentReport;
      reuseRuns = [...(baseReport.runs ?? []), ...(baseReport.ladderRuns ?? [])];
    }

    console.log(
      `多模型对比：${agents.length} 个被测模型 × ${judges.length} 把尺子` +
        `（主尺子 ${primary.label} / ${primary.config.model}）`,
    );
    console.log(
      `配置：${step.chunking.label}，top-${step.retrieval.topK}，` +
        `${step.retrieval.rerankMode ?? "none"}，提示词 ${step.promptVersion}`,
    );

    const comparison = await runComparison({
      dataset,
      repoRoot,
      agents,
      judges,
      chunking: step.chunking,
      retrieval: step.retrieval,
      promptVersion: step.promptVersion ?? "base",
      successThreshold: 4,
      reuseRuns,
      limit,
      onProgress: (message) => console.log(`  ${message}`),
    });

    console.log("\n=== 多模型对比 ===");
    for (const row of comparison.rows) {
      const cells = row.cells
        .map(
          (cell) =>
            `${cell.judgeProfileLabel} ${(cell.successRate * 100).toFixed(1)}%`,
        )
        .join(" / ");
      console.log(
        `  ${row.agentProfileLabel.padEnd(6)} 平均 ${(row.avgSuccessRate * 100).toFixed(1)}%` +
          `  (${cells})  成本 ¥${row.totalCost.toFixed(4)}` +
          `${row.reused ? "  [复用已有运行]" : ""}`,
      );
    }
    for (const item of comparison.agreementMatrix) {
      console.log(
        `  尺子一致率 ${item.judgeA} ↔ ${item.judgeB}：` +
          `${(item.agreement * 100).toFixed(1)}%（${item.sampled} 题，翻转 ${item.flips} 题）`,
      );
    }
    for (const item of comparison.selfPreference) {
      console.log(
        `  自评偏袒 ${item.judgeProfileLabel}：本家 ${item.ownAvgScore.toFixed(2)}` +
          ` vs 他家 ${item.otherAvgScore.toFixed(2)}，差 ${item.gap.toFixed(2)}`,
      );
    }

    await writeJson(outputPath, comparison);
    console.log(`\n对比结果已写入 ${outputPath}`);

    if (baseReport) {
      baseReport.modelComparison = comparison;
      const target = reportOutPath ?? reportPath!;
      await writeJson(target, baseReport);
      console.log(`报告已写入 ${target}`);
    }
    return;
  }

  if (command === "models") {
    const only = flagValue(args, "--model");
    const profiles = discoverProfiles(process.env).filter(
      (profile) => !only || profile.id.toLowerCase() === only.toLowerCase(),
    );
    if (profiles.length === 0) {
      const known = discoverProfiles(process.env)
        .map((profile) => profile.id)
        .join(" / ");
      throw new Error(`没有名为 ${only} 的模型档案。已知的档案：${known || "无"}`);
    }

    console.log(`从 harness/.env 里读到 ${profiles.length} 个模型档案：\n`);
    for (const profile of profiles) {
      console.log(`[${profile.id}] ${profile.label}   （前缀 ${profile.prefix}_）`);
      if (!profile.config) {
        console.log(`  没配好，缺 ${profile.missing.join(" / ")}`);
        console.log("");
        continue;
      }
      console.log(`  接口 ${profile.baseUrl}`);
      console.log(
        profile.model
          ? `  已选模型 ${profile.model}`
          : `  还没选模型，填 ${profile.prefix}_MODEL=`,
      );
      try {
        const models = await listModels(profile.config);
        for (const id of models) console.log(`    ${id}`);
      } catch (error) {
        console.log(
          `  取模型列表失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      console.log("");
    }
    return;
  }

  usage();
}

function isFlagValue(args: string[], value: string): boolean {
  const index = args.indexOf(value);
  return index > 0 && args[index - 1].startsWith("--");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
