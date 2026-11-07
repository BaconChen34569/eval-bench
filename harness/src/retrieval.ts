import type { Chunk } from "./chunk.ts";
import type { Citation } from "./schema.ts";

/**
 * BM25 打分。选它而不是向量检索，是因为评测的目的之一是隔离变量：
 * 固定检索器，才能把分数变化归因到切分策略本身。
 */
const K1 = 1.5;
const B = 0.75;

export interface IndexedChunk extends Chunk {
  /** 预分词结果，避免每次查询重复分词 */
  tokens: string[];
  /** 词频 */
  termFreq: Map<string, number>;
  length: number;
}

const TOKEN_RE = /[A-Za-z_][A-Za-z0-9_]*|[一-龥]|\d+/g;

/** 英文按驼峰与下划线再切一刀，中文按字切。 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.matchAll(TOKEN_RE)) {
    const token = match[0];
    tokens.push(token.toLowerCase());
    if (/^[A-Za-z_]/.test(token)) {
      for (const part of token.split(/_+/)) {
        if (part.length > 1) tokens.push(part.toLowerCase());
      }
      const camel = token.match(/[a-z0-9][A-Z]|[A-Z][a-z]/g);
      if (camel) for (const part of camel) tokens.push(part.toLowerCase());
    }
  }
  return tokens;
}

export interface Bm25Index {
  chunks: IndexedChunk[];
  /** 词 -> 包含该词的块下标 */
  postings: Map<string, number[]>;
  averageLength: number;
}

export function buildIndex(chunks: Chunk[]): Bm25Index {
  const indexed: IndexedChunk[] = chunks.map((chunk) => {
    const tokens = tokenize(`${chunk.file} ${chunk.symbol ?? ""} ${chunk.text}`);
    const termFreq = new Map<string, number>();
    for (const token of tokens) {
      termFreq.set(token, (termFreq.get(token) ?? 0) + 1);
    }
    return { ...chunk, tokens, termFreq, length: tokens.length };
  });

  const postings = new Map<string, number[]>();
  indexed.forEach((chunk, index) => {
    for (const term of chunk.termFreq.keys()) {
      const list = postings.get(term);
      if (list) list.push(index);
      else postings.set(term, [index]);
    }
  });

  const totalLength = indexed.reduce((sum, chunk) => sum + chunk.length, 0);
  return {
    chunks: indexed,
    postings,
    averageLength: indexed.length ? totalLength / indexed.length : 0,
  };
}

export interface ScoredChunk {
  chunk: IndexedChunk;
  score: number;
}

export interface SearchOptions {
  /** 重排方式，默认不重排（纯 BM25） */
  rerankMode?: "none" | "symbol-boost";
}

/** 符号名精确命中的加权值 */
const SYMBOL_EXACT_BOOST = 3;
/** 符号名后缀命中（如 session 命中 open_session）的加权值 */
const SYMBOL_SUFFIX_BOOST = 1.5;
/** 文件名命中（如 blueprint 命中 blueprints.py）的加权值 */
const FILE_BOOST = 0.8;

function normalizeToken(token: string): string {
  return token.toLowerCase().replace(/_/g, "");
}

/**
 * 结构信号加权：BM25 只看词频，问题里出现的标识符如果正好是某个代码块的符号名，
 * 说明这个块大概率就是答案所在——这类信号词频拿不到，只能靠结构补。
 * 加权值是常数，与 BM25 分数量级（约 1~10）可比。
 *
 * 只对函数/方法级块生效。类级块往往横跨整个文件，它的行区间天然覆盖证据行，
 * 一旦被顶上榜首，召回率会因为「覆盖假象」虚高，同时上下文体积翻倍。
 */
function symbolBoost(chunk: IndexedChunk, queryTokens: string[]): number {
  if (chunk.symbolKind === "class") return 0;

  let boost = 0;
  const symbol = chunk.symbol ? normalizeToken(chunk.symbol) : "";
  const fileName = chunk.file.split("/").pop() ?? "";
  const stem = normalizeToken(fileName.replace(/\.[^.]+$/, ""));

  for (const token of queryTokens) {
    const normalized = normalizeToken(token);
    if (normalized.length < 3) continue;
    if (symbol && symbol === normalized) {
      boost += SYMBOL_EXACT_BOOST;
      continue;
    }
    if (symbol && normalized.length >= 5 && symbol.endsWith(normalized)) {
      boost += SYMBOL_SUFFIX_BOOST;
      continue;
    }
    if (stem.length >= 5 && (stem.includes(normalized) || normalized.includes(stem))) {
      boost += FILE_BOOST;
    }
  }
  return boost;
}

export function search(
  index: Bm25Index,
  query: string,
  topK: number,
  options: SearchOptions = {},
): ScoredChunk[] {
  const queryTokens = [...new Set(tokenize(query))];
  const total = index.chunks.length;
  if (!total) return [];

  const scores = new Map<number, number>();
  for (const token of queryTokens) {
    const posting = index.postings.get(token);
    if (!posting) continue;
    const idf = Math.log(1 + (total - posting.length + 0.5) / (posting.length + 0.5));
    for (const index_ of posting) {
      const chunk = index.chunks[index_];
      const tf = chunk.termFreq.get(token) ?? 0;
      const denominator =
        tf + K1 * (1 - B + (B * chunk.length) / (index.averageLength || 1));
      const contribution = idf * ((tf * (K1 + 1)) / denominator);
      scores.set(index_, (scores.get(index_) ?? 0) + contribution);
    }
  }

  const mode = options.rerankMode ?? "none";

  const ranked = [...scores.entries()].map(([chunkIndex, score]) => ({
    chunk: index.chunks[chunkIndex],
    score,
  }));

  if (mode === "symbol-boost") {
    const boostOf = (chunk: IndexedChunk): number => symbolBoost(chunk, queryTokens);

    // 只被结构信号命中的块 BM25 得分是 0，不补进来就等于加权没生效。
    for (const [chunkIndex, chunk] of index.chunks.entries()) {
      if (scores.has(chunkIndex)) continue;
      const boost = boostOf(chunk);
      if (boost > 0) ranked.push({ chunk, score: boost });
    }
    for (const item of ranked) {
      item.score += boostOf(item.chunk);
    }
  }

  return ranked.sort((a, b) => b.score - a.score).slice(0, topK);
}

export function toCitations(results: ScoredChunk[]): Citation[] {
  return results.map(({ chunk, score }) => ({
    file: chunk.file,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    score: Number(score.toFixed(4)),
  }));
}

/**
 * 证据召回率：agent 引用的位置覆盖了标准答案要求的多少证据。
 * 命中判定用文件路径相同且行号区间有交集，足够严格又不会被行号微偏差误伤。
 */
export function evidenceRecall(
  citations: Citation[],
  expected: { file: string; startLine: number; endLine: number }[],
): number {
  if (expected.length === 0) return 1;
  let hit = 0;
  for (const want of expected) {
    const matched = citations.some(
      (got) =>
        got.file === want.file &&
        got.startLine <= want.endLine &&
        got.endLine >= want.startLine,
    );
    if (matched) hit++;
  }
  return hit / expected.length;
}
