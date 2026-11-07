// 临时脚本：比较几种重排模式在函数级切分下的离线检索指标。
import { readFile } from "node:fs/promises";
import { loadRepository } from "../src/repository.ts";
import { measureRetrieval } from "../src/ladder.ts";
import type { ChunkingStrategy, EvalDataset, RetrievalConfig } from "../src/schema.ts";

const dataset = JSON.parse(
  await readFile(new URL("../datasets/flask.json", import.meta.url), "utf8"),
) as EvalDataset;
const files = await loadRepository(
  new URL("../../corpus/repos/flask-3.1.3", import.meta.url).pathname.replace(/^\//, ""),
);

const FUNCTION_LEVEL: ChunkingStrategy = {
  id: "function-level",
  label: "函数级切分",
  kind: "function-level",
  minFunctionLines: 3,
};

const modes: { name: string; retrieval: RetrievalConfig }[] = [
  { name: "BM25", retrieval: { topK: 6, rerank: false, rerankMode: "none" } },
  { name: "symbol", retrieval: { topK: 6, rerank: true, rerankMode: "symbol-boost" } },
];

for (const entry of modes) {
  const m = measureRetrieval(files, dataset, FUNCTION_LEVEL, entry.retrieval);
  console.log(
    `${entry.name.padEnd(14)} recall@1 ${(m.recallAt1 * 100).toFixed(1)}%  ` +
      `recall@3 ${(m.recallAt3 * 100).toFixed(1)}%  recall@6 ${(m.recallAt6 * 100).toFixed(1)}%  ` +
      `MRR ${m.mrr.toFixed(3)}  上下文 ${Math.round(m.avgContextChars)}`,
  );
}

console.log("\n--- 放宽预算 (symbol) ---");
for (const topK of [6, 8, 10, 12]) {
  const m = measureRetrieval(files, dataset, FUNCTION_LEVEL, {
    topK,
    rerank: true,
    rerankMode: "symbol-boost",
  });
  console.log(
    `topK=${String(topK).padEnd(3)} recall@预算 ${(m.recallAtBudget * 100).toFixed(1)}%  ` +
      `MRR ${m.mrr.toFixed(3)}  上下文 ${Math.round(m.avgContextChars)}`,
  );
}
