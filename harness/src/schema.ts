/**
 * 评测集与运行结果的数据契约。
 * 站点直接消费 harness/out 产出的 JSON，因此这里是前后端唯一的真相来源。
 */

export type QuestionCategory =
  | "architecture"
  | "code-location"
  | "debugging"
  | "convention";

export type Difficulty = "easy" | "medium" | "hard";

export interface EvidenceRef {
  /** 相对仓库根目录的路径 */
  file: string;
  /** 1-based 行号区间，闭区间 */
  startLine: number;
  endLine: number;
  /** 该片段中最关键的符号名，用于核对引用是否指对了地方 */
  symbol?: string;
}

export interface EvalQuestion {
  id: string;
  question: string;
  category: QuestionCategory;
  difficulty: Difficulty;
  /** 人工撰写的标准答案，评测时作为 judge 的参照与人工评分的基准 */
  reference: {
    answer: string;
    /** 回答该问题必须引用到的位置 */
    evidence: EvidenceRef[];
    /** 标准答案中必须出现的关键词，judge 用于判断要点覆盖 */
    mustMention: string[];
  };
  /**
   * 人工给「参考答案」打的分（1-5）。
   * 注意：这里评的是人工写的标准答案本身，不是某个 Agent 的实际输出。
   * 它的用途是先校验 judge——如果 judge 连参考答案都打不出人工给的水平，
   * 那它给 Agent 打的分更不可信。
   */
  humanScore?: number;
}

export interface EvalDataset {
  id: string;
  /** 被评测的仓库标识 */
  repo: string;
  repoUrl?: string;
  language: string;
  createdAt: string;
  questions: EvalQuestion[];
}

/** 检索策略的实验变量 */
export interface ChunkingStrategy {
  /** 策略标识，同时作为报告中的实验组名 */
  id: string;
  label: string;
  kind: "fixed-window" | "function-level";
  /** fixed-window 策略的字符窗口大小 */
  windowSize?: number;
  /** fixed-window 策略的重叠字符数 */
  overlap?: number;
  /** function-level 策略下小于该行数的函数是否被并入相邻块 */
  minFunctionLines?: number;
}

export interface RetrievalConfig {
  topK: number;
  /** 是否对召回结果做二次重排 */
  rerank: boolean;
  /**
   * 重排方式。symbol-boost 在 BM25 之上叠加「问题里的标识符正好等于代码块符号名」的加权，
   * 用来回答「排序对不对」这件事；不开启时结果与纯 BM25 完全一致。
   */
  rerankMode?: "none" | "symbol-boost";
}

/** agent 提示词的版本。只有迭代阶梯会换提示词，横切分策略对比时必须固定。 */
export type PromptVersion = "base" | "cite-first";

/**
 * 评测台代码版本。
 *
 * 切分或检索的实现一旦改动，同一份配置跑出来的结果就不再相同。
 * 运行记录会带上这个版本号，复用旧记录前先比对它，
 * 避免把「改代码之前的结果」当成「改之后的结果」写进阶梯里。
 *
 * 改动 chunk.ts / retrieval.ts 的算法时必须手动 +1。
 */
export const CODE_VERSION = "2026-11-07.r2";

export interface Citation {
  file: string;
  startLine: number;
  endLine: number;
  /** 检索打分，仅用于调试与可解释性展示 */
  score: number;
}

export interface CaseResult {
  questionId: string;
  category: QuestionCategory;
  answer: string;
  citations: Citation[];
  /** LLM-as-judge 打的 1-5 分 */
  judgeScore: number;
  judgeReason: string;
  /** 命中的证据位置占应命中证据数量的比例 */
  evidenceRecall: number;
  latencyMs: number;
  tokens: {
    /** agent 的输入 token */
    prompt: number;
    /** agent 的输出 token */
    completion: number;
    /** 输入中命中服务商缓存的 token */
    cacheHit: number;
    /** 输入中未命中缓存的 token */
    cacheMiss: number;
    /** judge 的输入 token */
    judgePrompt: number;
    /** judge 的输出 token */
    judgeCompletion: number;
  };
  /** 本题的花费，包含 agent 与 judge 两次调用 */
  cost: number;
  /** 失败时的归因分类，供失败案例面板聚合 */
  failureKind?: "wrong-location" | "missing-detail" | "hallucination" | "timeout";
}

export interface RunSummary {
  /** 成功判定的阈值，judgeScore 达到该值即算任务成功 */
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
}

export interface EvalRun {
  runId: string;
  datasetId: string;
  repo: string;
  /** 实验组：chunking 策略 + 检索配置 */
  chunking: ChunkingStrategy;
  retrieval: RetrievalConfig;
  /** 这一轮用的 agent 提示词版本 */
  promptVersion: PromptVersion;
  /**
   * 产出这条记录的代码版本。
   *
   * 切分或检索的实现一改，同一份配置跑出来的结果就不一样了。
   * 复用旧运行记录前必须比对它，否则会把改代码之前的结果当成改之后的结果，
   * 阶梯的因果链就断了。
   */
  codeVersion: string;
  /** 这条运行记录的来源：横向策略对比，还是迭代阶梯的一轮 */
  origin?: "strategy-compare" | "ladder";
  /** 属于阶梯的哪一轮 */
  ladderStepId?: string;
  model: string;
  startedAt: string;
  finishedAt: string;
  summary: RunSummary;
  cases: CaseResult[];
}

/** 检索层单题结果。这层指标不需要 LLM，可以完全离线复现。 */
export interface RetrievalCase {
  questionId: string;
  question: string;
  category: QuestionCategory;
  difficulty: Difficulty;
  /** 标准答案要求引用的位置 */
  gold: EvidenceRef[];
  /** topK=6 时检索命中的位置 */
  citations: Citation[];
  recallAt1: number;
  recallAt3: number;
  recallAt6: number;
  /** 第一个命中证据的排名（1-based），未命中为 0 */
  firstHitRank: number;
}

/** 某个切分策略下的全部指标。 */
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
  /** 首个正确证据的平均倒数排名 */
  mrr: number;
  /** 送进 prompt 的上下文字符数，直接决定 token 成本 */
  avgContextChars: number;
  /** 生成层指标，只有跑通 LLM 的运行才会填充 */
  successRate?: number;
  avgJudgeScore?: number;
  avgLatencyMs?: number;
  p95LatencyMs?: number;
  avgCost?: number;
  totalCost?: number;
  totalTokens?: number;
  cases: RetrievalCase[];
}

/** judge 自检：让 judge 给人工写的参考答案打分，再和人工自己给的分数比较。 */
export interface JudgeValidation {
  /** 参与校验的题数 */
  sampled: number;
  /** judge 与人工相差不超过 1 分即视为一致 */
  agreement: number;
  /** judge 给参考答案的平均分 */
  meanJudgeScore: number;
  /** 人工给参考答案的平均分 */
  meanHumanScore: number;
  /** 完全同分的比例，比 ±1 更严格 */
  exactAgreement: number;
  note: string;
}

/**
 * 迭代阶梯的一轮。
 *
 * 与「切分策略对比」的区别：策略对比是同一时刻的横向快照，
 * 阶梯是时间序列——每一轮都继承上一轮的成果，只相对上一轮改一个变量，
 * 然后用完全相同的评测协议重跑一遍，看数字动了多少。
 */
export interface LadderStep {
  /** 轮次标识，如 v1 */
  id: string;
  /** 轮次标题，如「基准：固定窗口 800 字符」 */
  title: string;
  /** 这一轮相对上一轮改了什么 */
  change: string;
  /** 改这一处的预期是什么 */
  hypothesis: string;
  chunking: ChunkingStrategy;
  /** 这一轮的检索配置 */
  retrieval: RetrievalConfig;
  promptVersion: PromptVersion;
  model: string;
  /** 对应的生成层运行记录 */
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
  summary: RunSummary;
}

/** 一个数据集上的多次运行，用于横向对比 */
export interface ExperimentReport {
  datasetId: string;
  repo: string;
  /** 成本计价符号，随所选服务商而定（¥ / $） */
  costCurrency: string;
  /** LLM-as-judge 与人工标注的一致率，这是整个项目的信任基础 */
  judgeValidation: JudgeValidation;
  /** 检索层对比，恒不为空 */
  strategies: StrategyMetrics[];
  /** 横向策略对比的生成层运行记录，站点上的胜负矩阵用它 */
  runs: EvalRun[];
  /** 迭代阶梯每一轮的生成层运行记录，按轮次顺序 */
  ladderRuns: EvalRun[];
  /** 工具迭代阶梯，按时间顺序 */
  ladder: LadderStep[];
}
