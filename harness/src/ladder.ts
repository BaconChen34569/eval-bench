import { chunkRepository, type CodeFile } from "./chunk.ts";
import { loadRepository } from "./repository.ts";
import {
  buildIndex,
  evidenceRecall,
  search,
  toCitations,
} from "./retrieval.ts";
import { runEvaluation } from "./runner.ts";
import type { LlmConfig } from "./llm.ts";
import { CODE_VERSION } from "./schema.ts";
import type {
  ChunkingStrategy,
  EvalDataset,
  EvalRun,
  LadderStep,
  PromptVersion,
  RetrievalConfig,
} from "./schema.ts";

/**
 * 迭代阶梯：工具自身被一轮轮改好，每轮的评测协议完全一致。
 *
 * 和「切分策略对比」的区别在于：
 * - 策略对比是同一时刻的三组快照，回答「哪种切法更好」；
 * - 阶梯是时间序列，每一轮继承上一轮，只相对上一轮改一个变量，
 *   回答「我们是怎么一步步把成功率推上去的，中间的收益来自哪一层」。
 *
 * 协议锁死：同一批题、同一个模型、同一套 judge、同一成功线（>=4 分）。
 * judge 提示词在整个阶梯里一次都不改——改了，轮与轮之间的分数就没法比。
 */

export interface LadderConfig {
  id: string;
  title: string;
  /** 这一轮相对上一轮改了什么 */
  change: string;
  /** 预期什么会变 */
  hypothesis: string;
  chunking: ChunkingStrategy;
  retrieval: RetrievalConfig;
  promptVersion: PromptVersion;
}

const FIXED_800: ChunkingStrategy = {
  id: "fixed-800",
  label: "固定窗口 800 字符",
  kind: "fixed-window",
  windowSize: 800,
  overlap: 120,
};

const FUNCTION_LEVEL: ChunkingStrategy = {
  id: "function-level",
  label: "函数级切分",
  kind: "function-level",
  minFunctionLines: 3,
};

const TOP6: RetrievalConfig = { topK: 6, rerank: false, rerankMode: "none" };
const TOP6_RERANK: RetrievalConfig = {
  topK: 6,
  rerank: true,
  rerankMode: "symbol-boost",
};
const TOP10_RERANK: RetrievalConfig = {
  topK: 10,
  rerank: true,
  rerankMode: "symbol-boost",
};
const TOP10_RERANK_EXPAND: RetrievalConfig = {
  topK: 10,
  rerank: true,
  rerankMode: "symbol-boost",
  queryExpansion: true,
};
const TOP10_STRUCTURE_EXPAND: RetrievalConfig = {
  topK: 10,
  rerank: true,
  rerankMode: "structure-aware",
  queryExpansion: true,
};

export const LADDER: LadderConfig[] = [
  {
    id: "v1",
    title: "基准：固定窗口 800 字符",
    change: "起点。固定窗口切分 + 纯 BM25 top-6 + 基准提示词",
    hypothesis: "窗口切分会把函数腰斩，证据召不回来，模型只能靠猜",
    chunking: FIXED_800,
    retrieval: TOP6,
    promptVersion: "base",
  },
  {
    id: "v2",
    title: "换切分：按函数边界切",
    change: "只改切分方式：固定窗口 800 字符 → 函数级切分",
    hypothesis: "完整函数不再被切断，recall@1 应该先涨起来",
    chunking: FUNCTION_LEVEL,
    retrieval: TOP6,
    promptVersion: "base",
  },
  {
    id: "v3",
    title: "加重排：符号名优先",
    change: "只改检索排序：纯 BM25 → BM25 + 符号名加权",
    hypothesis: "问题里的标识符能对上函数名时，该块应该排到第一",
    chunking: FUNCTION_LEVEL,
    retrieval: TOP6_RERANK,
    promptVersion: "base",
  },
  {
    id: "v4",
    title: "改提示词：先列依据再作答",
    change: "只改 agent 提示词：先列依据位置，再据此作答",
    hypothesis: "把定位和作答拆成两步，「定位错了」这类失败应该下降",
    chunking: FUNCTION_LEVEL,
    retrieval: TOP6_RERANK,
    promptVersion: "cite-first",
  },
  {
    id: "v5",
    title: "放宽预算：top-6 → top-10",
    change: "只改检索预算：送进 prompt 的代码块从 6 个提到 10 个",
    hypothesis: "recall@6 是天花板，放宽预算能再捞回一点，但上下文和成本会跟着涨",
    chunking: FUNCTION_LEVEL,
    retrieval: TOP10_RERANK,
    promptVersion: "cite-first",
  },
  {
    id: "v6",
    title: "补术语桥：中文问题展开成英文候选词",
    change: "只改查询构造：问题里的中文术语展开成英文候选词一起参与打分",
    hypothesis: "中文提问、英文代码时字面上没有交集，扩展出的候选词能救回一批定位失败",
    chunking: FUNCTION_LEVEL,
    retrieval: TOP10_RERANK_EXPAND,
    promptVersion: "cite-first",
  },
  {
    id: "v7",
    title: "加结构感知：路径单独加权",
    change: "只改重排方式：符号加权 → 结构感知（路径加权 + 整条路径精确命中）",
    hypothesis: "问题里点名模块时，让该模块的代码块排到前面",
    chunking: FUNCTION_LEVEL,
    retrieval: TOP10_STRUCTURE_EXPAND,
    promptVersion: "cite-first",
  },
];

function overlaps(
  file: string,
  startLine: number,
  endLine: number,
  expected: { file: string; startLine: number; endLine: number },
): boolean {
  return (
    file === expected.file &&
    startLine <= expected.endLine &&
    endLine >= expected.startLine
  );
}

export interface RetrievalMeasurement {
  recallAt1: number;
  recallAt3: number;
  recallAt6: number;
  /** 按这一轮自己的预算算的召回率（topK=10 的轮次就是 recall@10） */
  recallAtBudget: number;
  mrr: number;
  avgContextChars: number;
  chunkCount: number;
}

/**
 * 检索层测量：不调用任何模型，所以每一轮的检索指标都是免费且完全可复现的。
 * 阶梯的说服力来自「检索层涨了 → 生成层跟着涨」这条因果链能对上。
 */
export function measureRetrieval(
  files: CodeFile[],
  dataset: EvalDataset,
  chunking: ChunkingStrategy,
  retrieval: RetrievalConfig,
): RetrievalMeasurement {
  const chunks = chunkRepository(files, chunking);
  const index = buildIndex(chunks);
  const maxK = Math.max(6, retrieval.topK);

  let sum1 = 0;
  let sum3 = 0;
  let sum6 = 0;
  let sumBudget = 0;
  let sumMrr = 0;
  let contextChars = 0;

  for (const question of dataset.questions) {
    const hits = search(index, question.question, maxK, {
      rerankMode: retrieval.rerankMode,
      queryExpansion: retrieval.queryExpansion,
    });
    const citations = toCitations(hits);
    const gold = question.reference.evidence;

    sum1 += evidenceRecall(citations.slice(0, 1), gold);
    sum3 += evidenceRecall(citations.slice(0, 3), gold);
    sum6 += evidenceRecall(citations.slice(0, 6), gold);
    sumBudget += evidenceRecall(citations.slice(0, retrieval.topK), gold);

    let firstHitRank = 0;
    for (const [position, hit] of hits.entries()) {
      const matched = gold.some((expected) =>
        overlaps(hit.chunk.file, hit.chunk.startLine, hit.chunk.endLine, expected),
      );
      if (matched) {
        firstHitRank = position + 1;
        break;
      }
    }
    sumMrr += firstHitRank > 0 ? 1 / firstHitRank : 0;

    contextChars += hits
      .slice(0, retrieval.topK)
      .reduce((sum, hit) => sum + hit.chunk.text.length, 0);
  }

  const count = dataset.questions.length || 1;
  return {
    recallAt1: sum1 / count,
    recallAt3: sum3 / count,
    recallAt6: sum6 / count,
    recallAtBudget: sumBudget / count,
    mrr: sumMrr / count,
    avgContextChars: contextChars / count,
    chunkCount: chunks.length,
  };
}

/**
 * 两轮配置是否等价，用来复用已经跑过的运行记录。
 *
 * 必须同时比对 codeVersion：切分实现改过之后，同一个 chunking.id 跑出来的
 * 已经是另一份结果了，只看配置会把改代码之前的结果混进新的阶梯里。
 */
function sameConfig(
  run: EvalRun,
  step: LadderConfig,
  expectedCases: number,
): boolean {
  return (
    run.codeVersion === CODE_VERSION &&
    run.cases.length === expectedCases &&
    run.chunking.id === step.chunking.id &&
    run.retrieval.topK === step.retrieval.topK &&
    (run.retrieval.rerankMode ?? "none") === (step.retrieval.rerankMode ?? "none") &&
    (run.retrieval.queryExpansion ?? false) === (step.retrieval.queryExpansion ?? false) &&
    (run.promptVersion ?? "base") === step.promptVersion
  );
}

/**
 * 这条运行记录能不能在当前这轮直接复用。
 *
 * 除了配置一致，还得是同一个模型跑的：换模型就是换被测对象，
 * 把上一个模型的记录当成这个模型的结果，等于什么都没测。
 * judge 同理——换了打分模型，分数不在同一把尺子上，不能复用。
 *
 * 老记录没有 judgeModel 字段，那时 judge 就是被测模型本身。
 */
export function reusableForStep(
  run: EvalRun,
  step: LadderConfig,
  expectedCases: number,
  models: { agent: string; judge: string },
): boolean {
  const runJudge = run.judgeModel ?? run.model;
  return (
    sameConfig(run, step, expectedCases) &&
    run.model === models.agent &&
    runJudge === models.judge
  );
}

export interface LadderOptions {
  dataset: EvalDataset;
  repoRoot: string;
  llm: LlmConfig;
  /** 打分的模型，不给就用被测模型自己打分 */
  judgeLlm?: LlmConfig;
  successThreshold: number;
  /** 已有的运行记录，配置一致的轮次直接复用，不再花钱重跑 */
  reuseRuns?: EvalRun[];
  limit?: number;
  onProgress?: (step: LadderConfig, done: number, total: number, message: string) => void;
}

export interface LadderResult {
  steps: LadderStep[];
  runs: EvalRun[];
}

export async function runLadder(options: LadderOptions): Promise<LadderResult> {
  const files = await loadRepository(options.repoRoot);
  const steps: LadderStep[] = [];
  const runs: EvalRun[] = [];
  const judgeLlm = options.judgeLlm ?? options.llm;
  const models = { agent: options.llm.model, judge: judgeLlm.model };

  for (const [position, step] of LADDER.entries()) {
    const measurement = measureRetrieval(
      files,
      options.dataset,
      step.chunking,
      step.retrieval,
    );

    const reusable = options.reuseRuns?.find((run) =>
      reusableForStep(run, step, options.dataset.questions.length, models),
    );
    let run: EvalRun;

    if (reusable) {
      run = reusable;
      options.onProgress?.(
        step,
        position + 1,
        LADDER.length,
        `${step.id} 复用已有运行 ${reusable.runId}`,
      );
    } else {
      const started = Date.now();
      run = await runEvaluation({
        dataset: options.dataset,
        repoRoot: options.repoRoot,
        chunking: step.chunking,
        retrieval: step.retrieval,
        llm: options.llm,
        judgeLlm,
        successThreshold: options.successThreshold,
        runId: `ladder-${step.id}-${started}`,
        promptVersion: step.promptVersion,
        limit: options.limit,
        onProgress: (done, total, message) =>
          options.onProgress?.(
            step,
            position + 1,
            LADDER.length,
            `${step.id} (${done}/${total}) ${message}`,
          ),
      });
      run.origin = "ladder";
      run.ladderStepId = step.id;
    }

    runs.push(run);
    steps.push({
      id: step.id,
      title: step.title,
      change: step.change,
      hypothesis: step.hypothesis,
      chunking: step.chunking,
      retrieval: step.retrieval,
      promptVersion: step.promptVersion,
      model: run.model,
      runId: run.runId,
      retrievalMetrics: {
        recallAt1: measurement.recallAt1,
        recallAt3: measurement.recallAt3,
        recallAt6: measurement.recallAt6,
        recallAtBudget: measurement.recallAtBudget,
        mrr: measurement.mrr,
        avgContextChars: measurement.avgContextChars,
        chunkCount: measurement.chunkCount,
      },
      summary: run.summary,
    });
  }

  return { steps, runs };
}
