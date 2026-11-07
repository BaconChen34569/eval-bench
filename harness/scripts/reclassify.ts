import { readFile, writeFile } from "node:fs/promises";
import { parseAnswerCitations } from "../src/agent.ts";
import { classifyFailure, fileLineCounts } from "../src/failure.ts";
import { loadRepository } from "../src/repository.ts";
import type { EvalRun } from "../src/schema.ts";

/**
 * 用新的归因规则重算已有报告里的 failureKind，不重新调用模型。
 * 评测结果（分数、延迟、成本）保持原样，只重写失败分类。
 *
 * 用法：node --experimental-strip-types scripts/reclassify.ts <report.json> <repoRoot>
 */
const [reportPath, repoRoot] = process.argv.slice(2);

if (!reportPath || !repoRoot) {
  console.error("用法：node --experimental-strip-types scripts/reclassify.ts <report.json> <repoRoot>");
  process.exit(1);
}

const files = await loadRepository(repoRoot);
const lineCounts = fileLineCounts(files);
const report = JSON.parse(await readFile(reportPath, "utf8"));

const counts = new Map<string, number>();

for (const run of report.runs as EvalRun[]) {
  for (const item of run.cases) {
    const kind = classifyFailure(
      {
        answerCitations: parseAnswerCitations(item.answer),
        evidenceRecall: item.evidenceRecall,
        judgeScore: item.judgeScore,
        successThreshold: run.summary.successThreshold,
      },
      lineCounts,
    );
    if (kind) item.failureKind = kind;
    else delete item.failureKind;
    const key = `${run.chunking.id}/${kind ?? "pass"}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
}

await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");

for (const [key, value] of counts) console.log(`${key}: ${value}`);
console.log(`\n已重写 ${reportPath}`);
