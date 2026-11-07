import { loadRepository } from "./repository.ts";
import { chunkRepository } from "./chunk.ts";
import { buildIndex, search } from "./retrieval.ts";
import type { ChunkingStrategy } from "./schema.ts";

/** 冒烟测试：不调 LLM，验证切分与检索链路。 */

const repoRoot = process.argv[2] ?? "../corpus/repos/flask-3.1.3";
const strategies: ChunkingStrategy[] = [
  { id: "fixed-800", label: "固定窗口 800", kind: "fixed-window", windowSize: 800, overlap: 120 },
  { id: "fixed-400", label: "固定窗口 400", kind: "fixed-window", windowSize: 400, overlap: 60 },
  { id: "function-level", label: "函数级", kind: "function-level", minFunctionLines: 3 },
];

const files = await loadRepository(repoRoot);
console.log(`加载 ${files.length} 个文件`);

for (const strategy of strategies) {
  const chunks = chunkRepository(files, strategy);
  const index = buildIndex(chunks);
  const avgLength = Math.round(
    chunks.reduce((sum, chunk) => sum + chunk.text.length, 0) / (chunks.length || 1),
  );
  const withSymbol = chunks.filter((chunk) => chunk.symbol).length;

  console.log(
    `\n[${strategy.id}] 块数=${chunks.length} 平均长度=${avgLength} 带符号块=${withSymbol}`,
  );

  const hits = search(index, "Flask 应用如何创建和注册蓝图 blueprint", 3);
  for (const hit of hits) {
    console.log(
      `  ${hit.score.toFixed(2)} ${hit.chunk.file}:${hit.chunk.startLine}-${hit.chunk.endLine}${hit.chunk.symbol ? ` (${hit.chunk.symbol})` : ""}`,
    );
  }
}
