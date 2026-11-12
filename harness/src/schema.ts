/**
 * 多项目对比中的一行：一个开源项目在同一套配置下的成绩。
 *
 * 回答的是「这套评测台换个仓库还灵不灵」。
 * 每个项目都必须用同一份配置（同一套切分、同一套检索、同一版提示词），
 * 否则横向的数字比的不是模型，是配置。
 */
export interface ProjectComparisonRow {
  /** 项目标识，如 flask */
  project: string;
  /** 展示名，如「Flask」 */
  label: string;
  /** 被测仓库标识 */
  repo: string;
  /** 仓库规模：文件数与总行数，说明这些项目并不一样大 */
  fileCount: number;
  repoLines: number;
  /** 题目数 */
  questions: number;
  /** 被测模型 id */
  model: string;
  /** 打分模型 id */
  judgeModel: string;
  chunking: ChunkingStrategy;
  retrieval: RetrievalConfig;
  promptVersion: PromptVersion;
  /** 成功率：judge 打分达到阈值的比例 */
  successRate: number;
  avgJudgeScore: number;
  /** 证据召回率：答案引用的位置里有多少是标准答案要求的 */
  avgEvidenceRecall: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  totalCost: number;
  totalTokens: number;
  /** 按题目类别分的成功情况 */
  byCategory: Record<string, { total: number; success: number }>;
  /**
   * 这把尺子在本项目的人工参考答案上的一致率。
   *
   * 尺子自己也会犯错：它给人工写的标准答案打的分如果和人工评分差得多，
   * 那它给 Agent 打的分就没什么参考价值。这个数字是整套对比的地基。
   */
  judgeValidation?: JudgeValidation;
  /** 检索层指标，这一层不花钱、结果完全可复现 */
  retrievalMetrics: {
    recallAt1: number;
    recallAt3: number;
    recallAt6: number;
    /** 按这一轮自己的预算算的召回率（topK=10 就是 recall@10） */
    recallAtBudget: number;
    mrr: number;
    avgContextChars: number;
    chunkCount: number;
  };
  /** 逐题得分，站上做项目间逐题对照 */
  caseScores: { questionId: string; judgeScore: number; evidenceRecall: number }[];
}

/**
 * 多项目对比。
 *
 * 四个项目共用一份配置跑同一把尺子，得到的横向快照。
 */
export interface MultiProjectComparison {
  /** 产出这组数字的评测台代码版本 */
  codeVersion: string;
  /** 共用配置来自阶梯的哪一轮，如 v7 */
  step: string;
  chunking: ChunkingStrategy;
  retrieval: RetrievalConfig;
  promptVersion: PromptVersion;
  /** 成功判定阈值 */
  successThreshold: number;
  rows: ProjectComparisonRow[];
  note: string;
}

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
   * structure-aware 在 symbol-boost 之上再加一层结构感知：文件路径里的词单独加权，
   * 问题里点名整条路径（如 flask/app.py）时精确命中。
   */
  rerankMode?: "none" | "symbol-boost" | "structure-aware";
  /**
   * 是否把问题里的中文术语展开成英文候选词再参与检索。
   * 中文提问 + 英文代码时，字面上没有交集的词只能靠这张术语表桥接。
   */
  queryExpansion?: boolean;
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
export const CODE_VERSION = "2026-11-07.r3";

/**
 * 每一版代码相对上一版改了什么。
 *
 * 站点展示「优化前后」时不能只摆两个数字，还要说清楚中间发生了什么，
 * 否则读者只知道分数变了，不知道是哪儿变了。
 * 这里写的是代码层面的事实（哪几个文件、哪种改动），不是结论。
 * 每一项描述的是「相对上一版」改了什么，所以版本号 +1 时要补上对应条目。
 */
export const CODE_CHANGES: Record<string, string[]> = {
  "2026-11-07.r3": [
    "切分（chunk.ts）：多行 def 签名不再被吞掉，函数块重新带上完整签名",
    "切分（chunk.ts）：类内部的空隙不再单独成块，块数从 730 降到 557",
    "检索（retrieval.ts）：重排从符号加权升级为结构感知，文件路径单独加权",
    "检索（bilingual.ts）：新增中英术语扩展，中文提问也能命中英文代码",
  ],
};

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
  /** 其中 judge 那一次打分的花费，agent 的花费 = cost - judgeCost */
  judgeCost?: number;
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
  /** 被测 Agent 用的模型 id。多模型对比时不同档案会留下不同的记录。 */
  model: string;
  /**
   * 评判用的模型 id。
   *
   * 默认跟被测模型是同一个；为了排除 judge 偏袒自己那家模型，
   * 可以用 --judge-model 指定别家的模型来打分。
   * 老记录没有这个字段，那时的 judge 就是被测模型本身。
   */
  judgeModel?: string;
  /** 被测模型所属的档案 id，如 deepseek / qwen / glm。站上展示的名字靠它。 */
  profile?: string;
  /** 档案的展示名，如「通义千问」。 */
  profileLabel?: string;
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
  /** 参与统计的题数——一致率的分母，只算 judge 成功打上分的那些 */
  sampled: number;
  /** 实际发起自检的题数（带人工评分的那些） */
  attempted?: number;
  /**
   * 自检失败的题数。
   *
   * 这些题 judge 没打上分（超时、限流、返回解析不了），
   * 既不贡献一致也不贡献不一致，从分母里剔掉了。
   * 不把它写出来，一致率就会看着比实际强。
   */
  failed?: number;
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

/**
 * 上一版评测台的对照快照。
 *
 * 站点要展示「优化前后」，手上就得同时有前后两组数字。
 * 前一组不靠记忆手写：把上一版报告里最好的那次横向对比运行原样搬过来，
 * 连同它那一版的检索层指标，这样两边量的是同一把尺子。
 */
export interface BaselineSnapshot {
  /** 基线来自哪一版代码 */
  codeVersion: string;
  /** 基线用的切分策略 */
  chunking: ChunkingStrategy;
  /** 基线用的模型 */
  model: string;
  /** 基线的生成层汇总 */
  summary: RunSummary;
  /** 基线的检索层指标 */
  retrievalMetrics: {
    recallAt1: number;
    recallAt3: number;
    recallAt6: number;
    mrr: number;
    avgContextChars: number;
    chunkCount: number;
  };
  /** 逐题结果，用于和当前版本做逐题对照 */
  cases: {
    questionId: string;
    category: QuestionCategory;
    judgeScore: number;
    evidenceRecall: number;
    failureKind?: CaseResult["failureKind"];
  }[];
}

/** 一个模型档案在某个 judge 手里拿到的成绩。 */
export interface ModelJudgeCell {
  judgeModel: string;
  judgeProfile: string;
  judgeProfileLabel: string;
  /** 这把尺子量出来的成功率 */
  successRate: number;
  /** 这把尺子量出来的平均分 */
  avgJudgeScore: number;
  /** 这一轮打分花的钱 */
  totalCost: number;
}

/** 多模型对比中的一行：一个被测模型在几把尺子下的成绩。 */
export interface ModelComparisonRow {
  agentModel: string;
  agentProfile: string;
  agentProfileLabel: string;
  runId: string;
  /** 是否复用了已有的运行记录 */
  reused: boolean;
  /** 每把尺子给这一行打的分 */
  cells: ModelJudgeCell[];
  /** 各尺子成功率的平均，作为排序用的主指标 */
  avgSuccessRate: number;
  avgJudgeScore: number;
  avgEvidenceRecall: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  /** agent 生成答案花的钱 */
  agentCost: number;
  /** 全部打分花的钱 */
  judgeCost: number;
  totalCost: number;
  totalTokens: number;
  /** 失败归因分布 */
  failureKinds: Record<string, number>;
  /** 逐题得分：每把尺子给这道题打了几分，一致率就是拿这些算的 */
  caseScores: { questionId: string; scores: Record<string, number> }[];
}

/** 两个 judge 在同一批答案上的一致程度。 */
export interface JudgeAgreement {
  agentModel: string;
  judgeA: string;
  judgeB: string;
  sampled: number;
  /** 分数相差不超过 1 分算一致 */
  agreement: number;
  /** 完全同分的比例 */
  exactAgreement: number;
  /** 成功判定被翻转的题数 */
  flips: number;
  judgeASuccessRate: number;
  judgeBSuccessRate: number;
}

/** 两把尺子在全部答案上的一致程度（跨模型汇总）。 */
export interface JudgePairAgreement {
  judgeA: string;
  judgeB: string;
  sampled: number;
  agreement: number;
  exactAgreement: number;
  flips: number;
  /** 两把尺子各自判出的成功率，换尺子会让这个数变成多少 */
  judgeASuccessRate: number;
  judgeBSuccessRate: number;
}

/** 一把尺子给本家模型打的分，比给别家模型的平均高多少。 */
export interface SelfPreference {
  judgeModel: string;
  judgeProfile: string;
  judgeProfileLabel: string;
  /** 本家的被测模型 */
  ownModel: string;
  ownAvgScore: number;
  otherAvgScore: number;
  /** 差值，大于 0 说明这把尺子偏袒自己那家 */
  gap: number;
  /** 本家模型在这把尺子下排第几，1 是最高分 */
  ownRank: number;
}

/**
 * 多模型对比：同一份配置下，不同被测模型的成绩。
 *
 * 回答的问题是「这把尺子能不能区分出模型的好坏」。
 * 每个模型都被同一批尺子量一遍，排名才有意义；
 * 再让第二把尺子量一次，看看换尺子会不会翻盘。
 */
export interface ModelComparison {
  /** 对比用的配置，和阶梯最后一轮一致 */
  chunking: ChunkingStrategy;
  retrieval: RetrievalConfig;
  promptVersion: PromptVersion;
  successThreshold: number;
  /** 打分模型，按列顺序排；第一把是主尺子 */
  judges: { model: string; profile: string; label: string }[];
  /** 主尺子：量所有被测模型的第一把尺子 */
  primaryJudge: string;
  rows: ModelComparisonRow[];
  /** 每个被测模型：主尺子与其余尺子两两一致 */
  agreements: JudgeAgreement[];
  /** 尺子两两在全部答案上的一致率 */
  agreementMatrix: JudgePairAgreement[];
  /** 自评偏袒：本家模型是否被自己家的尺子打高了 */
  selfPreference: SelfPreference[];
  note: string;
}

/**
 * AI 写的评语。
 *
 * 数字全部来自这次跑出来的结果，模型只负责把它们讲成人话；
 * 没有 AI 评语时站点回落到规则模板，两边都不会空着。
 */
export interface ReportNarrative {
  /** 迭代阶梯：每一轮改了什么、代价是多少 */
  ladder?: string;
  /** 切分策略横向对比 */
  strategies?: string;
  /** 多模型对比 */
  modelComparison?: string;
  /** 多项目对比 */
  multiProject?: string;
  /** 写这些评语的模型 id，站点要标出来 */
  model?: string;
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
  /** 上一版的对照快照，站点用它展示优化前后 */
  baseline?: BaselineSnapshot;
  /** 从基线版本到当前版本，代码层面改了什么 */
  changes?: string[];
  /** 多模型对比，站点用它展示这把尺子有没有区分度 */
  modelComparison?: ModelComparison;
  /** 多项目对比，站点用它展示这把尺子换个仓库还灵不灵 */
  multiProject?: MultiProjectComparison;
  /** AI 写的评语，站点优先用它，没有才用规则模板 */
  narrative?: ReportNarrative;
}
