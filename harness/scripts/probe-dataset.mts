// 把「召不回来」拆成两种：证据根本没被任何块覆盖（切分的问题），
// 还是被覆盖但排在很后面（排序的问题）。
//
// 用法：node --experimental-strip-types scripts/probe-dataset.mts <dataset.json> <repoDir> [strategyId]

import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadRepository } from "../src/repository.ts";
import { buildIndex, search } from "../src/retrieval.ts";
import { chunkRepository } from "../src/chunk.ts";
import type { ChunkingStrategy, EvalDataset } from "../src/schema.ts";

const [datasetPath, repoDir, strategyId = "function-level"] = process.argv.slice(2);
if (!datasetPath || !repoDir) {
  console.error("用法: node --experimental-strip-types scripts/probe-dataset.mts <dataset.json> <repoDir> [strategyId]");
  process.exit(1);
}

const dataset = JSON.parse(await readFile(datasetPath, "utf8")) as EvalDataset;
const files = await loadRepository(path.resolve(repoDir));

const STRATEGIES: Record<string, ChunkingStrategy> = {
  "fixed-800": { id: "fixed-800", label: "固定窗口 800", kind: "fixed-window", windowSize: 800, overlap: 100 },
  "fixed-400": { id: "fixed-400", label: "固定窗口 400", kind: "fixed-window", windowSize: 400, overlap: 50 },
  "function-level": { id: "function-level", label: "函数级切分", kind: "function-level", minFunctionLines: 3 },
};

const chunks = chunkRepository(files, STRATEGIES[strategyId]);
const index = buildIndex(chunks);
const MAXK = 30;

console.log(`${dataset.id} / ${strategyId}：${dataset.questions.length} 题，${chunks.length} 块\n`);

let uncovered = 0;
for (const question of dataset.questions) {
  const hits = search(index, question.question, MAXK, { rerankMode: "none" });
  const parts = question.reference.evidence.map((g) => {
    const covering = chunks
      .filter((c) => c.file === g.file && c.startLine <= g.endLine && c.endLine >= g.startLine)
      .map((c) => ({ c, rank: hits.findIndex((h) => h.chunk.id === c.id) + 1 }));
    if (covering.length === 0) {
      uncovered += 1;
      return `${g.file}:${g.startLine}=【无覆盖块】`;
    }
    const best = covering.reduce((a, b) => (a.rank > 0 && (b.rank === 0 || a.rank < b.rank) ? a : b));
    return `${g.file}:${g.startLine}=块(${best.c.symbol ?? "无符号"})${best.rank > 0 ? "@" + best.rank : "@未进前" + MAXK}`;
  });
  console.log(`${question.id}  ${parts.join("  ")}`);
}

console.log(`\n无覆盖块的证据条数：${uncovered}`);
