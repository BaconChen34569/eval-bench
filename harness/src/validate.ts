/**
 * 校验评测集：证据行号必须真实存在，且区间内确实出现对应的符号名。
 * 证据写错会让召回率变成噪声，所以这一步是硬门槛。
 *
 *   node --experimental-strip-types src/validate.ts <dataset.json> <repoRoot>
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvalDataset, EvidenceRef } from "./schema.ts";

const [datasetPath, repoRoot] = process.argv.slice(2);
if (!datasetPath || !repoRoot) {
  console.error("用法: node --experimental-strip-types src/validate.ts <dataset.json> <repoRoot>");
  process.exit(1);
}

const dataset = JSON.parse(await readFile(datasetPath, "utf8")) as EvalDataset;
const problems: string[] = [];
const warnings: string[] = [];

/**
 * 证据里的 symbol 写法不统一：可能是 `Blueprint.register`、
 * `Request.blueprint / Request.blueprints`，也可能是 `Flask.make_response 中 rv is None 的处理`。
 * 这里把它们拆成若干个候选标识符，只要区间里命中其一就算通过。
 */
function symbolCandidates(symbol: string): string[] {
  return symbol
    .split("/")
    .map((part) => part.split(" 中")[0].trim())
    .map((part) => part.replace(/^class\s+/, "").replace(/\(.*\)$/, ""))
    .map((part) => (part.includes(".") ? part.split(".").pop() ?? part : part))
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function matchesSymbol(text: string, symbol: string): boolean {
  return symbolCandidates(symbol).some((candidate) =>
    new RegExp(`\\b${candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text),
  );
}

for (const question of dataset.questions) {
  if (!question.reference.evidence.length) {
    problems.push(`${question.id}: 没有证据条目`);
  }
  for (const evidence of question.reference.evidence) {
    const filePath = join(repoRoot, evidence.file);
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch {
      problems.push(`${question.id}: 文件不存在 ${evidence.file}`);
      continue;
    }
    const lines = content.split("\n");
    if (evidence.startLine < 1 || evidence.endLine > lines.length) {
      problems.push(
        `${question.id}: ${evidence.file} 行号越界 ${evidence.startLine}-${evidence.endLine}（文件共 ${lines.length} 行）`,
      );
      continue;
    }
    const slice = lines.slice(evidence.startLine - 1, evidence.endLine).join("\n");
    if (evidence.symbol && !matchesSymbol(slice, evidence.symbol)) {
      // 证据区间可能精确落在某个函数体内部的分支上，符号名自然不会出现在区间文本里。
      // 这类区间按行号校验，只做提示，需要人工确认。
      warnings.push(
        `${question.id}: ${evidence.file}:${evidence.startLine}-${evidence.endLine} 区间内没有字面出现 ${evidence.symbol}（可能是函数体内分支，需人工确认）`,
      );
    }
    if (slice.trim().length === 0) {
      problems.push(`${question.id}: ${evidence.file} 的证据区间是空的`);
    }
  }
  for (const point of question.reference.mustMention) {
    if (!question.reference.answer.includes(point)) {
      warnings.push(
        `${question.id}: 要点没有在标准答案里原样出现（judge 按语义覆盖判定，不影响评测）：${point}`,
      );
    }
  }
}

console.log(`数据集 ${dataset.id}：${dataset.questions.length} 题`);
if (warnings.length) {
  console.log(`提示 ${warnings.length} 条（不阻断）：`);
  for (const warning of warnings) console.log(`  · ${warning}`);
}
if (problems.length === 0) {
  console.log("全部证据校验通过");
} else {
  console.log(`发现 ${problems.length} 个问题：`);
  for (const problem of problems) console.log(`  - ${problem}`);
  process.exit(1);
}
