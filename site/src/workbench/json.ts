/**
 * 粘贴框里的 JSON 处理。
 *
 * 评测产物动辄几千行，手写的一律是压缩过的：
 * 这里负责把它排版成能读的样子，并且把报错落到具体行列上。
 */

export interface JsonProblem {
  message: string;
  /** 出错的那一行，从 1 开始 */
  line?: number;
  /** 出错的那一列，从 1 开始 */
  column?: number;
}

export interface FormatResult {
  ok: boolean;
  /** 排版后的 JSON；解析失败时是原文 */
  text: string;
  problem?: JsonProblem;
}

/** 把字符位置换算成行列，位置从 0 开始。 */
function positionToLineColumn(
  text: string,
  position: number,
): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(position, text.length));
  const before = text.slice(0, clamped);
  const lines = before.split("\n");
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

/**
 * 从 JSON.parse 的报错里抠出出错位置。
 *
 * V8 的报错长这样：
 *   Unexpected token } in JSON at position 1234 (line 40 column 5)
 * 位置拿不到就只留消息本身。
 */
function locateProblem(
  message: string,
  text: string,
): JsonProblem {
  const byPosition = message.match(/position\s+(\d+)/i);
  if (byPosition) {
    const { line, column } = positionToLineColumn(
      text,
      Number(byPosition[1]),
    );
    // 位置我们自己用中文报一遍，原文里的 at position / line x column y 就不要了。
    const clean = message
      .replace(/\s*at position \d+.*$/i, "")
      .replace(/\s*\(line \d+ column \d+\)\s*$/i, "")
      .trim();
    return { message: clean || message, line, column };
  }
  const byLine = message.match(/line\s+(\d+)\s+column\s+(\d+)/i);
  if (byLine) {
    return {
      message: message.replace(/\s*\(line \d+ column \d+\)\s*$/i, "").trim(),
      line: Number(byLine[1]),
      column: Number(byLine[2]),
    };
  }
  return { message };
}

/**
 * 尝试把一段文本当成 JSON 解析并排版。
 *
 * 失败时原样返回文本，另给出一条带行列的报错。
 */
export function formatJson(input: string): FormatResult {
  const text = input.trim();
  if (!text) return { ok: false, text: input, problem: { message: "内容是空的" } };
  try {
    const parsed = JSON.parse(text);
    return { ok: true, text: JSON.stringify(parsed, null, 2) };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, text: input, problem: locateProblem(message, text) };
  }
}

/** 文本里的行数和字符数，给输入框下面显示用。 */
export function countText(text: string): { lines: number; chars: number } {
  if (!text) return { lines: 0, chars: 0 };
  return { lines: text.split("\n").length, chars: text.length };
}
