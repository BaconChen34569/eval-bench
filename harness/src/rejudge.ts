import { chunkRepository } from "./chunk.ts";
import { loadRepository } from "./repository.ts";
import { buildIndex, search } from "./retrieval.ts";
import { judgeAnswer } from "./judge.ts";
import { classifyFailure, fileLineCounts } from "./failure.ts";
import { parseAnswerCitations } from "./agent.ts";
import { mapWithConcurrency } from "./concurrency.ts";
import { summarize } from "./runner.ts";
import { estimateCost, LlmError, type LlmConfig } from "./llm.ts";
import type {
  CaseResult,
  EvalDataset,
  EvalRun,
} from "./schema.ts";

export interface RejudgeOptions {
  /** 原来的运行记录：答案、引用、耗时、token 都用它 */
  run: EvalRun;
  dataset: EvalDataset;
  repoRoot: string;
  /** 被测模型。只用它给 agent 那部分 token 计价，不重新生成答案 */
  agentLlm: LlmConfig;
  /** 换谁来打分 */
  judgeLlm: LlmConfig;
  successThreshold: number;
  /** 同时换几道题的判。1 = 一题一题重打。 */
  concurrency?: number;
  /** 撞上服务商限流时把这一题重打一遍 */
  retryRateLimited?: boolean;
  onProgress?: (done: number, total: number, message: string) => void;
}

/**
 * 换一个 judge 给同一批答案重新打分。
 *
 * 答案一个字都不动，只换打分的人。这样两个 judge 的分数差
 * 就是这把尺子的误差——尤其是 judge 给自己家模型打分时可能偏松，
 * 换一把尺子量一遍才知道偏了多少。
 *
 * 检索是确定性的，同一份配置重跑一次拿到的代码块和当初一样，
 * 所以 judge 看到的上下文和第一遍完全一致。
 */
export async function rejudgeRun(options: RejudgeOptions): Promise<EvalRun> {
  const { run, dataset, repoRoot, agentLlm, judgeLlm, successThreshold } =
    options;

  const files = await loadRepository(repoRoot);
  const lineCounts = fileLineCounts(files);
  const chunks = chunkRepository(files, run.chunking);
  const index = buildIndex(chunks);

  const rejudgeOne = async (
    original: CaseResult,
  ): Promise<{ result: CaseResult; message: string }> => {
    const question = dataset.questions.find(
      (item) => item.id === original.questionId,
    );
    if (!question) {
      throw new Error(`题集里没有 ${original.questionId} 这一题`);
    }

    const hits = search(index, question.question, run.retrieval.topK, {
      rerankMode: run.retrieval.rerankMode,
      queryExpansion: run.retrieval.queryExpansion,
    });
    const context = hits
      .map((hit) => hit.chunk)
      .map(
        (chunk) =>
          `### ${chunk.file}:${chunk.startLine}-${chunk.endLine}\n${chunk.text}`,
      )
      .join("\n\n");

    let judged;
    const maxAttempts = options.retryRateLimited ? 3 : 1;
    for (let attempt = 1; ; attempt += 1) {
      try {
        judged = await judgeAnswer(
          judgeLlm,
          question,
          original.answer,
          context,
        );
        break;
      } catch (error) {
        const limited = error instanceof LlmError && error.status === 429;
        // 限流是额度问题，不是这一题的问题：降过并发再打一次。
        if (limited && attempt < maxAttempts) continue;
        // 换 judge 之后这道题打不了分，不改原来的分数，也不改失败归因
        return {
          result: original,
          message: limited
            ? `${original.questionId} 换 judge 失败：服务商限流，没打上分`
            : `${original.questionId} 换 judge 失败：${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    // agent 那次调用的花费不变，只有打分这笔账换了人。
    const agentCost = estimateCost(
      {
        prompt: original.tokens.prompt,
        completion: original.tokens.completion,
        cacheHit: original.tokens.cacheHit,
        cacheMiss: original.tokens.cacheMiss,
      },
      agentLlm.pricePerMillion,
    );
    const judgeCost = estimateCost(judged.tokens, judgeLlm.pricePerMillion);

    return {
      result: {
        ...original,
        judgeScore: judged.score,
        judgeReason: judged.reason,
        tokens: {
          ...original.tokens,
          judgePrompt: judged.tokens.prompt,
          judgeCompletion: judged.tokens.completion,
        },
        cost: agentCost + judgeCost,
        judgeCost,
        failureKind: classifyFailure(
          {
            answerCitations: parseAnswerCitations(original.answer),
            evidenceRecall: original.evidenceRecall,
            judgeScore: judged.score,
            successThreshold,
          },
          lineCounts,
        ),
      },
      message: `${original.questionId} → judge ${judged.score}/5`,
    };
  };

  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
  let completed = 0;
  const cases = await mapWithConcurrency(
    run.cases,
    concurrency,
    async (original) => {
      const { result, message } = await rejudgeOne(original);
      completed += 1;
      options.onProgress?.(completed, run.cases.length, message);
      return result;
    },
  );

  return {
    ...run,
    runId: `${run.runId}-rejudged-${judgeLlm.model}`,
    judgeModel: judgeLlm.model,
    summary: summarize(cases, successThreshold),
    cases,
  };
}
