// 临时脚本：诊断「召回为 0」的题到底卡在哪一环——文件根本没进候选池，还是进了但行号没覆盖。
import { readFile } from "node:fs/promises";
import { loadRepository } from "../src/repository.ts";
import { buildIndex, evidenceRecall, search, toCitations } from "../src/retrieval.ts";
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

let fileMiss = 0;
let lineMiss = 0;
for (const question of dataset.questions) {
  const hits = search(index, question.question, MAXK, { rerankMode: "none" });
  const citations = toCitations(hits);
  const gold = question.reference.evidence;
  const recall6 = evidenceRecall(citations.slice(0, 6), gold);
  if (recall6 >= 1) continue;

  // gold 文件是否进了前 30？
  const goldFiles = [...new Set(gold.map((g) => g.file))];
  const candidateFiles = new Set(citations.map((c) => c.file));
  const missingFiles = goldFiles.filter((f) => !candidateFiles.has(f));
  const ranks = goldFiles.map((f) => {
    const r = citations.findIndex((c) => c.file === f);
    return `${f}@${r < 0 ? "未进前" + MAXK : r + 1}`;
  });
  // 文件进了池但行号没覆盖？
  const lineCovered = gold.every((g) =>
    citations.some((c) => c.file === g.file && c.startLine <= g.endLine && c.endLine >= g.startLine),
  );
  const tag = missingFiles.length ? "文件没进池" : "行号没覆盖";
  if (missingFiles.length) fileMiss++;
  else lineMiss++;
  console.log(
    `${question.id} recall@6=${(recall6 * 100).toFixed(0)}% [${tag}] ${ranks.join(" ")}`,
  );
}
console.log(`\n共 ${fileMiss} 题是文件没进候选池，${lineMiss} 题是行号没覆盖`);
