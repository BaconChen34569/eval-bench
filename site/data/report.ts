import raw from "./report.json";

/**
 * 站点消费的数据契约与 harness/src/schema.ts 一一对应。
 * report.json 由 `node --experimental-strip-types src/cli.ts experiment ...` 产出，
 * 每次跑评测后覆盖本目录下的 report.json 即可刷新站点数据。
 */

export type QuestionCategory =
  | "architecture"
  | "code-location"
  | "debugging"
  | "convention";

export type Difficulty = "easy" | "medium" | "hard";

export interface EvidenceRef {
  file: string;
  startLine: number;
  endLine: number;
  symbol?: string;
}

export interface Citation {
  file: string;
  startLine: number;
  endLine: number;
  score: number;
}

export interface ChunkingStrategy {
  id: string;
  label: string;
  kind: "fixed-window" | "function-level";
  windowSize?: number;
  overlap?: number;
  minFunctionLines?: number;
}

export interface RetrievalCase {
  questionId: string;
  question: string;
  category: QuestionCategory;
  difficulty: Difficulty;
  gold: EvidenceRef[];
  citations: Citation[];
  recallAt1: number;
  recallAt3: number;
  recallAt6: number;
  firstHitRank: number;
}

export interface StrategyMetrics {
  strategy: ChunkingStrategy;
  fileCount: number;
  totalRepoLines: number;
  chunkCount: number;
  avgChunkChars: number;
  indexBuildMs: number;
  recallAt1: number;
  recallAt3: number;
  recallAt6: number;
  mrr: number;
  avgContextChars: number;
  successRate?: number;
  avgJudgeScore?: number;
  avgLatencyMs?: number;
  p95LatencyMs?: number;
  avgCost?: number;
  totalCost?: number;
  totalTokens?: number;
  cases: RetrievalCase[];
}

/** judge 自检：judge 给人工参考答案打分，和人工评分比较。 */
export interface JudgeValidation {
  sampled: number;
  agreement: number;
  meanJudgeScore: number;
  meanHumanScore: number;
  exactAgreement: number;
  note: string;
}

/** 生成层单题结果。 */
export interface RunCase {
  questionId: string;
  category: QuestionCategory;
  /** 模型给出的原始回答 */
  answer: string;
  /** judge 写的判语，说明扣分在哪 */
  judgeReason: string;
  judgeScore: number;
  evidenceRecall: number;
  latencyMs: number;
  cost: number;
  /** 一次调用的 token 构成：prompt 是未命中缓存的输入，cacheHit 是命中缓存的输入 */
  tokens: {
    prompt: number;
    completion: number;
    cacheHit: number;
    cacheMiss: number;
    judgePrompt: number;
    judgeCompletion: number;
  };
  failureKind?: "wrong-location" | "missing-detail" | "hallucination" | "timeout";
}

export interface EvalRun {
  runId: string;
  model: string;
  startedAt: string;
  finishedAt: string;
  chunking: ChunkingStrategy;
  /** 这次运行属于横向策略对比，还是迭代阶梯的一轮 */
  origin?: "strategy-compare" | "ladder";
  /** 属于阶梯的哪一轮 */
  ladderStepId?: string;
  summary: {
    successThreshold: number;
    successRate: number;
    avgJudgeScore: number;
    avgEvidenceRecall: number;
    avgLatencyMs: number;
    p95LatencyMs: number;
    avgCost: number;
    totalCost: number;
    totalTokens: number;
    byCategory: Record<string, { total: number; success: number }>;
  };
  cases: RunCase[];
}

/** 迭代阶梯的一轮：每轮相对上一轮只改一个变量。 */
export interface LadderStep {
  id: string;
  title: string;
  /** 这一轮相对上一轮改了什么 */
  change: string;
  /** 改这一处的预期是什么 */
  hypothesis: string;
  chunking: ChunkingStrategy;
  retrieval: {
    topK: number;
    rerank: boolean;
    rerankMode?: "none" | "symbol-boost";
  };
  promptVersion: "base" | "cite-first";
  model: string;
  runId: string;
  /** 检索层指标，这一层不花钱、结果完全可复现 */
  retrievalMetrics: {
    recallAt1: number;
    recallAt3: number;
    recallAt6: number;
    /** 按这一轮自己的预算算的召回率（topK=10 的轮次就是 recall@10） */
    recallAtBudget: number;
    mrr: number;
    avgContextChars: number;
    chunkCount: number;
  };
  summary: EvalRun["summary"];
}

export interface ExperimentReport {
  datasetId: string;
  repo: string;
  costCurrency: string;
  judgeValidation: JudgeValidation;
  strategies: StrategyMetrics[];
  /** 横向策略对比的生成层运行记录 */
  runs: EvalRun[];
  /** 迭代阶梯每一轮的生成层运行记录 */
  ladderRuns: EvalRun[];
  /** 工具迭代阶梯，按时间顺序 */
  ladder: LadderStep[];
}

export const report = raw as unknown as ExperimentReport;

/**
 * 迭代阶梯的每一轮。
 *
 * 阶梯和横向策略对比的区别：策略对比是同一时刻的三组快照，
 * 阶梯是时间序列——每一轮继承上一轮，只相对上一轮改一个变量，
 * 然后用完全相同的协议重跑一遍。
 */
export const ladder = [...(report.ladder ?? [])];

/** 阶梯每一轮的运行记录，按轮次顺序。 */
export const ladderRuns = [...(report.ladderRuns ?? [])];

/** 某轮阶梯对应的运行记录。 */
export function ladderRun(stepId: string): EvalRun | undefined {
  const step = ladder.find((item) => item.id === stepId);
  if (!step) return undefined;
  return ladderRuns.find((run) => run.runId === step.runId);
}

export const CATEGORY_LABEL: Record<QuestionCategory, string> = {
  architecture: "架构",
  "code-location": "定位",
  debugging: "排障",
  convention: "约定",
};

export const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  easy: "易",
  medium: "中",
  hard: "难",
};

export const STRATEGY_ORDER = ["fixed-800", "fixed-400", "function-level"];

/** 生成层运行记录，按策略顺序排好。 */
export const runs = [...report.runs].sort(
  (a, b) =>
    STRATEGY_ORDER.indexOf(a.chunking.id) -
    STRATEGY_ORDER.indexOf(b.chunking.id),
);

export const FAILURE_LABEL: Record<NonNullable<RunCase["failureKind"]>, string> = {
  "wrong-location": "定位错了",
  "missing-detail": "要点漏了",
  hallucination: "编造内容",
  timeout: "调用失败",
};

export const strategies = [...report.strategies].sort(
  (a, b) =>
    STRATEGY_ORDER.indexOf(a.strategy.id) - STRATEGY_ORDER.indexOf(b.strategy.id),
);

/** 全部题目去重后按题号排序，三种策略共用同一份题目列表。 */
export const questions = (() => {
  const map = new Map<string, RetrievalCase>();
  for (const strategy of strategies) {
    for (const item of strategy.cases) {
      if (!map.has(item.questionId)) map.set(item.questionId, item);
    }
  }
  return [...map.values()].sort((a, b) =>
    a.questionId.localeCompare(b.questionId, undefined, { numeric: true }),
  );
})();

export function strategyById(id: string): StrategyMetrics | undefined {
  return strategies.find((item) => item.strategy.id === id);
}

/** 某道题在某个策略下的生成层结果。 */
export function runCase(
  runId: string,
  questionId: string,
): RunCase | undefined {
  return runs
    .find((run) => run.runId === runId)
    ?.cases.find((item) => item.questionId === questionId);
}

/** 成功率最高的策略，作为逐题视图的默认展示对象。 */
export const bestRun = [...runs].sort(
  (a, b) => b.summary.successRate - a.summary.successRate,
)[0];

/** 某条证据是否被检索命中：文件相同且行号区间有交集。 */
export function citationHits(
  citation: Citation,
  evidence: EvidenceRef,
): boolean {
  return (
    citation.file === evidence.file &&
    citation.startLine <= evidence.endLine &&
    citation.endLine >= evidence.startLine
  );
}

export function formatPercent(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatNumber(value: number, digits = 0): string {
  return value.toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/**
 * 成本折算用的单价，和 harness/.env 里配的一致：
 * DeepSeek deepseek-flash 闲时价（每百万 token，单位元）。
 */
export const PRICE = {
  prompt: 1,
  completion: 4,
  cacheHit: 0.02,
} as const;

export interface CostBreakdown {
  /** agent 调用：命中缓存的输入 */
  agentCacheHitTokens: number;
  /** agent 调用：未命中缓存的输入 */
  agentCacheMissTokens: number;
  /** agent 调用：输出 */
  agentCompletionTokens: number;
  agentCost: number;
  /** judge 调用：输入（缓存命中数由总成本倒推，见 breakdownCost） */
  judgePromptTokens: number;
  judgeCompletionTokens: number;
  judgeCacheHitTokens: number;
  judgeCacheMissTokens: number;
  judgeCost: number;
  total: number;
}

/**
 * 把单题成本拆开：agent 和 judge 两次调用分别统计。
 * 报告里只记了 agent 那次调用的缓存命中数，judge 那次没记，
 * 所以用总成本倒推——judge 的输入成本里缓存命中部分按 0.02 元/百万 token 计，
 * 由此解出 judge 命中了多少 token（结果是非负整数，能自检）。
 */
export function breakdownCost(entry: RunCase): CostBreakdown {
  const tokens = entry.tokens;
  const agentCacheHitTokens = tokens.cacheHit;
  const agentCacheMissTokens = tokens.cacheMiss || tokens.prompt;
  const agentCompletionTokens = tokens.completion;

  const agentCacheHitCost = (agentCacheHitTokens / 1_000_000) * PRICE.cacheHit;
  const agentCacheMissCost =
    (agentCacheMissTokens / 1_000_000) * PRICE.prompt;
  const agentCompletionCost =
    (agentCompletionTokens / 1_000_000) * PRICE.completion;
  const agentCost =
    agentCacheHitCost + agentCacheMissCost + agentCompletionCost;

  const judgeCompletionTokens = tokens.judgeCompletion;
  const judgePromptTokens = tokens.judgePrompt;
  const judgeCompletionCost =
    (judgeCompletionTokens / 1_000_000) * PRICE.completion;

  const judgeCost = entry.cost - agentCost;
  const judgeInputCost = judgeCost - judgeCompletionCost;
  // judgePrompt = 命中 + 未命中；命中按 0.02、未命中按 1 计。
  const judgeMissTokens =
    (judgeInputCost * 1_000_000 - PRICE.cacheHit * judgePromptTokens) /
    (PRICE.prompt - PRICE.cacheHit);
  const judgeCacheHitTokens = judgePromptTokens - judgeMissTokens;

  return {
    agentCacheHitTokens,
    agentCacheMissTokens,
    agentCompletionTokens,
    agentCost,
    judgePromptTokens,
    judgeCompletionTokens,
    judgeCacheHitTokens: Math.max(0, Math.round(judgeCacheHitTokens)),
    judgeCacheMissTokens: Math.max(0, Math.round(judgeMissTokens)),
    judgeCost,
    total: entry.cost,
  };
}

/** 某个策略下所有题目的 token 与成本汇总。 */
export function summarizeRun(run: EvalRun) {
  const sums = run.cases.reduce(
    (acc, entry) => {
      const b = breakdownCost(entry);
      acc.agentCacheHitTokens += b.agentCacheHitTokens;
      acc.agentCacheMissTokens += b.agentCacheMissTokens;
      acc.agentCompletionTokens += b.agentCompletionTokens;
      acc.agentCost += b.agentCost;
      acc.judgePromptTokens += b.judgePromptTokens;
      acc.judgeCompletionTokens += b.judgeCompletionTokens;
      acc.judgeCacheHitTokens += b.judgeCacheHitTokens;
      acc.judgeCacheMissTokens += b.judgeCacheMissTokens;
      acc.judgeCost += b.judgeCost;
      return acc;
    },
    {
      agentCacheHitTokens: 0,
      agentCacheMissTokens: 0,
      agentCompletionTokens: 0,
      agentCost: 0,
      judgePromptTokens: 0,
      judgeCompletionTokens: 0,
      judgeCacheHitTokens: 0,
      judgeCacheMissTokens: 0,
      judgeCost: 0,
    },
  );

  return {
    ...sums,
    totalTokens:
      sums.agentCacheHitTokens +
      sums.agentCacheMissTokens +
      sums.agentCompletionTokens +
      sums.judgePromptTokens +
      sums.judgeCompletionTokens,
    totalCost: sums.agentCost + sums.judgeCost,
  };
}
