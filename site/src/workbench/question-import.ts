import type { WorkDataset, WorkQuestion } from "@/src/workbench/api";
import {
  CATEGORY_LABEL,
  DIFFICULTY_LABEL,
  type Difficulty,
  type QuestionCategory,
} from "@/data/report";

/**
 * 题目文件的解析。
 *
 * 用户手上可能有三样东西：模型吐出来的题目数组、
 * 带 questions 字段的题集、或者从别处抄来的一道题。
 * 这里三种都认，缺的字段补默认值，导入后能直接改。
 */

export interface ImportResult {
  questions: WorkQuestion[];
  /** 文件里带的题集信息，导入时可以顺手填上 */
  meta: { id?: string; repo?: string; language?: string; createdAt?: string };
}

const CATEGORY_VALUES = Object.keys(CATEGORY_LABEL) as QuestionCategory[];
const DIFFICULTY_VALUES = Object.keys(DIFFICULTY_LABEL) as Difficulty[];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeCategory(value: unknown): QuestionCategory {
  return CATEGORY_VALUES.includes(value as QuestionCategory)
    ? (value as QuestionCategory)
    : "code-location";
}

function normalizeDifficulty(value: unknown): Difficulty {
  return DIFFICULTY_VALUES.includes(value as Difficulty)
    ? (value as Difficulty)
    : "medium";
}

function normalizeQuestion(
  raw: unknown,
  index: number,
): WorkQuestion | undefined {
  const item = asRecord(raw);
  if (!item) return undefined;
  const text = typeof item.question === "string" ? item.question.trim() : "";
  if (!text) return undefined;

  const reference = asRecord(item.reference) ?? {};
  const evidenceRaw = Array.isArray(reference.evidence) ? reference.evidence : [];
  const evidence = evidenceRaw
    .map((entry) => {
      const row = asRecord(entry);
      if (!row) return undefined;
      const file = typeof row.file === "string" ? row.file.trim() : "";
      if (!file) return undefined;
      return {
        file,
        startLine: Number(row.startLine) || 1,
        endLine: Number(row.endLine) || Number(row.startLine) || 1,
        symbol: typeof row.symbol === "string" ? row.symbol : undefined,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

  const mustMention = Array.isArray(reference.mustMention)
    ? reference.mustMention
        .filter((point): point is string => typeof point === "string")
        .map((point) => point.trim())
        .filter(Boolean)
    : [];

  return {
    id:
      typeof item.id === "string" && item.id.trim()
        ? item.id.trim()
        : `q${String(index + 1).padStart(2, "0")}`,
    question: text,
    category: normalizeCategory(item.category),
    difficulty: normalizeDifficulty(item.difficulty),
    reference: {
      answer:
        typeof reference.answer === "string" ? reference.answer : "",
      evidence,
      mustMention,
    },
  };
}

/**
 * 解析一个题目文件。
 *
 * 支持三种形状：题目数组、带 questions 的题集、单道题。
 * 解析不了就抛错，错误消息说清楚差在哪。
 */
export function parseQuestionsFile(text: string): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(
      `这不是合法的 JSON：${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  const meta: ImportResult["meta"] = {};
  let rawQuestions: unknown[] = [];

  if (Array.isArray(parsed)) {
    rawQuestions = parsed;
  } else {
    const root = asRecord(parsed);
    if (!root) throw new Error("文件内容不是题目数组，也不是题集对象");
    if (Array.isArray(root.questions)) {
      rawQuestions = root.questions;
      if (typeof root.id === "string") meta.id = root.id;
      if (typeof root.repo === "string") meta.repo = root.repo;
      if (typeof root.language === "string") meta.language = root.language;
      if (typeof root.createdAt === "string") meta.createdAt = root.createdAt;
    } else if (typeof root.question === "string") {
      rawQuestions = [root];
    } else {
      throw new Error("文件里没有 questions 数组，也不是一道题");
    }
  }

  const questions = rawQuestions
    .map((item, index) => normalizeQuestion(item, index))
    .filter((item): item is WorkQuestion => Boolean(item));

  if (questions.length === 0) {
    throw new Error("文件里一道题都没有：每道题至少要有 question 字段");
  }

  return { questions, meta };
}

/**
 * 把导入的题目并进当前题集。
 *
 * 题号撞了就往后加后缀，避免覆盖用户已经写好的题。
 */
export function mergeQuestions(
  dataset: WorkDataset,
  incoming: WorkQuestion[],
): WorkQuestion[] {
  const used = new Set(dataset.questions.map((item) => item.id));
  const merged = [...dataset.questions];
  for (const item of incoming) {
    let id = item.id;
    let suffix = 2;
    while (used.has(id)) {
      id = `${item.id}-${suffix}`;
      suffix += 1;
    }
    used.add(id);
    merged.push({ ...item, id });
  }
  return merged;
}
