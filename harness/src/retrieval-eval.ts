import { chunkRepository } from "./chunk.ts";
import { loadRepository } from "./repository.ts";
import { buildIndex, evidenceRecall, search, toCitations } from "./retrieval.ts";
import type {
  ChunkingStrategy,
  EvalDataset,
  RetrievalCase,
  RetrievalConfig,
  StrategyMetrics,
} from "./schema.ts";

/**
 * 检索层评测：只测「切分策略是否让正确的代码块能被检索到」。
 *
 * 这一层刻意不调用 LLM，原因有二：
 * 1. 它是回答质量的上限——检索不到，后面再好的生成也救不回来；
 * 2. 它完全可复现，任何人都能在几分钟内跑出同样的数字，可信度不依赖模型。
 */

const DEFAULT_TOP_KS = [1, 3, 6];

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

export interface RetrievalEvalOptions {
  dataset: EvalDataset;
  repoRoot: string;
  strategies: ChunkingStrategy[];
  retrieval: RetrievalConfig;
  topKs?: number[];
}

export async function runRetrievalEval(
  options: RetrievalEvalOptions,
): Promise<StrategyMetrics[]> {
  const topKs = options.topKs ?? DEFAULT_TOP_KS;
  const maxK = Math.max(...topKs);
  const files = await loadRepository(options.repoRoot);
  const totalRepoLines = files.reduce((sum, file) => sum + file.lines.length, 0);

  const results: StrategyMetrics[] = [];

  for (const strategy of options.strategies) {
    const chunks = chunkRepository(files, strategy);

    const indexStart = performance.now();
    const index = buildIndex(chunks);
    const indexBuildMs = performance.now() - indexStart;

    const cases: RetrievalCase[] = [];
    let contextCharsSum = 0;

    for (const question of options.dataset.questions) {
      const hits = search(index, question.question, maxK, {
        rerankMode: options.retrieval.rerankMode,
        queryExpansion: options.retrieval.queryExpansion,
      });
      const citations = toCitations(hits);
      const gold = question.reference.evidence;

      const recallAt = (k: number) =>
        evidenceRecall(
          citations.slice(0, k),
          gold,
        );

      let firstHitRank = 0;
      for (const [position, hit] of hits.entries()) {
        const rank = position + 1;
        const matched = gold.some((expected) =>
          overlaps(hit.chunk.file, hit.chunk.startLine, hit.chunk.endLine, expected),
        );
        if (matched) {
          firstHitRank = rank;
          break;
        }
      }

      contextCharsSum += hits
        .slice(0, options.retrieval.topK)
        .reduce((sum, hit) => sum + hit.chunk.text.length, 0);

      cases.push({
        questionId: question.id,
        question: question.question,
        category: question.category,
        difficulty: question.difficulty,
        gold,
        citations,
        recallAt1: recallAt(1),
        recallAt3: recallAt(3),
        recallAt6: recallAt(maxK),
        firstHitRank,
      });
    }

    const count = cases.length || 1;
    const average = (pick: (item: RetrievalCase) => number) =>
      cases.reduce((sum, item) => sum + pick(item), 0) / count;

    results.push({
      strategy,
      fileCount: files.length,
      totalRepoLines,
      chunkCount: chunks.length,
      avgChunkChars:
        chunks.reduce((sum, chunk) => sum + chunk.text.length, 0) /
        (chunks.length || 1),
      indexBuildMs,
      recallAt1: average((item) => item.recallAt1),
      recallAt3: average((item) => item.recallAt3),
      recallAt6: average((item) => item.recallAt6),
      mrr: average((item) => (item.firstHitRank > 0 ? 1 / item.firstHitRank : 0)),
      avgContextChars: contextCharsSum / count,
      cases,
    });
  }

  return results;
}
