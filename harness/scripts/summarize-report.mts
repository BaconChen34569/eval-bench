// 从 report.json 里抽出写帖子要用的数字，避免手抄抄错。
import { readFile } from "node:fs/promises";
import type { ExperimentReport } from "../src/schema.ts";

const path = process.argv[2] ?? "out/report.json";
const report = JSON.parse(
  await readFile(path, "utf8"),
) as ExperimentReport;

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const money = (v: number) => `¥${v.toFixed(4)}`;
const ms = (v: number) => `${(v / 1000).toFixed(1)}s`;

console.log(`题集 ${report.datasetId}  仓库 ${report.repo}  计价 ${report.costCurrency}`);

const jv = report.judgeValidation;
console.log(
  `\n[judge 自检] 题数 ${jv.sampled}  一致率 ${pct(jv.agreement)}  ` +
    `完全同分 ${pct(jv.exactAgreement)}  judge 均分 ${jv.meanJudgeScore.toFixed(2)} vs 人工 ${jv.meanHumanScore.toFixed(2)}`,
);

console.log("\n[横向策略对比 · 检索层]");
for (const s of report.strategies) {
  console.log(
    `  ${s.strategy.id.padEnd(15)} r@1 ${pct(s.recallAt1).padStart(6)}  r@3 ${pct(s.recallAt3).padStart(6)}  ` +
      `r@6 ${pct(s.recallAt6).padStart(6)}  MRR ${s.mrr.toFixed(3)}  上下文 ${Math.round(s.avgContextChars)}  ` +
      `chunk ${s.chunkCount}`,
  );
}

console.log("\n[横向策略对比 · 生成层]");
for (const run of report.runs ?? []) {
  const s = run.summary;
  console.log(
    `  ${run.chunking.id.padEnd(15)} 成功率 ${pct(s.successRate).padStart(6)}  均分 ${s.avgJudgeScore.toFixed(2)}  ` +
      `延迟 ${ms(s.avgLatencyMs)} / P95 ${ms(s.p95LatencyMs)}  单题 ${money(s.avgCost)}  总 ${money(s.totalCost)}  ` +
      `token ${s.totalTokens}`,
  );
  const wrong = run.cases.filter((c) => c.failureKind === "wrong-location").length;
  const missing = run.cases.filter((c) => c.failureKind === "missing-detail").length;
  const hallu = run.cases.filter((c) => c.failureKind === "hallucination").length;
  const fail = run.cases.filter((c) => c.failureKind).length;
  console.log(
    `      失败 ${fail} 题：定位错 ${wrong} / 漏要点 ${missing} / 编造 ${hallu}` +
      (fail ? `（定位错占 ${pct(wrong / fail)}）` : ""),
  );
}

console.log("\n[迭代阶梯]");
for (const step of report.ladder ?? []) {
  console.log(
    `  ${step.id} ${step.title.padEnd(14)} 成功率 ${pct(step.summary.successRate).padStart(6)}  ` +
      `均分 ${step.summary.avgJudgeScore.toFixed(2)}  r@预算 ${pct(step.retrievalMetrics.recallAtBudget).padStart(6)}  ` +
      `上下文 ${Math.round(step.retrievalMetrics.avgContextChars)}  成本 ${money(step.summary.totalCost)}  ` +
      `| ${step.change}`,
  );
}

if (report.ladder?.length) {
  const runs = report.ladderRuns ?? [];
  const threshold = runs[0]?.summary.successThreshold ?? 4;
  const ids = [...new Set(runs[0]?.cases.map((c) => c.questionId) ?? [])];
  const never = ids.filter((id) =>
    runs.every((r) => (r.cases.find((c) => c.questionId === id)?.judgeScore ?? 0) < threshold),
  );
  console.log(`\n  全程未达标（<${threshold} 分）：${never.length} 题  ${never.join(", ")}`);
  for (const run of runs) {
    const kinds = new Map<string, number>();
    for (const c of run.cases) {
      const kind = c.failureKind ?? (c.judgeScore >= (run.summary.successThreshold ?? 4) ? "pass" : "unknown");
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    }
    console.log(
      `  ${run.ladderStepId ?? run.runId}: ` +
        [...kinds.entries()].map(([k, v]) => `${k} ${v}`).join(" / ") +
        `  token ${run.summary.totalTokens}`,
    );
  }
}
