import { judgeAnswer, scoresAgree } from "./judge.ts";
import type { EvalDataset, JudgeValidation } from "./schema.ts";
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
  } = {},
): Promise<JudgeValidationResult> {
  const scope =
    options.limit && options.limit > 0
      ? dataset.questions.slice(0, options.limit)
      : dataset.questions;
  const questions = scope.filter(
    (question) => question.humanScore !== undefined,
  );
  const details: JudgeValidationDetail[] = [];

  for (const [index, question] of questions.entries()) {
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
      details.push({
        questionId: question.id,
        judgeScore: judged.score,
        humanScore: question.humanScore!,
        agrees: scoresAgree(judged.score, question.humanScore!),
        reason: judged.reason,
      });
    } catch (error) {
      details.push({
        questionId: question.id,
        judgeScore: 0,
        humanScore: question.humanScore!,
        agrees: false,
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    options.onProgress?.(index + 1, questions.length);
  }

  const scored = details.filter((item) => item.judgeScore > 0);
  const total = scored.length || 1;
  const summary: JudgeValidation = {
    sampled: scored.length,
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
