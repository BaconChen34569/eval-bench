import { chat, type ChatMessage, type LlmConfig, type TokenUsage } from "./llm.ts";
import type { EvalQuestion } from "./schema.ts";

/**
 * LLM-as-judge：让模型按标准答案给 agent 的回答打分。
 *
 * 这个环节最大的风险是 judge 本身不可信——它一旦系统性偏松，
 * 后面所有对比实验的结论都会跟着偏。所以必须同时做一件事：
 * 拿一部分题让人工也打分，报告两者的一致率。一致率是整套方法的可信度底座，
 * 也是这个项目相对于「我做了个 agent」的最主要区别。
 */

export interface JudgeResult {
  score: number;
  reason: string;
  /** 命中的要点 */
  hitPoints: string[];
  /** 遗漏的要点 */
  missedPoints: string[];
  /** judge 这一轮调用的 token 用量，评测 judge 本身也要算钱 */
  tokens: TokenUsage;
}

const JUDGE_SYSTEM = `你是一名严格的代码问答评测员。你会看到：
1. 一个关于代码仓库的问题
2. 标准答案及其必须覆盖的要点
3. 被评测系统的回答及其引用的代码片段

请按以下标准打分（1-5 分）：
5 分：回答准确覆盖了全部要点，引用的代码位置正确，可以直接用来解决问题
4 分：覆盖了大部分要点，有轻微遗漏或措辞不精确，不影响使用
3 分：覆盖了一半左右要点，有明显遗漏但方向正确
2 分：只覆盖少数要点或存在事实性错误
1 分：答非所问、与代码无关，或完全错误

只输出 JSON，不要任何解释文字。格式：
{"score": 数字, "reason": "一句话理由", "hitPoints": ["命中的要点"], "missedPoints": ["遗漏的要点"]}`;

export function buildJudgeMessages(
  question: EvalQuestion,
  answer: string,
  context: string,
): ChatMessage[] {
  return [
    { role: "system", content: JUDGE_SYSTEM },
    {
      role: "user",
      content: `## 问题
${question.question}

## 标准答案
${question.reference.answer}

## 必须覆盖的要点
${question.reference.mustMention.map((point) => `- ${point}`).join("\n")}

## 应当引用的代码位置
${question.reference.evidence
  .map((e) => `- ${e.file}:${e.startLine}-${e.endLine}${e.symbol ? ` (${e.symbol})` : ""}`)
  .join("\n")}

## 被评测系统的回答
${answer}

## 它引用的代码片段
${context}`,
    },
  ];
}

/** 模型偶尔会输出带 markdown 包裹的 JSON，这里做一次容错解析。 */
function parseJudgeOutput(raw: string): Omit<JudgeResult, "tokens"> | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;

  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1)) as {
      score?: number;
      reason?: string;
      hitPoints?: string[];
      missedPoints?: string[];
    };
    const score = Number(parsed.score);
    if (!Number.isFinite(score)) return null;
    return {
      score: Math.min(5, Math.max(1, Math.round(score))),
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
      hitPoints: Array.isArray(parsed.hitPoints) ? parsed.hitPoints : [],
      missedPoints: Array.isArray(parsed.missedPoints) ? parsed.missedPoints : [],
    };
  } catch {
    return null;
  }
}

export async function judgeAnswer(
  config: LlmConfig,
  question: EvalQuestion,
  answer: string,
  context: string,
): Promise<JudgeResult> {
  const completion = await chat(
    config,
    buildJudgeMessages(question, answer, context),
  );
  const parsed = parseJudgeOutput(completion.content);
  if (!parsed) {
    throw new Error(
      `judge 输出无法解析: ${completion.content.slice(0, 200)}`,
    );
  }
  return {
    ...parsed,
    tokens: {
      prompt: completion.promptTokens,
      completion: completion.completionTokens,
      cacheHit: completion.promptCacheHitTokens,
      cacheMiss: completion.promptCacheMissTokens,
    },
  };
}

/** judge 与人工是否算一致：同分或相差 1 分都算一致。 */
export function scoresAgree(judgeScore: number, humanScore: number): boolean {
  return Math.abs(judgeScore - humanScore) <= 1;
}
