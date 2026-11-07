// 临时脚本：比较不同切分策略的「召回率 - 上下文预算」曲线。
// 关键问题：函数级切分单块更大，固定窗口块更小，两者在相同上下文预算下谁更准。
import { readFile } from "node:fs/promises";
import { loadRepository } from "../src/repository.ts";
import { buildIndex, evidenceRecall, search, toCitations } from "../src/retrieval.ts";
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
const FIXED_800: ChunkingStrategy = {
  id: "fixed-800",
  label: "固定窗口 800 字符",
  kind: "fixed-window",
  windowSize: 800,
  overlap: 120,
};

function overlaps(
  file: string,
  startLine: number,
  endLine: number,
  expected: { file: string; startLine: number; endLine: number },
): boolean {
  return (
    file === expected.file &&
    startLine <= expected.endLine &&
    endLine >= expected.startLine
  );
}

for (const chunking of [FIXED_800, FUNCTION_LEVEL]) {
  const chunks = chunking.kind === "fixed-window"
    ? (await import("../src/chunk.ts")).chunkRepository(files, chunking)
    : (await import("../src/chunk.ts")).chunkRepository(files, chunking);
  const index = buildIndex(chunks);
  const MAXK = 24;

  const perQuestion = dataset.questions.map((question) => {
    const hits = search(index, question.question, MAXK, { rerankMode: "none" });
    const citations = toCitations(hits);
    const gold = question.reference.evidence;
    const chars = hits.map((h) => h.chunk.text.length);
    let firstHitRank = 0;
    for (const [position, hit] of hits.entries()) {
      const matched = gold.some((expected) =>
        overlaps(hit.chunk.file, hit.chunk.startLine, hit.chunk.endLine, expected),
      );
      if (matched) {
        firstHitRank = position + 1;
        break;
      }
    }
    return { citations, gold, chars, firstHitRank };
  });

  const count = perQuestion.length;
  console.log(`\n=== ${chunking.id} (块数 ${chunks.length}, 平均块长 ${Math.round(
    chunks.reduce((s, c) => s + c.text.length, 0) / chunks.length,
  )}) ===`);

  // recall@k 曲线
  const curve: string[] = [];
  for (const k of [1, 2, 3, 5, 6, 8, 10, 12, 16, 20, 24]) {
    const recall =
      perQuestion.reduce((s, q) => s + evidenceRecall(q.citations.slice(0, k), q.gold), 0) / count;
    const chars =
      perQuestion.reduce((s, q) => s + q.chars.slice(0, k).reduce((a, b) => a + b, 0), 0) / count;
    curve.push(`@${k}=${(recall * 100).toFixed(1)}%(${Math.round(chars)}字)`);
  }
  console.log("  recall@k: " + curve.join("  "));

  const mrr =
    perQuestion.reduce((s, q) => s + (q.firstHitRank > 0 ? 1 / q.firstHitRank : 0), 0) / count;
  console.log(`  MRR ${mrr.toFixed(3)}`);

  // 等字符预算下的召回：取该预算内能塞下的块
  for (const budget of [3000, 5000, 8000, 12000]) {
    let recallSum = 0;
    let usedSum = 0;
    for (const q of perQuestion) {
      let used = 0;
      const kept = [];
      for (const [i, citation] of q.citations.entries()) {
        const len = q.chars[i];
        if (used + len > budget && kept.length > 0) break;
        used += len;
        kept.push(citation);
      }
      recallSum += evidenceRecall(kept, q.gold);
      usedSum += used;
    }
    console.log(
      `  等预算 ${budget} 字: recall ${((recallSum / count) * 100).toFixed(1)}%  平均用 ${Math.round(usedSum / count)} 字`,
    );
  }
}
