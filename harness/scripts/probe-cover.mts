// 临时脚本：把「召不回来」拆成两种——证据根本没被任何块覆盖，还是被覆盖但排在后面。
import { readFile } from "node:fs/promises";
import { loadRepository } from "../src/repository.ts";
import { buildIndex, search, toCitations } from "../src/retrieval.ts";
import { chunkRepository } from "../src/chunk.ts";
import type { ChunkingStrategy, EvalDataset } from "../src/schema.ts";

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

const chunks = chunkRepository(files, FUNCTION_LEVEL);
const index = buildIndex(chunks);
const MAXK = 30;

for (const question of dataset.questions) {
  const hits = search(index, question.question, MAXK, { rerankMode: "none" });
  const gold = question.reference.evidence;

  const parts = gold.map((g) => {
    // 覆盖该证据行的块有哪些
    const covering = chunks
      .filter((c) => c.file === g.file && c.startLine <= g.endLine && c.endLine >= g.startLine)
      .map((c) => ({
        c,
        rank: hits.findIndex((h) => h.chunk.id === c.id) + 1,
      }));
    if (covering.length === 0) return `${g.file}:${g.startLine}=无覆盖块`;
    const best = covering.reduce((a, b) => (a.rank > 0 && (b.rank === 0 || a.rank < b.rank) ? a : b));
    const desc = `${g.file}:${g.startLine}=块(${best.c.symbol ?? "无符号"}/${best.c.symbolKind ?? "none"})${best.rank > 0 ? "@" + best.rank : "@未进前" + MAXK}`;
    return desc;
  });
  console.log(`${question.id} ${parts.join("  ")}`);
}
