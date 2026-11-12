import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runEvaluation, scopeQuestions } from "./runner.ts";
import { runRetrievalEval } from "./retrieval-eval.ts";
import { validateJudge } from "./judge-validation.ts";
import { listModels } from "./llm.ts";
import {
  discoverProfiles,
  readyProfiles,
  resolveProfile,
  type ReadyProfile,
} from "./profiles.ts";
import { LADDER, runLadder } from "./ladder.ts";
import { runComparison } from "./compare.ts";
import { generateNarrative } from "./narrative.ts";
import { readBaseline } from "./baseline.ts";
import { buildMultiProjectComparison, type ProjectManifest } from "./projects.ts";
import { CODE_CHANGES, CODE_VERSION } from "./schema.ts";
import { describePrice } from "./pricing.ts";
import { knownModelsFor } from "./vendors.ts";
import { DEFAULT_RETRIEVAL, STRATEGIES } from "./strategies.ts";
import { serve, HARNESS_ROOT } from "./serve.ts";
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
  node --experimental-strip-types src/cli.ts projects <manifest.json> [--out multi-project.json] [--report 报告.json] [--step v7]
  node --experimental-strip-types src/cli.ts judge-check <dataset.json> [--out judge-validation.json] [--judge-model 档案]
 *   node --experimental-strip-types src/cli.ts serve [--port 8787]
 *   node --experimental-strip-types src/cli.ts models

 * 换模型跑：--model qwen；换打分模型：--judge-model glm。
 * 两个参数只影响这一次调用，不改 .env。
 */

export { STRATEGIES };

function usage(): never {
  console.error(
    `用法:
  node --experimental-strip-types src/cli.ts experiment <dataset.json> <repoRoot> [--out report.json] [--baseline 旧报告.json] [--model 档案] [--judge-model 档案] [--concurrency N]
  node --experimental-strip-types src/cli.ts recall <dataset.json> <repoRoot> [--out report.json]
  node --experimental-strip-types src/cli.ts run <dataset.json> <repoRoot> <strategyId> [--out run.json] [--limit N] [--model 档案] [--judge-model 档案] [--concurrency N]
  node --experimental-strip-types src/cli.ts ladder <dataset.json> <repoRoot> [--out report.json] [--reuse report.json] [--baseline 旧报告.json] [--model 档案] [--judge-model 档案] [--concurrency N]
  node --experimental-strip-types src/cli.ts report <run.json...> [--out report.json]
  node --experimental-strip-types src/cli.ts narrate <report.json> [--out report.json] [--model 档案]
  node --experimental-strip-types src/cli.ts models [--model 档案]
  node --experimental-strip-types src/cli.ts serve [--port 8787]
  node --experimental-strip-types src/cli.ts compare <dataset.json> <repoRoot> [--out comparison.json] [--report 旧报告.json] [--report-out 新报告.json] [--agents a,b] [--judges a,b] [--step v7] [--concurrency N]

可用策略: ${Object.keys(STRATEGIES).join(", ")}

模型档案在 harness/.env 里按前缀分组配置（如 LLM_ / QWEN_ / GLM_），
--model 指定被测模型，--judge-model 指定打分模型，不给就用 .env 里的默认档案。

compare 命令跑多模型对比：所有被测模型用同一份配置，每把尺子都量一遍。
--agents / --judges 用逗号分隔档案 id，--judges 的第一个是主尺子。

projects 命令做多项目对比：不同仓库用同一份配置各跑一轮，横向比。
manifest 里列出每个项目的评测集、仓库目录和运行记录路径。

judge-check 命令做 judge 自检：让 judge 给人工写的参考答案打分，和人工评分比较。

narrate 命令给已有报告补 AI 评语：照着这次跑出来的数字写一段话，
不重跑任何评测，只多花几次模型请求。

--concurrency N 让几道题同时问模型：不给就是 1（一题一题来），
给了就并发跑，整体时间更短，但服务商可能限流。

serve 命令起本地工作台：打开就是填数据和看结果，不需要先读介绍。
它复用同一套评测代码，只是把结果送到浏览器里。`,
  );
  process.exit(1);
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

/**
 * 同时发几次模型请求。
 *
 * 不给就是 1，也就是一题一题来——命令行的输出和以前一模一样。
 * 给了就并发跑：慢的机器上省时间，但也可能被服务商限流。
 */
function readConcurrency(args: string[]): number | undefined {
  const value = Number(flagValue(args, "--concurrency") ?? "0");
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
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

/**
 * 写一个 JSON 文件，同时在同目录的 history/ 下留一份带时间戳的副本。
 *
 * 同一个 --out 跑第二次就会覆盖上一次的结果，
 * 但「跑了很多次，哪一次最好」往往是事后才知道的——
 * 每次都留一份副本，历史结果就都在，不用靠文件名记。
 */
async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const payload = JSON.stringify(value, null, 2);
  await writeFile(path, payload, "utf8");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = path.split(/[\\/]/).pop() ?? "report.json";
  const copy = join(join(path, ".."), "history", `${base.replace(/\.json$/, "")}-${stamp}.json`);
  await mkdir(join(copy, ".."), { recursive: true });
  await writeFile(copy, payload, "utf8");
  console.log(`历史副本：${copy}`);
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
        concurrency: readConcurrency(args),
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
          concurrency: readConcurrency(args),
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
      concurrency: readConcurrency(args),
      onProgress: (done, total) =>
        console.log(`  (${done}/${total}) judge 自检`),
    });
    const judgeValidation = validation.summary;
    console.log(
      `  一致率 ${(judgeValidation.agreement * 100).toFixed(1)}%（${judgeValidation.sampled} 题）` +
        `  judge 均分 ${judgeValidation.meanJudgeScore.toFixed(2)} vs 人工均分 ${judgeValidation.meanHumanScore.toFixed(2)}`,
    );

    // 只跑前 N 题时，题数按实际跑的算，别再报题集的总题数。
    const scope = scopeQuestions(dataset, limit);
    console.log(
      `\n迭代阶梯：${scope.length} 题 × ${LADDER.length} 轮` +
        (scope.length < dataset.questions.length
          ? `（只跑前 ${scope.length} 题）`
          : ""),
    );
    const { steps, runs: ladderRuns } = await runLadder({
      dataset,
      repoRoot,
      llm,
      judgeLlm,
      successThreshold: 4,
      reuseRuns: [...(previous?.runs ?? []), ...(previous?.ladderRuns ?? [])],
      limit,
      concurrency: readConcurrency(args),
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
    // 检索层要和生成层量同一批题，两个分母不一样就没法对照。
    const strategyMetrics = await runRetrievalEval({
      dataset: { ...dataset, questions: scope },
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
      concurrency: readConcurrency(args),
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

    const ready = readyProfiles(process.env);
    if (ready.length === 0) {
      console.error(
        "harness/.env 里没有配置完整的模型档案，" +
          discoverProfiles(process.env)
            .map(
              (profile) =>
                `${profile.id} 缺 ${profile.missing.join("/") || "无"}`,
            )
            .join("；"),
      );
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

    // 多模型对比的前提是有两个及以上配全的档案：
    // 只有一个模型就谈不上对比，尺子自评偏袒也没法算。
    if (agents.length < 2) {
      console.error(
        `多模型对比至少要两个配置完整的档案，现在只有 ${agents.length} 个` +
          `（${agents.map((item) => item.label).join(" / ")}）。` +
          "在 harness/.env 里再填一组 *_API_KEY 就行；只跑一个模型用 experiment 命令。",
      );
      process.exit(1);
    }

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
      concurrency: readConcurrency(args),
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

  if (command === "judge-check") {
    const [datasetPath] = args;
    if (!datasetPath) usage();

    const outputPath =
      flagValue(args, "--out") ??
      join(process.cwd(), "out", "judge-validation.json");
    const dataset = await readDataset(datasetPath);
    const { judge } = selectModels(process.env, args);

    console.log(
      `judge 自检：${dataset.questions.length} 题的人工参考答案（打分模型 ${judge.config.model}）`,
    );
    const validation = await validateJudge(dataset, judge.config, {
      concurrency: readConcurrency(args),
      onProgress: (done, total) =>
        console.log(`  (${done}/${total}) judge 自检`),
    });

    console.log(
      `  一致率 ${(validation.summary.agreement * 100).toFixed(1)}%` +
        `（${validation.summary.sampled} 题）` +
        `  judge 均分 ${validation.summary.meanJudgeScore.toFixed(2)}` +
        ` vs 人工均分 ${validation.summary.meanHumanScore.toFixed(2)}`,
    );

    await writeJson(outputPath, {
      datasetId: dataset.id,
      judgeModel: judge.config.model,
      summary: validation.summary,
      details: validation.details,
    });
    console.log(`\n自检结果已写入 ${outputPath}`);
    return;
  }

  if (command === "projects") {
    const [manifestPath] = args;
    if (!manifestPath) usage();

    const outputPath =
      flagValue(args, "--out") ??
      join(process.cwd(), "out", "multi-project.json");
    const reportPath = flagValue(args, "--report");
    const stepId = flagValue(args, "--step") ?? "v7";

    const manifest = JSON.parse(
      await readFile(manifestPath, "utf8"),
    ) as ProjectManifest;

    const comparison = await buildMultiProjectComparison({
      manifest,
      step: stepId,
      successThreshold: 4,
      onProgress: (message) => console.log(`  ${message}`),
    });

    console.log("\n=== 多项目对比 ===");
    console.log(
      `共用配置：${comparison.chunking.label}，top-${comparison.retrieval.topK}，` +
        `${comparison.retrieval.rerankMode ?? "none"}，提示词 ${comparison.promptVersion}`,
    );
    for (const row of comparison.rows) {
      console.log(
        `  ${row.label.padEnd(10)} 成功率 ${(row.successRate * 100).toFixed(1)}%` +
          `  均分 ${row.avgJudgeScore.toFixed(2)}` +
          `  recall@1 ${(row.retrievalMetrics.recallAt1 * 100).toFixed(1)}%` +
          `  MRR ${row.retrievalMetrics.mrr.toFixed(3)}` +
          `  ${row.questions} 题 / ${row.fileCount} 文件` +
          `  成本 ¥${row.totalCost.toFixed(4)}`,
      );
    }

    await writeJson(outputPath, comparison);
    console.log(`\n对比结果已写入 ${outputPath}`);

    if (reportPath) {
      const report = JSON.parse(
        await readFile(reportPath, "utf8"),
      ) as ExperimentReport;
      report.multiProject = comparison;
      await writeJson(reportPath, report);
      console.log(`报告已写入 ${reportPath}`);
    }
    return;
  }

  if (command === "narrate") {
    const [reportPath] = args;
    if (!reportPath) usage();

    const outputPath = flagValue(args, "--out") ?? reportPath;
    const { judge } = selectModels(process.env, args);
    const report = JSON.parse(
      await readFile(reportPath, "utf8"),
    ) as ExperimentReport;

    console.log(
      `AI 评语：用 ${judge.label}（${judge.config.model}）照着这次跑出来的数字讲一段话`,
    );
    const { narrative, failed } = await generateNarrative(report, judge.config);
    report.narrative = { ...(report.narrative ?? {}), ...narrative };

    for (const [key, text] of Object.entries(report.narrative)) {
      console.log(`  【${key}】${text}`);
    }
    if (failed.length > 0) {
      console.log(`  没写出来的板块：${failed.join("、")}`);
    }

    await writeJson(outputPath, report);
    console.log(`\n报告已写入 ${outputPath}`);
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
        const listed = await listModels(profile.config);
        // 服务商的 /models 有些免费模型不列（智谱就是），把已知的补上。
        const models = [
          ...listed,
          ...knownModelsFor(profile.baseUrl).filter((id) => !listed.includes(id)),
        ];
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

  if (command === "pricing") {
    const profiles = discoverProfiles(process.env);
    if (profiles.length === 0) {
      throw new Error(
        "harness/.env 里还没有模型档案。先复制 .env.example 成 .env，再填 *_BASE_URL / *_API_KEY / *_MODEL。",
      );
    }

    console.log(`从 harness/.env 里读到 ${profiles.length} 个模型档案：\n`);
    for (const profile of profiles) {
      console.log(`[${profile.id}] ${profile.label}   （前缀 ${profile.prefix}_）`);
      console.log(`  模型 ${profile.model || "（还没填 *_MODEL）"}`);
      if (profile.missing.length > 0) {
        console.log(`  没配好，缺 ${profile.missing.join(" / ")}`);
      }
      console.log(`  单价 ${describePrice(profile.price, profile.priceSource)}`);
      console.log("");
    }

    console.log("单价没填也没查到表的话，成本会记成 0——这不是模型免费。");
    console.log(
      "在 .env 里写 *_PRICE_PROMPT / *_PRICE_COMPLETION / *_PRICE_PROMPT_CACHE_HIT 可以覆盖内置价目表。",
    );
    return;
  }

  if (command === "serve") {
    const port = Number(flagValue(args, "--port") ?? "8787");
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`端口不合法：${port}`);
    }
    const workbenchRoot = join(HARNESS_ROOT, "..", "site", "dist-local");
    const storyRoot = join(HARNESS_ROOT, "..", "site", "dist");
    const datasetsRoot = join(HARNESS_ROOT, "datasets");
    const defaultRepoRoot = resolve(
      join(HARNESS_ROOT, "..", "corpus", "repos", "flask-3.1.3"),
    );

    try {
      await stat(join(workbenchRoot, "local.html"));
    } catch {
      throw new Error(
        `还没构建本地工作台：${workbenchRoot} 里没有 local.html。\n` +
          "先构建一次：cd site && npm ci && npm run build",
      );
    }

    try {
      await stat(join(storyRoot, "index.html"));
    } catch {
      throw new Error(
        `还没构建站点：${storyRoot} 里没有 index.html。\n` +
          "先构建一次：cd site && npm ci && npm run build",
      );
    }

    await serve({ port, workbenchRoot, storyRoot, datasetsRoot, defaultRepoRoot });
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
