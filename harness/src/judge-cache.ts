/**
 * judge 自检结果的复用。
 *
 * 自检的结论只跟三件事有关：哪把尺子、考的哪批题、哪一版代码。
 * 这三样都没变的话，上次跑出来的结果就是这次的结果——
 * 再跑一遍既花钱，又给同一个数字加一份噪声。
 *
 * 所以这里按这三样算出指纹，把结果存下来，下次直接取。
 * 换了尺子、换了题、或者改了打分口径，指纹就变，自检照跑。
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CODE_VERSION, type EvalDataset } from "./schema.ts";
import type { JudgeValidationResult } from "./judge-validation.ts";

/** 缓存文件名。点开头：产物列表里不显示它。 */
const CACHE_FILE = ".judge-checks.json";

interface CacheEntry {
  createdAt: string;
  result: JudgeValidationResult;
}

type CacheFile = Record<string, CacheEntry>;

/**
 * 自检结果的指纹。
 *
 * 抽样范围也跟着算进去：只跑前 3 题的自检不能拿去当全量自检用，
 * 两者考的不是同一批题。
 */
export function judgeCheckKey(
  dataset: EvalDataset,
  limit: number | undefined,
  judge: { model: string; baseUrl: string },
): string {
  const scope =
    limit && limit > 0
      ? dataset.questions.slice(0, limit)
      : dataset.questions;
  const sampled = scope
    .filter((question) => question.humanScore !== undefined)
    .map((question) => `${question.id}:${question.humanScore}`);
  const payload = JSON.stringify({
    codeVersion: CODE_VERSION,
    datasetId: dataset.id,
    judge: { model: judge.model, baseUrl: judge.baseUrl },
    sampled,
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

async function readCache(outDir: string): Promise<CacheFile> {
  try {
    const raw = await readFile(join(outDir, CACHE_FILE), "utf8");
    const parsed = JSON.parse(raw) as CacheFile;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // 没有缓存或者缓存坏了，都当没有
    return {};
  }
}

/** 取出之前跑过的自检结果，没有就返回 undefined。 */
export async function readJudgeCheck(
  outDir: string,
  key: string,
): Promise<CacheEntry | undefined> {
  const cache = await readCache(outDir);
  const entry = cache[key];
  if (!entry?.result?.summary) return undefined;
  // 自检一次都没打上分的缓存没有价值，留着只会把失败固化下来
  if (!entry.result.summary.sampled) return undefined;
  return entry;
}

/** 把这次的自检结果记下来，下次同一把尺子同一批题直接用。 */
export async function writeJudgeCheck(
  outDir: string,
  key: string,
  result: JudgeValidationResult,
): Promise<void> {
  const cache = await readCache(outDir);
  cache[key] = { createdAt: new Date().toISOString(), result };
  await mkdir(outDir, { recursive: true });
  await writeFile(
    join(outDir, CACHE_FILE),
    JSON.stringify(cache, null, 2),
    "utf8",
  );
}
