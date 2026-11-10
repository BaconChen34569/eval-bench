/**
 * 本地工作台和 harness 之间的接口。
 *
 * 页面不自己算召回率，也不自己判断证据行号对不对：
 * 这些都交给 harness 里那份和命令行同一套的代码，
 * 所以工作台出的数字和命令行跑出来的数字必然一致。
 */

import type {
  Difficulty,
  EvidenceRef,
  ExperimentReport,
  QuestionCategory,
  StrategyMetrics,
} from "@/data/report";

export interface DatasetSummary {
  id: string;
  /** 磁盘上的文件名（不含扩展名） */
  file: string;
  language: string;
  repo: string;
  questions: number;
  createdAt: string;
}

export interface Health {
  mode: string;
  codeVersion: string;
  defaultRepoRoot: string;
  /** 评测产物目录，命令行跑出来的 report.json 就在这儿 */
  outDir: string;
  /** 密钥文件位置 */
  envPath: string;
  datasets: DatasetSummary[];
}

/** 评测产物目录下的一个文件。 */
export interface ReportFile {
  /** 相对产物目录的路径，比如 report.json 或 history/report-xxx.json */
  name: string;
  /** 绝对路径，页面直接显示给用户看 */
  path: string;
  size: number;
  mtime: string;
  isHistory: boolean;
  /** report = 能直接载入出图；other = 中间产物 */
  kind: "report" | "other";
}

export interface ReportList {
  outDir: string;
  files: ReportFile[];
}

export interface ValidateResult {
  problems: string[];
  warnings: string[];
  repoRoot: string;
}

/** 目录下的一个子目录。 */
export interface DirEntry {
  name: string;
  path: string;
  /** 看着像个代码仓库（有 .git 或 pyproject.toml / setup.py） */
  looksLikeRepo: boolean;
}

/** 一次目录浏览的结果。 */
export interface DirListing {
  path: string;
  /** 上一级，没有就是 null */
  parent: string | null;
  /** 只有子目录 */
  entries: DirEntry[];
  drives: string[];
  home: string;
  hints: { defaultRepoRoot: string; corpusRepos: string };
}

/** .env 里的一个模型档案，不含密钥。 */
export interface SecretProfile {
  id: string;
  prefix: string;
  label: string;
  baseUrl: string;
  model: string;
  /** 必填字段都齐了 */
  configured: boolean;
  /** 还缺哪些字段 */
  missing: string[];
}

export interface SecretStatus {
  envPath: string;
  exists: boolean;
  profiles: SecretProfile[];
}

/** 接口上的一个模型，附带价格信息。 */
export interface SecretModel {
  id: string;
  /** 已知要花钱为 true，已知免费为 false，查不到价格时为 null */
  paid: boolean | null;
  price?: { prompt: number; completion: number; currency: string };
}

export interface SecretTestResult {
  ok: boolean;
  /** 这套配置应答花了多久 */
  latencyMs?: number;
  error?: string;
  /** 测的时候用的是哪个模型 */
  model?: string;
  price?: { prompt: number; completion: number; currency: string };
}

/** 一份模型列表：已知的，或者从服务商拉回来的。 */
export interface SecretModelsResult {
  ok: boolean;
  /** 这家接口地址在已知厂商名单里吗 */
  known?: boolean;
  models: SecretModel[];
  error?: string;
  /** 这次没填密钥，用的是 .env 里存着的那把 */
  usedStoredKey?: boolean;
}

export interface EvaluateResult {
  datasetId: string;
  repo: string;
  repoRoot: string;
  codeVersion: string;
  strategies: StrategyMetrics[];
}

/** 一道题，和 harness/src/schema.ts 里的 EvalQuestion 对应。 */
export interface WorkQuestion {
  id: string;
  question: string;
  category: QuestionCategory;
  difficulty: Difficulty;
  reference: {
    answer: string;
    evidence: EvidenceRef[];
    mustMention: string[];
  };
  humanScore?: number;
}

/** 一套题集，和 harness/src/schema.ts 里的 EvalDataset 对应。 */
export interface WorkDataset {
  id: string;
  repo: string;
  repoUrl?: string;
  language: string;
  createdAt: string;
  questions: WorkQuestion[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: init?.body
      ? { "content-type": "application/json", ...(init.headers ?? {}) }
      : init?.headers,
  });
  const text = await response.text();
  let body: unknown = undefined;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: text.slice(0, 200) };
    }
  }
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `请求失败（${response.status}）`;
    throw new Error(message);
  }
  return body as T;
}

export const api = {
  health: () => request<Health>("/api/health"),

  dataset: (id: string) =>
    request<WorkDataset>(`/api/dataset?id=${encodeURIComponent(id)}`),

  /** 列出评测产物目录里的报告文件。 */
  reports: () => request<ReportList>("/api/reports"),

  /** 读一份评测产物。 */
  report: (file: string) =>
    request<ExperimentReport>(
      `/api/report?file=${encodeURIComponent(file)}`,
    ),

  validate: (dataset: WorkDataset, repoRoot: string) =>
    request<ValidateResult>("/api/validate", {
      method: "POST",
      body: JSON.stringify({ dataset, repoRoot }),
    }),

  evaluate: (dataset: WorkDataset, repoRoot: string) =>
    request<EvaluateResult>("/api/evaluate", {
      method: "POST",
      body: JSON.stringify({ dataset, repoRoot }),
    }),

  saveDataset: (dataset: WorkDataset, file?: string) =>
    request<{ path: string }>("/api/save-dataset", {
      method: "POST",
      body: JSON.stringify({ dataset, file }),
    }),

  /** 列一个目录下的子目录，用来挑被测仓库。 */
  dirs: (path?: string) =>
    request<DirListing>(
      `/api/dirs${path ? `?path=${encodeURIComponent(path)}` : ""}`,
    ),

  /** 读 .env 里的档案状态（不含密钥）。 */
  secrets: () => request<SecretStatus>("/api/secrets"),

  /**
   * 把一个档案写进 .env。
   *
   * 密钥只走这一条路：浏览器 → 本地服务 → 本机 .env，
   * 不落 localStorage、不进 URL、不进日志，也不回显。
   */
  saveSecret: (payload: {
    prefix: string;
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    label?: string;
  }) =>
    request<{ ok: boolean; envPath: string; status: SecretStatus }>(
      "/api/secrets",
      { method: "POST", body: JSON.stringify(payload) },
    ),

  /** 清掉某个档案的密钥。 */
  clearSecret: (prefix: string) =>
    request<{ ok: boolean; envPath: string; status: SecretStatus }>(
      "/api/secrets",
      { method: "DELETE", body: JSON.stringify({ prefix }) },
    ),

  /**
   * 测连通：用当前这套配置真的问一次模型。
   *
   * 接口地址、密钥、模型 id 三样都要对才算通过。
   * 密钥只在服务端用一次，浏览器拿到的只有状态和耗时。
   *
   * 表单里的「测试连通」不传 useStoredKey：它只认这次填的密钥，
   * 不会拿 .env 里存着的旧密钥去问。
   */
  testSecret: (payload: {
    prefix: string;
    testKey?: string;
    baseUrl?: string;
    model?: string;
    useStoredKey?: boolean;
  }) =>
    request<SecretTestResult>("/api/secrets/test", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  /**
   * 这家厂商已知的模型，不需要密钥。
   *
   * 问服务商要模型列表是要密钥的，但「这家大概有哪些模型」是公开信息，
   * 所以下拉框不用等测连通就能填。
   */
  secretModels: (baseUrl: string) =>
    request<SecretModelsResult>(
      `/api/secrets/models?baseUrl=${encodeURIComponent(baseUrl)}`,
    ),

  /** 用密钥向服务商要一份最新的模型列表。 */
  refreshSecretModels: (payload: {
    prefix: string;
    testKey?: string;
    baseUrl?: string;
  }) =>
    request<SecretModelsResult>("/api/secrets/models", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  /** 查一个模型 id 的单价，用来看手填的模型到底要不要花钱。 */
  secretPrice: (model: string) =>
    request<SecretModel>(
      `/api/secrets/price?model=${encodeURIComponent(model)}`,
    ),
};
