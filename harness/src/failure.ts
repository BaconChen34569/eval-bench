import type { CodeFile } from "./chunk.ts";
import type { Citation } from "./schema.ts";

export type FailureKind =
  | "wrong-location"
  | "missing-detail"
  | "hallucination"
  | "timeout";

export interface FailureInput {
  /** 答案正文里解析出的引用位置；模型没给位置时为空 */
  answerCitations: Citation[];
  /** 检索命中人工标注证据的比例 */
  evidenceRecall: number;
  judgeScore: number;
  successThreshold: number;
}

/** 仓库里每个文件的行数，用来判断模型引用的位置是否真实存在。 */
export function fileLineCounts(files: CodeFile[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const file of files) map.set(file.path, file.lines.length);
  return map;
}

/**
 * 失败归因按 ground truth 判定，不采信 judge 的自由文本描述：
 * 先看有没有引用到仓库里不存在的位置（编造），
 * 再看检索有没有命中人工标注的证据（定位失败），
 * 剩下的才算生成阶段漏了要点。
 *
 * 这个顺序是有意的：定位错误和漏要点要修的地方完全不同，
 * 前者要换检索策略，后者才轮到改提示词。
 */
export function classifyFailure(
  input: FailureInput,
  lineCounts: Map<string, number>,
): FailureKind | undefined {
  if (input.judgeScore >= input.successThreshold) return undefined;

  for (const citation of input.answerCitations) {
    const total = lineCounts.get(citation.file);
    if (total === undefined) return "hallucination";
    if (citation.startLine < 1 || citation.endLine > total) return "hallucination";
  }

  if (input.evidenceRecall === 0) return "wrong-location";
  return "missing-detail";
}
