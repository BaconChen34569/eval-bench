import type { Chunk } from "./chunk.ts";
import type { Citation } from "./schema.ts";
import { expandQueryTerms } from "./bilingual.ts";

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
  /** 文件路径里出现的词（不含复合形式） */
  pathTokens: Set<string>;
  /** 符号名里出现的词 */
  symbolTokens: Set<string>;
  /** 文件路径的复合形式：src/flask/app.py、flask/app.py、app.py */
  compoundPaths: string[];
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
  /** 复合路径 token -> 包含它的块下标 */
  compoundPostings: Map<string, number[]>;
  averageLength: number;
}

/** 像文件路径的片段：app.py、flask/app.py */
const PATH_RE = /[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.[A-Za-z0-9]{1,6}\b/g;

/**
 * 文件路径的复合 token。
 *
 * 问题里写「flask/app.py」，而仓库里的路径是「src/flask/app.py」。
 * 拆成单词以后只剩 flask / app / py 这几个烂大街的词，到处都是 Flask 的文件里都有，
 * 区分度等于零；真正有区分度的是路径本身。把整条路径当成一个 token，
 * 模块名一被点名就能精确命中。
 */
export function pathCompoundTokens(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(PATH_RE)) {
    const raw = match[0].toLowerCase();
    out.push(raw);
    const parts = raw.split("/");
    for (let i = 1; i < parts.length; i++) {
      const tail = parts.slice(i).join("/");
      if (tail !== raw) out.push(tail);
    }
  }
  return out;
}

export function buildIndex(chunks: Chunk[]): Bm25Index {
  const indexed: IndexedChunk[] = chunks.map((chunk) => {
    const tokens = tokenize(`${chunk.file} ${chunk.symbol ?? ""} ${chunk.text}`);
    const termFreq = new Map<string, number>();
    for (const token of tokens) {
      termFreq.set(token, (termFreq.get(token) ?? 0) + 1);
    }
    return {
      ...chunk,
      tokens,
      termFreq,
      length: tokens.length,
      pathTokens: new Set(tokenize(chunk.file)),
      symbolTokens: new Set(tokenize(chunk.symbol ?? "")),
      compoundPaths: pathCompoundTokens(chunk.file),
    };
  });

  const postings = new Map<string, number[]>();
  const compoundPostings = new Map<string, number[]>();
  indexed.forEach((chunk, index) => {
    for (const term of chunk.termFreq.keys()) {
      const list = postings.get(term);
      if (list) list.push(index);
      else postings.set(term, [index]);
    }
    for (const compound of chunk.compoundPaths) {
      const list = compoundPostings.get(compound);
      if (list) list.push(index);
      else compoundPostings.set(compound, [index]);
    }
  });

  const totalLength = indexed.reduce((sum, chunk) => sum + chunk.length, 0);
  return {
    chunks: indexed,
    postings,
    compoundPostings,
    averageLength: indexed.length ? totalLength / indexed.length : 0,
  };
}

export interface ScoredChunk {
  chunk: IndexedChunk;
  score: number;
}

export interface SearchOptions {
  /** 重排方式，默认不重排（纯 BM25） */
  rerankMode?: "none" | "symbol-boost" | "structure-aware";
  /** 是否把问题里的中文术语展开成英文候选词再参与检索 */
  queryExpansion?: boolean;
}

/** 符号名精确命中的加权值 */
const SYMBOL_EXACT_BOOST = 3;
/** 符号名后缀命中（如 session 命中 open_session）的加权值 */
const SYMBOL_SUFFIX_BOOST = 1.5;
/** 文件名命中（如 blueprint 命中 blueprints.py）的加权值 */
const FILE_BOOST = 0.8;
/** 问题里的词出现在文件路径中时的加权值 */
const PATH_FIELD_BOOST = 0.6;
/** 问题里的词出现在符号名中时的加权值 */
const SYMBOL_FIELD_BOOST = 0.4;
/** 问题里点名了整条文件路径时的加权值 */
const COMPOUND_PATH_BOOST = 4;

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
function symbolBoost(
  chunk: IndexedChunk,
  queryTokens: { token: string; weight: number }[],
): number {
  if (chunk.symbolKind === "class") return 0;

  let boost = 0;
  const symbol = chunk.symbol ? normalizeToken(chunk.symbol) : "";
  const fileName = chunk.file.split("/").pop() ?? "";
  const stem = normalizeToken(fileName.replace(/\.[^.]+$/, ""));

  for (const { token, weight } of queryTokens) {
    const normalized = normalizeToken(token);
    if (normalized.length < 3) continue;
    if (symbol && symbol === normalized) {
      boost += SYMBOL_EXACT_BOOST * weight;
      continue;
    }
    if (symbol && normalized.length >= 5 && symbol.endsWith(normalized)) {
      boost += SYMBOL_SUFFIX_BOOST * weight;
      continue;
    }
    if (stem.length >= 5 && (stem.includes(normalized) || normalized.includes(stem))) {
      boost += FILE_BOOST * weight;
    }
  }
  return boost;
}

/** 术语扩展词的权重：低于原词，否则「文件」「类」这类泛词会盖过问题本身的关键词。 */
const EXPANSION_WEIGHT = 0.4;

/**
 * 扩展词在语料里的覆盖上限（占全部块的比例）。
 *
 * 术语表里有「函数→def」「类→class」「返回→return」这类映射，
 * def / return 在任何 Python 仓库里都铺天盖地，展开它们等于往查询里灌噪音：
 * 命中的块又多又大，排序被冲淡，上下文体积翻倍。
 *
 * 所以扩展词只在「有区分度」时才参与打分——覆盖超过这个比例的词直接丢掉。
 * 这个阈值是相对语料的，不是针对某道题的特判。
 */
const EXPANSION_MAX_COVERAGE = 0.15;

export function search(
  index: Bm25Index,
  query: string,
  topK: number,
  options: SearchOptions = {},
): ScoredChunk[] {
  const originalTokens = [...new Set(tokenize(query))];
  const queryCompounds = new Set(pathCompoundTokens(query));
  const total = index.chunks.length;
  if (!total) return [];

  /**
   * 打分用词表：原词权重 1，术语扩展出来的词权重打折。
   * 扩展词只是「把问题的中文说法翻译成代码里的英文说法」的候选，
   * 不该和用户明确写出来的标识符同等对待。
   */
  const scoringTerms: { token: string; weight: number }[] = originalTokens.map(
    (token) => ({ token, weight: 1 }),
  );
  if (options.queryExpansion) {
    const seen = new Set(originalTokens);
    const maxPosting = total * EXPANSION_MAX_COVERAGE;
    for (const token of expandQueryTerms(query)) {
      if (seen.has(token)) continue;
      const posting = index.postings.get(token);
      // 语料里到处都有的词不适合当扩展候选：它带来的命中没有指向性。
      if (!posting || posting.length > maxPosting) continue;
      seen.add(token);
      scoringTerms.push({ token, weight: EXPANSION_WEIGHT });
    }
  }

  const scores = new Map<number, number>();
  for (const { token, weight } of scoringTerms) {
    const posting = index.postings.get(token);
    if (!posting) continue;
    const idf = Math.log(1 + (total - posting.length + 0.5) / (posting.length + 0.5));
    for (const index_ of posting) {
      const chunk = index.chunks[index_];
      const tf = chunk.termFreq.get(token) ?? 0;
      const denominator =
        tf + K1 * (1 - B + (B * chunk.length) / (index.averageLength || 1));
      const contribution = idf * ((tf * (K1 + 1)) / denominator);
      scores.set(index_, (scores.get(index_) ?? 0) + contribution * weight);
    }
  }

  const mode = options.rerankMode ?? "none";
  const useSymbolBoost = mode === "symbol-boost" || mode === "structure-aware";
  const useStructure = mode === "structure-aware";

  const boostOf = (chunk: IndexedChunk): number => symbolBoost(chunk, scoringTerms);

  /**
   * 结构感知加成的第二个来源：文件路径。
   *
   * BM25 把路径和正文混在一个词袋里，路径里的词权重和正文一样。
   * 但路径是比正文更可靠的结构信号——问题里点名了某个模块，
   * 这个模块里的代码块就该排前面。所以路径里的词单独加权，
   * 而且整条路径（app.py）当成一个 token 精确命中。
   */
  const structureOf = (chunk: IndexedChunk): number => {
    let bonus = 0;
    for (const { token, weight } of scoringTerms) {
      if (chunk.pathTokens.has(token)) bonus += PATH_FIELD_BOOST * weight;
      else if (chunk.symbolTokens.has(token)) bonus += SYMBOL_FIELD_BOOST * weight;
    }
    for (const compound of chunk.compoundPaths) {
      if (queryCompounds.has(compound)) {
        bonus += COMPOUND_PATH_BOOST;
        break;
      }
    }
    return bonus;
  };

  const ranked = [...scores.entries()].map(([chunkIndex, score]) => ({
    chunk: index.chunks[chunkIndex],
    score,
  }));

  if (useSymbolBoost) {
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

  if (useStructure) {
    const extra = new Map<number, number>();
    for (const [chunkIndex, chunk] of index.chunks.entries()) {
      const bonus = structureOf(chunk);
      if (bonus > 0) extra.set(chunkIndex, bonus);
    }
    const known = new Set(ranked.map((item) => item.chunk.id));
    for (const [chunkIndex, bonus] of extra) {
      const chunk = index.chunks[chunkIndex];
      const hit = ranked.find((item) => item.chunk.id === chunk.id);
      if (hit) hit.score += bonus;
      else if (!known.has(chunk.id)) ranked.push({ chunk, score: bonus });
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
