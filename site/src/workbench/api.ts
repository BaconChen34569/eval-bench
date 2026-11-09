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
  datasets: DatasetSummary[];
}

export interface ValidateResult {
  problems: string[];
  warnings: string[];
  repoRoot: string;
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

  saveDataset: (dataset: WorkDataset) =>
    request<{ path: string }>("/api/save-dataset", {
      method: "POST",
      body: JSON.stringify({ dataset }),
    }),
};
