import { readFile } from "node:fs/promises";

/**
 * 从多项目对比报告里抽出帖子要用的表。
 *
 * 帖子里的数字必须是报告里的原数，手抄一次就会错一次。
 * 这个脚本直接从 report.json 里读，输出可直接贴的 Markdown 表格。
 *
 *   node --experimental-strip-types scripts/summarize-projects.mts [report.json]
 */

interface ProjectRow {
  project: string;
  label: string;
  questions: number;
  fileCount: number;
  repoLines: number;
  successRate: number;
  avgJudgeScore: number;
  avgEvidenceRecall: number;
  avgLatencyMs: number;
  totalCost: number;
  retrievalMetrics: {
    recallAt1: number;
    recallAtBudget: number;
    mrr: number;
    avgContextChars: number;
    chunkCount: number;
  };
  judgeValidation?: {
    sampled: number;
    agreement: number;
    meanJudgeScore: number;
    meanHumanScore: number;
  };
}

const path = process.argv[2] ?? "out/multi-project.json";
const report = JSON.parse(await readFile(path, "utf8")) as {
  step: string;
  rows: ProjectRow[];
  chunking: { label: string };
  retrieval: { topK: number; rerankMode?: string; queryExpansion?: boolean };
  promptVersion: string;
};

const percent = (value: number, digits = 1) =>
  `${(value * 100).toFixed(digits)}%`;

console.log(
  `共用配置：${report.chunking.label}，top-${report.retrieval.topK}，` +
    `${report.retrieval.rerankMode ?? "none"}` +
    `${report.retrieval.queryExpansion ? "，中英术语扩展" : ""}，提示词 ${report.promptVersion}`,
);
console.log("");
console.log(
  "| 项目 | 题数 | 仓库规模 | 成功率 | judge 均分 | 证据召回 | recall@1 | MRR | 平均延迟 | 总成本 | 尺子一致率 |",
);
console.log("|---|---|---|---|---|---|---|---|---|---|---|");

for (const row of [...report.rows].sort((a, b) => b.successRate - a.successRate)) {
  const agreement = row.judgeValidation
    ? `${percent(row.judgeValidation.agreement)}（${row.judgeValidation.sampled} 题）`
    : "—";
  console.log(
    `| ${row.label} | ${row.questions} | ${row.fileCount} 文件 / ${row.repoLines} 行 | ` +
      `${percent(row.successRate)} | ${row.avgJudgeScore.toFixed(2)} | ` +
      `${percent(row.avgEvidenceRecall)} | ${percent(row.retrievalMetrics.recallAt1)} | ` +
      `${row.retrievalMetrics.mrr.toFixed(3)} | ${Math.round(row.avgLatencyMs)} ms | ` +
      `¥${row.totalCost.toFixed(4)} | ${agreement} |`,
  );
}

const best = [...report.rows].sort((a, b) => b.successRate - a.successRate)[0];
const worst = [...report.rows].sort((a, b) => a.successRate - b.successRate)[0];
const spread = (best.successRate - worst.successRate) * 100;
console.log("");
console.log(
  `最高 ${best.label} ${percent(best.successRate)}，最低 ${worst.label} ${percent(worst.successRate)}，落差 ${spread.toFixed(1)} 个百分点`,
);
console.log(
  `合计成本 ¥${report.rows.reduce((sum, row) => sum + row.totalCost, 0).toFixed(4)}，` +
    `合计题数 ${report.rows.reduce((sum, row) => sum + row.questions, 0)}`,
);
