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
import { readFile, readdir, writeFile, mkdir, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { runRetrievalEval } from "./retrieval-eval.ts";
import { validateDataset } from "./dataset-validate.ts";
import { DEFAULT_RETRIEVAL, STRATEGY_LIST } from "./strategies.ts";
import { CODE_VERSION } from "./schema.ts";
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

export async function serve(options: ServeOptions): Promise<void> {
  const { workbenchRoot, storyRoot, datasetsRoot, defaultRepoRoot } = options;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;

    try {
      if (path === "/api/health") {
        sendJson(res, 200, {
          mode: "local",
          codeVersion: CODE_VERSION,
          defaultRepoRoot,
          datasets: await listDatasets(datasetsRoot),
        });
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
        const body = (await readBody(req)) as { dataset: EvalDataset };
        const id = body.dataset.id?.trim();
        if (!id) throw new Error("数据集缺少 id");
        const file = join(datasetsRoot, safeDatasetName(id));
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
