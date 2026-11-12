import { judgeAnswer, scoresAgree } from "./judge.ts";
import { mapWithConcurrency } from "./concurrency.ts";
import type {
  EvalDataset,
  EvalQuestion,
  JudgeValidation,
} from "./schema.ts";
import type { LlmConfig } from "./llm.ts";

/**
 * judge 自检。
 *
 * 在用 judge 去评判任何 Agent 之前，先让它评判「人工写的参考答案」。
 * 如果 judge 连一份公认的优质答案都打不出人工给的水平，
 * 那它给 Agent 打的分就没有参考价值——这是整个评测体系的地基。
 */

export interface JudgeValidationDetail {
  questionId: string;
  judgeScore: number;
  humanScore: number;
  agrees: boolean;
  reason: string;
}

export interface JudgeValidationResult {
  summary: JudgeValidation;
  details: JudgeValidationDetail[];
}

/**
 * 自检失败的题。
 *
 * judge 正常打分是 1-5 分，所以分数是 0 只可能是这次请求没成功
 * （超时、限流、返回解析不了）。这些题不能算进一致率的分母——
 * 那是「没测出来」，不是「测出来不一致」。
 *
 * 但也不能就这么从统计里消失：一致率 100%（3 题）看着比 6 题里成功 3 题
 * 还要强，失败的那些题得让人看见。
 */
export function judgeFailures(
  details: JudgeValidationDetail[],
): JudgeValidationDetail[] {
  return details.filter((item) => item.judgeScore <= 0);
}

/** 把失败的题压成一行人话，给工作台的日志用。 */
export function describeJudgeFailures(
  details: JudgeValidationDetail[],
): string | null {
  const failed = judgeFailures(details);
  if (!failed.length) return null;
  const ids = failed.map((item) => item.questionId);
  const shown =
    ids.length > 8 ? `${ids.slice(0, 8).join("、")} 等 ${ids.length} 题` : ids.join("、");
  // 原因只留一句话：错误信息后面常跟着一大段响应体，日志里没人要看
  const reasons = [
    ...new Set(
      failed.map((item) =>
        item.reason.split("\n")[0].split(": ")[0].trim().slice(0, 40),
      ),
    ),
  ];
  return (
    `自检失败 ${failed.length} 题，没进一致率的分母` +
    `（${shown}：${reasons.join("；")}）`
  );
}

/**
 * 给自检结果补上失败计数。
 *
 * 早先存下来的缓存里没有这两个字段，从逐题明细里补出来，
 * 老报告重新用起来时失败题也不会被吞掉。
 */
export function withFailureCount(
  summary: JudgeValidation,
  details: JudgeValidationDetail[],
): JudgeValidation {
  return {
    ...summary,
    attempted: summary.attempted ?? details.length,
    failed: summary.failed ?? judgeFailures(details).length,
  };
}

export async function validateJudge(
  dataset: EvalDataset,
  llm: LlmConfig,
  options: {
    onProgress?: (done: number, total: number) => void;
    /**
     * 只自检前 N 道题。
     *
     * 命令行不传这个参数：尺子校准要看全量，
     * 少抽几题算出来的「一致率」撑不起结论。
     * 本地工作台的试跑会传——跑全量尺子校准等于白花几十次请求，
     * 用户明确说「只跑前几题」时，自检也应该跟着缩到同一批题里。
     */
    limit?: number;
    /**
     * 同时自检几道题。
     *
     * 自检也是一次模型请求一题，串行等下来最慢。
     * 调高之后总耗时接近「最慢的那道题」。
     */
    concurrency?: number;
  } = {},
): Promise<JudgeValidationResult> {
  const scope =
    options.limit && options.limit > 0
      ? dataset.questions.slice(0, options.limit)
      : dataset.questions;
  const questions = scope.filter(
    (question) => question.humanScore !== undefined,
  );

  const checkOne = async (
    question: EvalQuestion,
  ): Promise<JudgeValidationDetail> => {
    const context = question.reference.evidence
      .map(
        (evidence) =>
          `### ${evidence.file}:${evidence.startLine}-${evidence.endLine}\n（标准答案所依据的代码位置）`,
      )
      .join("\n\n");

    try {
      const judged = await judgeAnswer(
        llm,
        question,
        question.reference.answer,
        context,
      );
      return {
        questionId: question.id,
        judgeScore: judged.score,
        humanScore: question.humanScore!,
        agrees: scoresAgree(judged.score, question.humanScore!),
        reason: judged.reason,
      };
    } catch (error) {
      return {
        questionId: question.id,
        judgeScore: 0,
        humanScore: question.humanScore!,
        agrees: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
  let completed = 0;
  const details = await mapWithConcurrency(
    questions,
    concurrency,
    async (question) => {
      const detail = await checkOne(question);
      completed += 1;
      options.onProgress?.(completed, questions.length);
      return detail;
    },
  );

  const scored = details.filter((item) => item.judgeScore > 0);
  const failed = judgeFailures(details);
  const total = scored.length || 1;
  const summary: JudgeValidation = {
    sampled: scored.length,
    attempted: details.length,
    failed: failed.length,
    agreement:
      scored.filter((item) => item.agrees).length / total,
    meanJudgeScore:
      scored.reduce((sum, item) => sum + item.judgeScore, 0) / total,
    meanHumanScore:
      scored.reduce((sum, item) => sum + item.humanScore, 0) / total,
    exactAgreement:
      scored.filter((item) => item.judgeScore === item.humanScore).length / total,
    note: questions.length
      ? scored.length
        ? "judge 给人工参考答案打分，与人工评分相差不超过 1 分视为一致"
        : "judge 一次也没打上分，自检没做成"
      : "这次抽到的题里没有带人工评分的题，没法自检",
  };

  return { summary, details };
}
