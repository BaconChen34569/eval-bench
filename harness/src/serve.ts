/**
 * 本地工作台服务。
 *
 * 公开站点是给评委看的叙事页；这个服务给的是「工具」：
 * 打开就是填数据和看结果，不用先读一遍介绍。
 *
 * 它做两件事：
 * 1. 静态托管 site/dist（站点构建产物），所以页面和公开站共用同一套组件；
 * 2. 提供几个 API，让页面能直接调用真正的评测代码，
 *    而不是把检索算法抄一份到浏览器里。
 *
 *   node --experimental-strip-types src/cli.ts serve [--port 8787]
 *
 * 只监听 127.0.0.1：这是用户自己机器上的本地工具，不对外暴露。
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, readdir, writeFile, mkdir, stat, chmod } from "node:fs/promises";
import { extname, join, resolve, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runRetrievalEval } from "./retrieval-eval.ts";
import { validateDataset } from "./dataset-validate.ts";
import { DEFAULT_RETRIEVAL, STRATEGY_LIST } from "./strategies.ts";
import { CODE_VERSION } from "./schema.ts";
import { buildLlmConfig, listModels, probeChat, type LlmConfig } from "./llm.ts";
import { discoverProfiles } from "./profiles.ts";
import { lookupBuiltinPrice } from "./pricing.ts";
import { isKnownVendor, knownModelsFor } from "./vendors.ts";
import type { EvalDataset } from "./schema.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export interface ServeOptions {
  port: number;
  /** site/dist-local 的绝对路径，本地工作台页面 */
  workbenchRoot: string;
  /** site/dist 的绝对路径，公开站那一版 */
  storyRoot: string;
  /** harness/datasets 的绝对路径 */
  datasetsRoot: string;
  /** 页面默认填的仓库路径 */
  defaultRepoRoot: string;
}

/** 从 src/ 往上两级就是 harness/ 目录。 */
export const HARNESS_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > 32 * 1024 * 1024) throw new Error("请求体过大");
    chunks.push(buffer);
  }
  if (!chunks.length) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** 题集文件名的白名单：只允许字母、数字、连字符、下划线和点。 */
function safeDatasetName(id: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id.includes("..")) {
    throw new Error(`数据集 id 不合法：${id}`);
  }
  return `${id}.json`;
}

interface DatasetSummary {
  id: string;
  /** 磁盘上的文件名（不含扩展名），和数据集里的 id 可能不是一回事 */
  file: string;
  language: string;
  repo: string;
  questions: number;
  createdAt: string;
}

async function listDatasets(datasetsRoot: string): Promise<DatasetSummary[]> {
  let files: string[] = [];
  try {
    files = await readdir(datasetsRoot);
  } catch {
    return [];
  }
  const summaries: DatasetSummary[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(
        await readFile(join(datasetsRoot, file), "utf8"),
      ) as EvalDataset;
      summaries.push({
        id: raw.id ?? file.replace(/\.json$/, ""),
        file: file.replace(/\.json$/, ""),
        language: raw.language ?? "",
        repo: raw.repo ?? "",
        questions: raw.questions?.length ?? 0,
        createdAt: raw.createdAt ?? "",
      });
    } catch {
      // 坏掉的文件不进列表，但也不能让整个服务起不来
    }
  }
  return summaries.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * 按 id 或文件名找题集文件。
 *
 * 数据集里的 id 和文件名不一定一致（flask.json 里写的 id 是 flask-v1），
 * 所以两种都认：先按文件名找，找不到再按文件内容里的 id 找。
 */
async function resolveDatasetFile(
  datasetsRoot: string,
  id: string,
): Promise<string> {
  const direct = join(datasetsRoot, safeDatasetName(id));
  try {
    await stat(direct);
    return direct;
  } catch {
    // 落到下面按内容里的 id 找
  }

  const summaries = await listDatasets(datasetsRoot);
  const match = summaries.find((item) => item.id === id);
  if (!match) throw new Error(`没有这份题集：${id}`);
  return join(datasetsRoot, safeDatasetName(match.file));
}

/**
 * 静态文件：解析路径后必须仍在 root 之内，否则拒绝。
 * 本地服务也要防目录穿越——页面上传的路径不该能读到站点目录以外的文件。
 */
async function serveStatic(
  res: ServerResponse,
  root: string,
  urlPath: string,
  indexFile: string,
): Promise<void> {
  let relative = decodeURIComponent(urlPath);
  if (relative === "/" || relative === "") relative = `/${indexFile}`;

  const target = resolve(root, `.${relative}`);
  if (target !== root && !target.startsWith(root + sep)) {
    res.writeHead(403).end("禁止访问");
    return;
  }

  try {
    const info = await stat(target);
    if (info.isDirectory()) throw new Error("是目录");
    const content = await readFile(target);
    res.writeHead(200, {
      "content-type": MIME[extname(target).toLowerCase()] ?? "application/octet-stream",
      "content-length": content.length,
      "cache-control": "no-cache",
    });
    res.end(content);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("404");
  }
}

/**
 * 评测产物目录：命令行默认把 report.json 写到这里。
 * 页面按这个目录找文件，用户不用自己到处翻。
 */
const OUT_DIR = join(HARNESS_ROOT, "out");

export interface ReportFile {
  /** 相对产物目录的路径，比如 report.json 或 history/report-xxx.json */
  name: string;
  /** 绝对路径，页面直接显示出来，用户能照着去磁盘上找 */
  path: string;
  size: number;
  mtime: string;
  /** true 表示这是一次历史留存的副本 */
  isHistory: boolean;
  /** report = 能直接载入出图；other = 中间产物，载进来也画不出图 */
  kind: "report" | "other";
}

/**
 * 判断一份产物能不能直接载入出图。
 *
 * 产物目录里除了报告还有一堆中间产物（对比表、多项目汇总），
 * 它们没有 strategies 数组，载进来是画不出图的。
 */
async function classifyReport(path: string, size: number): Promise<"report" | "other"> {
  // 超大的文件不解析：产物目录是本地磁盘，读一遍 1MB 出不了事，
  // 但没必要为了分类把几兆的文件全读进来。
  if (size > 8 * 1024 * 1024) return "other";
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && Array.isArray((parsed as { strategies?: unknown }).strategies)
      ? "report"
      : "other";
  } catch {
    return "other";
  }
}

/**
 * 列出评测产物。
 *
 * 除了当前的 report.json，也把 history/ 下的历史副本列出来：
 * 每次跑评测都会留一份带时间戳的副本，用户想看哪一次都能直接载入。
 */
async function listReports(): Promise<{ outDir: string; files: ReportFile[] }> {
  const files: ReportFile[] = [];

  const push = async (
    dir: string,
    prefix: string,
    isHistory: boolean,
  ): Promise<void> => {
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const path = join(dir, name);
      try {
        const info = await stat(path);
        if (!info.isFile()) continue;
        files.push({
          name: `${prefix}${name}`,
          path,
          size: info.size,
          mtime: new Date(info.mtimeMs).toISOString(),
          isHistory,
          kind: await classifyReport(path, info.size),
        });
      } catch {
        // 读不到就跳过，不影响别的文件
      }
    }
  };

  await push(OUT_DIR, "", false);
  await push(join(OUT_DIR, "history"), "history/", true);

  // 新的在前；report.json 排最前，历史副本统一沉到末尾。
  files.sort((a, b) => {
    if (a.isHistory !== b.isHistory) return a.isHistory ? 1 : -1;
    if (a.name === "report.json") return -1;
    if (b.name === "report.json") return 1;
    return b.mtime.localeCompare(a.mtime);
  });

  return { outDir: OUT_DIR, files };
}

/**
 * 读一份评测产物。
 *
 * 只允许读产物目录以内的文件：路径拼好之后必须还在 out 目录里，
 * 否则页面可以用 ../ 之类的路径把服务外面的文件读走。
 */
async function readReport(name: string): Promise<unknown> {
  const target = resolve(OUT_DIR, name);
  if (target !== OUT_DIR && !target.startsWith(OUT_DIR + sep)) {
    throw new Error("只能读评测产物目录里的文件");
  }
  const content = await readFile(target, "utf8");
  return JSON.parse(content);
}

/**
 * 只接受本机同源的请求。
 *
 * 服务只监听 127.0.0.1，但浏览器里的任何网页都能往这个地址发请求：
 * 没有这道校验，用户开着工作台时随手点开一个恶意网页，
 * 它就能往 harness/.env 里塞东西，或者把磁盘目录列出来。
 * 所以看 Host 和 Origin：不是本机的一律拒绝。
 */
function isLocalRequest(req: IncomingMessage): boolean {
  const allowed = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
  const host = (req.headers.host ?? "").toLowerCase();
  if (!allowed.test(host)) return false;

  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return allowed.test(new URL(origin).host.toLowerCase());
  } catch {
    return false;
  }
}

export interface DirEntry {
  name: string;
  path: string;
  /** 看着像个代码仓库（有 .git 或 pyproject.toml / setup.py） */
  looksLikeRepo: boolean;
}

export interface DirListing {
  /** 当前浏览的目录 */
  path: string;
  /** 上一级，没有就是 null（已经在盘根） */
  parent: string | null;
  /** 只有子目录，文件不列出来 */
  entries: DirEntry[];
  /** 盘符（Windows）或空 */
  drives: string[];
  /** 用户主目录 */
  home: string;
  /** 快捷入口：默认仓库和语料目录 */
  hints: { defaultRepoRoot: string; corpusRepos: string };
}

/** 仓库根目录常见的标志文件。 */
const REPO_MARKERS = [".git", "pyproject.toml", "setup.py", "package.json"];

async function looksLikeRepo(path: string): Promise<boolean> {
  for (const marker of REPO_MARKERS) {
    try {
      await stat(join(path, marker));
      return true;
    } catch {
      // 没有这个标志，继续看下一个
    }
  }
  return false;
}

async function listDrives(): Promise<string[]> {
  if (process.platform !== "win32") return [];
  const found: string[] = [];
  for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZAB") {
    const root = `${letter}:\\`;
    try {
      const info = await stat(root);
      if (info.isDirectory()) found.push(root);
    } catch {
      // 没插这个盘
    }
  }
  return found;
}

/**
 * 列一个目录下的子目录。
 *
 * 只列目录，不列文件，也不读文件内容：
 * 这一层要做的只是让用户挑一个仓库根目录。
 */
async function listDirectories(
  target: string,
  hints: { defaultRepoRoot: string; corpusRepos: string },
): Promise<DirListing> {
  const path = resolve(target);
  const info = await stat(path);
  if (!info.isDirectory()) {
    throw new Error(`${path} 不是一个目录`);
  }

  const names = await readdir(path);
  const entries: DirEntry[] = [];
  // 目录太深太多时只列前面一部分，免得页面被几千个条目淹了。
  for (const name of names.sort().slice(0, 500)) {
    const child = join(path, name);
    let isDir = false;
    try {
      const childInfo = await stat(child);
      isDir = childInfo.isDirectory();
    } catch {
      // 断链或者权限不够，跳过
    }
    if (!isDir) continue;
    entries.push({
      name,
      path: child,
      looksLikeRepo: await looksLikeRepo(child),
    });
  }

  const parent = dirname(path);
  return {
    path,
    parent: parent === path ? null : parent,
    entries,
    drives: await listDrives(),
    home: process.env.HOME ?? process.env.USERPROFILE ?? path,
    hints,
  };
}

/**
 * 密钥文件位置。
 *
 * 用当前工作目录，和命令行读 .env 的方式保持一致：
 * 命令行在哪个目录跑，就读哪个目录的 .env。
 */
export const ENV_PATH = join(process.cwd(), ".env");

/** 页面能写的字段：驼峰名字 → .env 里的变量后缀。 */
const WRITABLE_FIELDS = [
  { key: "apiKey", field: "API_KEY" },
  { key: "baseUrl", field: "BASE_URL" },
  { key: "model", field: "MODEL" },
  { key: "label", field: "LABEL" },
] as const;
type WritableField = (typeof WRITABLE_FIELDS)[number]["field"];

/** 档案前缀：只允许大写字母、数字和下划线。 */
const PREFIX_PATTERN = /^[A-Z][A-Z0-9_]{0,15}$/;

function parseEnvFile(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const split = trimmed.indexOf("=");
    if (split <= 0) continue;
    const key = trimmed.slice(0, split).trim();
    let value = trimmed.slice(split + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }
  return values;
}

function envRecord(values: Map<string, string>): Record<string, string> {
  return Object.fromEntries(values);
}

/** 写回 .env 用的值格式：有空格或 # 就加引号，免得被当成注释。 */
function formatEnvValue(value: string): string {
  if (value === "") return "";
  if (!/[\s#"']/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export interface SecretProfileStatus {
  id: string;
  prefix: string;
  label: string;
  baseUrl: string;
  model: string;
  /** 三个必填字段都齐了 */
  configured: boolean;
  /** 还缺哪些字段（只列字段名，不含值） */
  missing: string[];
}

export interface SecretStatus {
  envPath: string;
  exists: boolean;
  profiles: SecretProfileStatus[];
}

async function readEnvText(): Promise<string> {
  try {
    return await readFile(ENV_PATH, "utf8");
  } catch {
    return "";
  }
}

/**
 * 读 .env 里的档案状态。
 *
 * 只回传「有没有配、缺哪几个字段、接口和模型是什么」，
 * 密钥本身一个字节都不往外送：页面不需要知道它，浏览器更不该拿到它。
 */
async function secretStatus(): Promise<SecretStatus> {
  const text = await readEnvText();
  const values = parseEnvFile(text);
  const profiles = discoverProfiles(envRecord(values)).map((profile) => ({
    id: profile.id,
    prefix: profile.prefix,
    label: profile.label,
    baseUrl: profile.baseUrl,
    model: profile.model,
    configured: profile.missing.length === 0 && Boolean(profile.config),
    missing: profile.missing,
  }));
  return {
    envPath: ENV_PATH,
    exists: values.size > 0,
    profiles,
  };
}

/** 把一组字段写进 .env，保留原有的注释和顺序。 */
async function writeEnvValues(
  updates: { prefix: string; field: WritableField; value: string }[],
): Promise<void> {
  let text = await readEnvText();
  if (!text.trim()) {
    // 没有 .env 就拿模板起一份：用户填完密钥，其他家服务商也在里面。
    try {
      text = await readFile(join(HARNESS_ROOT, ".env.example"), "utf8");
    } catch {
      text = "";
    }
  }

  const lines = text.split(/\r?\n/);
  for (const update of updates) {
    const key = `${update.prefix}_${update.field}`;
    const line = `${key}=${formatEnvValue(update.value)}`;
    const index = lines.findIndex(
      (item) => item.trim().split("=")[0].trim() === key,
    );
    if (index >= 0) lines[index] = line;
    else lines.push(line);
  }

  await mkdir(dirname(ENV_PATH), { recursive: true });
  await writeFile(ENV_PATH, `${lines.join("\n").replace(/\n+$/, "")}\n`, "utf8");
  // .env 里是明文密钥，权限收到只有自己能读（Windows 上这步无效，NTFS 另说）。
  try {
    await chmod(ENV_PATH, 0o600);
  } catch {
    // 权限改不了就算了，不影响功能
  }
}

/**
 * 校验一个档案前缀和它要写的字段。
 *
 * 值里不许有换行：换行能往 .env 里塞进额外的内容，
 * 那就等于允许页面往用户的 .env 里写任意东西。
 */
function parseSecretPayload(body: unknown): {
  prefix: string;
  updates: { prefix: string; field: WritableField; value: string }[];
  testKey?: string;
  /** true = 测 .env 里已经存好的那个档案，允许用存着的密钥 */
  useStoredKey?: boolean;
} {
  const input = (body ?? {}) as Record<string, unknown>;
  const prefix = String(input.prefix ?? "").trim().toUpperCase();
  if (!PREFIX_PATTERN.test(prefix)) {
    throw new Error("档案前缀不合法：只能用大写字母、数字和下划线");
  }

  const updates: { prefix: string; field: WritableField; value: string }[] = [];
  for (const { key, field } of WRITABLE_FIELDS) {
    if (!(key in input)) continue;
    const value = String(input[key] ?? "");
    if (/[\r\n]/.test(value)) {
      throw new Error(`${key} 里不能有换行`);
    }
    if (value.length > 512) {
      throw new Error(`${key} 太长了`);
    }
    updates.push({ prefix, field, value: value.trim() });
  }

  const testKey = typeof input.testKey === "string" ? input.testKey.trim() : "";
  const useStoredKey = input.useStoredKey === true;
  return { prefix, updates, testKey: testKey || undefined, useStoredKey };
}

/** 接口上的一个模型，带上价格信息，页面据此标出哪些要花钱。 */
export interface SecretModel {
  id: string;
  /** 已知要花钱为 true，已知免费为 false，查不到价格时为 null */
  paid: boolean | null;
  price?: { prompt: number; completion: number; currency: string };
}

/**
 * 给一个模型 id 配上价格。
 *
 * 先看内置价目表；这个档案自己在 .env 里写了单价、
 * 而模型正好是这个档案默认那个模型时，以 .env 为准。
 * 两边都查不到就标成「不知道」——宁可不说，也不给一个错的数字。
 */
function describeSecretModel(
  id: string,
  envPrice: { prompt: number; completion: number; currency: string } | undefined,
): SecretModel {
  const price = envPrice ?? lookupBuiltinPrice(id);
  if (!price) return { id, paid: null };
  return {
    id,
    paid: price.prompt > 0 || price.completion > 0,
    price: {
      prompt: price.prompt,
      completion: price.completion,
      currency: price.currency,
    },
  };
}

/**
 * 拼出这次测试用的配置。
 *
 * .env 里的值打底，testKey 和表单里的接口地址、模型只是这一次测试的覆盖值，
 * 不写盘。第一次配一家新服务商时 .env 里还没有它的接口地址，
 * 光看 .env 就会一直报「还没填接口地址」。
 *
 * 密钥是例外：表单里的「测试连通」只认这次填的那把密钥（useStoredKey 为假），
 * 不会拿 .env 里存着的旧密钥去问——不然用户明明没填密钥，
 * 也会看到一句「配置可用」，以为自己配的是新密钥。
 */
async function configForTest(
  prefix: string,
  testKey?: string,
  override?: { baseUrl?: string; model?: string },
  options?: { useStoredKey?: boolean },
): Promise<{
  config: LlmConfig;
  values: Record<string, string>;
  /** .env 里这个档案原本配的模型，不含本次测试的覆盖值 */
  envModel: string;
  /** 这次实际用的是 .env 里存着的密钥，不是这次传进来的 */
  usedStoredKey: boolean;
}> {
  const values = envRecord(parseEnvFile(await readEnvText()));
  const envModel = values[`${prefix}_MODEL`]?.trim() ?? "";
  const storedKey = values[`${prefix}_API_KEY`]?.trim() ?? "";
  let usedStoredKey = false;
  if (options?.useStoredKey) {
    if (testKey) {
      values[`${prefix}_API_KEY`] = testKey;
    } else {
      usedStoredKey = Boolean(storedKey);
    }
  } else {
    values[`${prefix}_API_KEY`] = testKey ?? "";
  }
  if (override?.baseUrl) values[`${prefix}_BASE_URL`] = override.baseUrl;
  if (override?.model) values[`${prefix}_MODEL`] = override.model;
  return { config: buildLlmConfig(values, prefix), values, envModel, usedStoredKey };
}

/**
 * .env 里给这个档案写死的单价。
 *
 * 只在档案自己那个模型上生效：.env 里的单价是给 `LLM_MODEL` 那个模型写的，
 * 换成别的模型还沿用它，报出来的成本就是错的。
 */
function envPriceFor(
  values: Record<string, string>,
  prefix: string,
  model: string,
): { prompt: number; completion: number; currency: string } | undefined {
  const prompt = Number(values[`${prefix}_PRICE_PROMPT`]);
  const completion = Number(values[`${prefix}_PRICE_COMPLETION`]);
  if (!Number.isFinite(prompt) || !model) return undefined;
  return {
    prompt,
    completion: Number.isFinite(completion) ? completion : 0,
    currency: values[`${prefix}_PRICE_CURRENCY`]?.trim() || "¥",
  };
}

/**
 * 测连通：用当前配置真的问一次模型。
 *
 * 这不是「这家厂商有哪些模型」，而是「你现在这套配置能不能用」——
 * 接口地址、密钥、模型 id 三样都要对才算通过。
 */
async function probeConfig(
  prefix: string,
  testKey?: string,
  override?: { baseUrl?: string; model?: string },
  options?: { useStoredKey?: boolean },
): Promise<{
  ok: boolean;
  latencyMs?: number;
  error?: string;
  model?: string;
  price?: { prompt: number; completion: number; currency: string };
}> {
  const { config, values, envModel } = await configForTest(
    prefix,
    testKey,
    override,
    options,
  );
  if (!config.baseUrl) {
    return { ok: false, error: "还没填接口地址" };
  }
  if (!config.apiKey) {
    return { ok: false, error: "还没填密钥" };
  }
  if (!config.model) {
    return { ok: false, error: "还没选模型" };
  }
  const probe = await probeChat(config);
  if (!probe.ok) {
    return {
      ok: false,
      latencyMs: probe.latencyMs,
      error: explainProbeError(probe.detail),
    };
  }
  return {
    ok: true,
    latencyMs: probe.latencyMs,
    model: config.model,
    // .env 里的单价只属于它自己配的那个模型，换了模型就查内置价目表。
    price: describeSecretModel(
      config.model,
      config.model === envModel
        ? envPriceFor(values, prefix, config.model)
        : undefined,
    ).price,
  };
}

/**
 * 把探测的失败翻译成人能看懂的话。
 *
 * 401 是密钥不对，404 多半是接口地址填错或者少了 /v1 这类后缀，
 * 400 常常是模型 id 服务商不认——这三样要分清楚，不能一句「连不上」了事。
 */
function explainProbeError(detail?: string): string {
  const message = detail ?? "连不上";
  const status = /\((\d{3})\)/.exec(message)?.[1];
  if (status === "401" || status === "403") {
    return "密钥没通过鉴权，检查一下是不是复制漏了字符";
  }
  if (status === "404") {
    return "接口地址不对：404。检查一下是不是少了 /v1 这样的后缀";
  }
  if (status === "400" && /model/i.test(message)) {
    return "这个模型 id 服务商不认，换一个模型试试";
  }
  return message;
}

/**
 * 问服务商要一份最新的模型列表。
 *
 * 这一步要密钥（服务商的 /models 都得鉴权），
 * 和「测连通」是两件事：这里只负责列模型，通不通由测连通说了算。
 *
 * 拉列表不花钱，所以允许用 .env 里存着的密钥：
 * 已经配好的档案不用每次都把密钥再敲一遍。
 */
async function listSecretModels(
  prefix: string,
  testKey?: string,
  override?: { baseUrl?: string; model?: string },
): Promise<{
  ok: boolean;
  models: SecretModel[];
  error?: string;
  /** 这次没传密钥，用的是 .env 里存着的那把 */
  usedStoredKey?: boolean;
}> {
  const { config, values, envModel, usedStoredKey } = await configForTest(
    prefix,
    testKey,
    override,
    { useStoredKey: true },
  );
  if (!config.baseUrl) {
    return { ok: false, models: [], error: "还没填接口地址" };
  }
  if (!config.apiKey) {
    return { ok: false, models: [], error: "还没填密钥" };
  }
  try {
    const listed = await listModels(config);
    // 服务商自己列的 + 我们已知但它没列的（智谱的免费模型就是这种）。
    const models = [
      ...listed,
      ...knownModelsFor(config.baseUrl).filter((id) => !listed.includes(id)),
    ];
    return {
      ok: true,
      usedStoredKey,
      models: models.map((id) =>
        describeSecretModel(
          id,
          // .env 里的单价只属于它自己配的那个模型。
          id === envModel ? envPriceFor(values, prefix, envModel) : undefined,
        ),
      ),
    };
  } catch (error) {
    return {
      ok: false,
      models: [],
      error: explainModelListError(error),
    };
  }
}

/**
 * 把取模型列表的失败翻译成人能看懂的话。
 *
 * 有些厂商压根没开放 /models，这时候说「接口地址错了」会把人带偏——
 * 接口其实是通的，只是列不出模型，手填模型 id 照样能用。
 */
function explainModelListError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const status = /\((\d{3})\)/.exec(message)?.[1];
  if (status === "404" || status === "410") {
    return "这家厂商没有开放模型列表接口，请手动填写模型 id";
  }
  if (status === "401" || status === "403") {
    return "密钥没通过鉴权，检查一下是不是复制漏了字符";
  }
  return message;
}

export async function serve(options: ServeOptions): Promise<void> {
  const { workbenchRoot, storyRoot, datasetsRoot, defaultRepoRoot } = options;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;

    try {
      // 只接本机同源的请求：工作台开着的时候，用户点开的别的网页
      // 不该能通过浏览器改写 .env 或列磁盘目录。
      if (path.startsWith("/api/") && !isLocalRequest(req)) {
        sendJson(res, 403, { error: "只接受本机工作台的请求" });
        return;
      }

      if (path === "/api/health") {
        sendJson(res, 200, {
          mode: "local",
          codeVersion: CODE_VERSION,
          defaultRepoRoot,
          outDir: OUT_DIR,
          envPath: ENV_PATH,
          datasets: await listDatasets(datasetsRoot),
        });
        return;
      }

      if (path === "/api/dirs" && req.method === "GET") {
        const target = url.searchParams.get("path")?.trim() || defaultRepoRoot;
        const listing = await listDirectories(target, {
          defaultRepoRoot,
          corpusRepos: resolve(HARNESS_ROOT, "..", "corpus", "repos"),
        });
        sendJson(res, 200, listing);
        return;
      }

      if (path === "/api/secrets" && req.method === "GET") {
        sendJson(res, 200, await secretStatus());
        return;
      }

      if (path === "/api/secrets" && req.method === "POST") {
        const body = await readBody(req);
        const { prefix, updates } = parseSecretPayload(body);
        if (!updates.length) throw new Error("没有要保存的内容");
        const keyUpdate = updates.find((item) => item.field === "API_KEY");
        if (keyUpdate && !keyUpdate.value) {
          throw new Error("密钥不能是空的");
        }
        await writeEnvValues(updates);
        sendJson(res, 200, {
          ok: true,
          envPath: ENV_PATH,
          status: await secretStatus(),
        });
        return;
      }

      if (path === "/api/secrets" && req.method === "DELETE") {
        const body = (await readBody(req)) as { prefix?: string };
        const prefix = String(body.prefix ?? "").trim().toUpperCase();
        if (!PREFIX_PATTERN.test(prefix)) throw new Error("档案前缀不合法");
        await writeEnvValues([{ prefix, field: "API_KEY", value: "" }]);
        sendJson(res, 200, {
          ok: true,
          envPath: ENV_PATH,
          status: await secretStatus(),
        });
        return;
      }

      if (path === "/api/secrets/test" && req.method === "POST") {
        const body = await readBody(req);
        const { prefix, updates, testKey, useStoredKey } =
          parseSecretPayload(body);
        // 表单里填的接口地址和模型一起带过来，
        // 第一次配一家新服务商时 .env 里还没有它们。
        const override = {
          baseUrl: updates.find((item) => item.field === "BASE_URL")?.value,
          model: updates.find((item) => item.field === "MODEL")?.value,
        };
        sendJson(
          res,
          200,
          await probeConfig(prefix, testKey, override, { useStoredKey }),
        );
        return;
      }

      if (path === "/api/secrets/models" && req.method === "GET") {
        // 这家厂商已知的模型，不需要密钥。
        const baseUrl = url.searchParams.get("baseUrl") ?? "";
        const ids = knownModelsFor(baseUrl);
        sendJson(res, 200, {
          ok: ids.length > 0,
          known: isKnownVendor(baseUrl),
          models: ids.map((id) => describeSecretModel(id, undefined)),
        });
        return;
      }

      if (path === "/api/secrets/models" && req.method === "POST") {
        // 向服务商要一份最新的模型列表，这一步要密钥。
        const body = await readBody(req);
        const { prefix, updates, testKey } = parseSecretPayload(body);
        const override = {
          baseUrl: updates.find((item) => item.field === "BASE_URL")?.value,
          model: updates.find((item) => item.field === "MODEL")?.value,
        };
        sendJson(res, 200, await listSecretModels(prefix, testKey, override));
        return;
      }

      if (path === "/api/secrets/price" && req.method === "GET") {
        const id = (url.searchParams.get("model") ?? "").trim();
        if (!id) throw new Error("没给模型 id");
        sendJson(res, 200, describeSecretModel(id, undefined));
        return;
      }

      if (path === "/api/reports" && req.method === "GET") {
        sendJson(res, 200, await listReports());
        return;
      }

      if (path === "/api/report" && req.method === "GET") {
        const name = url.searchParams.get("file") ?? "report.json";
        sendJson(res, 200, await readReport(name));
        return;
      }

      if (path === "/api/dataset" && req.method === "GET") {
        const id = url.searchParams.get("id") ?? "";
        const file = await resolveDatasetFile(datasetsRoot, id);
        const dataset = JSON.parse(await readFile(file, "utf8")) as EvalDataset;
        sendJson(res, 200, dataset);
        return;
      }

      if (path === "/api/validate" && req.method === "POST") {
        const body = (await readBody(req)) as {
          dataset: EvalDataset;
          repoRoot?: string;
        };
        const repoRoot = body.repoRoot?.trim() || defaultRepoRoot;
        const result = await validateDataset(body.dataset, repoRoot);
        sendJson(res, 200, { ...result, repoRoot });
        return;
      }

      if (path === "/api/evaluate" && req.method === "POST") {
        const body = (await readBody(req)) as {
          dataset: EvalDataset;
          repoRoot?: string;
        };
        const repoRoot = body.repoRoot?.trim() || defaultRepoRoot;
        const strategies = await runRetrievalEval({
          dataset: body.dataset,
          repoRoot,
          strategies: STRATEGY_LIST,
          retrieval: DEFAULT_RETRIEVAL,
        });
        sendJson(res, 200, {
          datasetId: body.dataset.id,
          repo: body.dataset.repo,
          repoRoot,
          codeVersion: CODE_VERSION,
          strategies,
        });
        return;
      }

      if (path === "/api/save-dataset" && req.method === "POST") {
        const body = (await readBody(req)) as {
          dataset: EvalDataset;
          file?: string;
        };
        const id = body.dataset.id?.trim();
        if (!id) throw new Error("数据集缺少 id");
        // file 用来指明写回哪个文件：题集里的 id 和文件名不一定一样
        // （flask.json 里的 id 是 flask-v1），写回原来那个文件才不产生重复副本。
        const name = body.file?.trim() || id;
        const file = join(datasetsRoot, safeDatasetName(name));
        await mkdir(datasetsRoot, { recursive: true });
        await writeFile(file, JSON.stringify(body.dataset, null, 2), "utf8");
        sendJson(res, 200, { path: file });
        return;
      }

      if (path.startsWith("/api/")) {
        sendJson(res, 404, { error: "没有这个接口" });
        return;
      }

      // /story 是公开站那一版（叙事页），其余路径都是本地工作台。
      // 叙事页的 index.html 里资源路径是绝对路径 /assets/xxx.js，
      // 而工作台的构建产物用的是 /local-assets/，所以 /assets 一律回叙事站取。
      if (path === "/story" || path.startsWith("/story/")) {
        const relative = path.slice("/story".length) || "/";
        await serveStatic(res, storyRoot, relative, "index.html");
        return;
      }

      if (path.startsWith("/assets/")) {
        await serveStatic(res, storyRoot, path, "index.html");
        return;
      }

      await serveStatic(res, workbenchRoot, path, "local.html");
    } catch (error) {
      sendJson(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await new Promise<void>((resolveListen) => {
    server.listen(options.port, "127.0.0.1", resolveListen);
  });

  console.log("本地工作台已启动：");
  console.log(`  http://127.0.0.1:${options.port}/`);
  console.log("");
  console.log("  /         填数据、跑评测（没有介绍内容）");
  console.log("  /story    公开站那一版（叙事页）");
  console.log("");
  console.log("按 Ctrl+C 结束。");
}
