import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runEvaluation } from "./runner.ts";
import { runRetrievalEval } from "./retrieval-eval.ts";
import { validateJudge } from "./judge-validation.ts";
import { configFromEnv, listModels, tryConfigFromEnv } from "./llm.ts";
import { LADDER, runLadder } from "./ladder.ts";
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
  node --experimental-strip-types src/cli.ts experiment <dataset.json> <repoRoot> [--out report.json] [--baseline 旧报告.json]
  node --experimental-strip-types src/cli.ts recall <dataset.json> <repoRoot> [--out report.json]
  node --experimental-strip-types src/cli.ts run <dataset.json> <repoRoot> <strategyId> [--out run.json] [--limit N]
  node --experimental-strip-types src/cli.ts ladder <dataset.json> <repoRoot> [--out report.json] [--reuse report.json] [--baseline 旧报告.json]
  node --experimental-strip-types src/cli.ts report <run.json...> [--out report.json]
  node --experimental-strip-types src/cli.ts models

可用策略: ${Object.keys(STRATEGIES).join(", ")}`,
  );
  process.exit(1);
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
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
    const llm = command === "experiment" ? tryConfigFromEnv(process.env) : null;
    let judgeValidation: JudgeValidation = {
      sampled: 0,
      agreement: 0,
      meanJudgeScore: 0,
      meanHumanScore: 0,
      exactAgreement: 0,
      note: "尚未运行 judge 自检",
    };

    if (command === "experiment" && llm) {
      console.log(`\njudge 自检：让 judge 给人工参考答案打分（模型 ${llm.model}）`);
      const validation = await validateJudge(dataset, llm, {
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
        "\n未检测到 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL，跳过生成层评测（检索层结果不受影响）。",
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
    const llm = configFromEnv(process.env);

    let previous: ExperimentReport | null = null;
    if (reusePath) {
      previous = JSON.parse(
        await readFile(reusePath, "utf8"),
      ) as ExperimentReport;
      console.log(`复用 ${reusePath} 的 judge 自检与已有运行记录`);
    }

    // judge 自检必须在同一批协议里重跑：阶梯的分数全靠这把尺子。
    console.log(`judge 自检：让 judge 给人工参考答案打分（模型 ${llm.model}）`);
    const validation = await validateJudge(dataset, llm, {
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

    const strategy = STRATEGIES[strategyId];
    if (!strategy) {
      console.error(`未知策略 ${strategyId}`);
      process.exit(1);
    }

    const outputPath =
      flagValue(args, "--out") ?? join(process.cwd(), "out", "run.json");
    const limit = Number(flagValue(args, "--limit") ?? "0") || undefined;

    const dataset = await readDataset(datasetPath);
    const llm = configFromEnv(process.env);

    const run = await runEvaluation({
      dataset,
      repoRoot,
      chunking: strategy,
      retrieval: DEFAULT_RETRIEVAL,
      llm,
      successThreshold: 4,
      runId: `${strategy.id}-${Date.now()}`,
      limit,
      onProgress: (done, total, message) =>
        console.log(`(${done}/${total}) ${message}`),
    });

    await writeJson(outputPath, run);

    console.log("\n=== 运行摘要 ===");
    console.log(`策略          : ${strategy.label}`);
    console.log(`模型          : ${run.model}`);
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

  if (command === "models") {
    const config = configFromEnv(process.env);
    const models = await listModels(config);
    console.log(`接口 ${config.baseUrl} 上可用的模型：`);
    for (const id of models) console.log(`  ${id}`);
    console.log(`\n把其中一个填进 .env 的 LLM_MODEL= 即可。`);
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
