import { readFile } from "node:fs/promises";
import { runRetrievalEval } from "./retrieval-eval.ts";
import { evidenceRecall } from "./retrieval.ts";
import { CODE_VERSION } from "./schema.ts";
import type {
  EvalDataset,
  EvalRun,
  JudgeValidation,
  MultiProjectComparison,
  ProjectComparisonRow,
} from "./schema.ts";

/**
 * 多项目对比：同一份配置，换一个被测仓库再跑一遍。
 *
 * 回答的问题是「这套评测台换个仓库还灵不灵」。
 * 只有一个仓库的数字，说明不了评测台本身是否成立——
 * 换个语言、换个规模、换一套目录结构之后还能不能量出同样的东西，才是关键。
 *
 * 前提只有一个：所有项目必须用同一份配置。
 * 配置一旦不一致，横向比的就不是项目，而是配置。
 */

export interface ProjectManifestEntry {
  /** 项目标识，如 flask */
  id: string;
  /** 展示名，如「Flask」 */
  label: string;
  /** 评测集 json 路径 */
  dataset: string;
  /** 被测仓库根目录 */
  repoRoot: string;
  /** 这一轮生成层运行记录 json 路径 */
  run?: string;
  /** 或者从一份报告里取运行记录（阶梯的某一轮） */
  runFrom?: { report: string; ladderStepId: string };
  /** judge 自检结果 json 路径（judge-check 命令产出） */
  judgeValidation?: string;
}

export interface ProjectManifest {
  projects: ProjectManifestEntry[];
}

export interface MultiProjectOptions {
  manifest: ProjectManifest;
  /** 共用配置来自阶梯的哪一轮，写进结果里备查 */
  step: string;
  /** 成功判定阈值 */
  successThreshold: number;
  onProgress?: (message: string) => void;
}

/**
 * 一个项目的运行记录能不能直接拿来和别的项目横向比。
 *
 * 代码版本必须一致、题目数必须跑全：改过切分或检索实现之后，
 * 旧记录和新的已经不是同一份东西；--limit 跑出来的也不完整。
 */
function usable(
  run: EvalRun,
  dataset: EvalDataset,
): { ok: boolean; reason: string } {
  if (run.codeVersion !== CODE_VERSION) {
    return {
      ok: false,
      reason: `代码版本 ${run.codeVersion} 与当前 ${CODE_VERSION} 不一致`,
    };
  }
  if (run.cases.length !== dataset.questions.length) {
    return {
      ok: false,
      reason: `题数 ${run.cases.length} 与评测集 ${dataset.questions.length} 不一致`,
    };
  }
  return { ok: true, reason: "" };
}

/**
 * 取一个项目的运行记录。
 *
 * 可以直接给一份运行记录 json，也可以从报告里取阶梯的某一轮——
 * flask 的公开数字就是阶梯的 v7，从报告里取才不用手抄。
 */
async function loadRun(entry: ProjectManifestEntry): Promise<EvalRun> {
  if (entry.run) {
    return JSON.parse(await readFile(entry.run, "utf8")) as EvalRun;
  }
  if (entry.runFrom) {
    const report = JSON.parse(
      await readFile(entry.runFrom.report, "utf8"),
    ) as { ladder?: { id: string; runId: string }[]; ladderRuns?: EvalRun[] };
    const step = report.ladder?.find(
      (item) => item.id === entry.runFrom!.ladderStepId,
    );
    const run = report.ladderRuns?.find((item) => item.runId === step?.runId);
    if (!run) {
      throw new Error(
        `${entry.label}：报告 ${entry.runFrom.report} 里找不到阶梯 ${entry.runFrom.ladderStepId} 的运行记录`,
      );
    }
    return run;
  }
  throw new Error(`${entry.label}：manifest 里既没有 run 也没有 runFrom`);
}

export async function buildMultiProjectComparison(
  options: MultiProjectOptions,
): Promise<MultiProjectComparison> {
  const rows: ProjectComparisonRow[] = [];

  for (const entry of options.manifest.projects) {
    const dataset = JSON.parse(
      await readFile(entry.dataset, "utf8"),
    ) as EvalDataset;
    const run = await loadRun(entry);

    const check = usable(run, dataset);
    if (!check.ok) {
      throw new Error(
        `${entry.label} 的运行记录不能用于横向对比：${check.reason}`,
      );
    }

    options.onProgress?.(
      `【${entry.label}】检索层复算（切分 ${run.chunking.label}，top-${run.retrieval.topK}）`,
    );
    const budget = run.retrieval.topK;
    const [metrics] = await runRetrievalEval({
      dataset,
      repoRoot: entry.repoRoot,
      strategies: [run.chunking],
      retrieval: run.retrieval,
      topKs: [1, 3, 6, budget],
    });

    // 召回率自己算：检索层默认只算到 top-6，
    // 而这一轮的预算可能是 10，两个口径混在一起会看错。
    const count = metrics.cases.length || 1;
    const recallAt = (k: number) =>
      metrics.cases.reduce(
        (sum, item) =>
          sum + evidenceRecall(item.citations.slice(0, k), item.gold),
        0,
      ) / count;

    rows.push({
      project: entry.id,
      label: entry.label,
      repo: dataset.repo,
      fileCount: metrics.fileCount,
      repoLines: metrics.totalRepoLines,
      questions: dataset.questions.length,
      model: run.model,
      judgeModel: run.judgeModel ?? run.model,
      chunking: run.chunking,
      retrieval: run.retrieval,
      promptVersion: run.promptVersion ?? "base",
      successRate: run.summary.successRate,
      avgJudgeScore: run.summary.avgJudgeScore,
      avgEvidenceRecall: run.summary.avgEvidenceRecall,
      avgLatencyMs: run.summary.avgLatencyMs,
      p95LatencyMs: run.summary.p95LatencyMs,
      totalCost: run.summary.totalCost,
      totalTokens: run.summary.totalTokens,
      byCategory: run.summary.byCategory,
      judgeValidation: entry.judgeValidation
        ? (
            JSON.parse(
              await readFile(entry.judgeValidation, "utf8"),
            ) as { summary: JudgeValidation }
          ).summary
        : undefined,
      retrievalMetrics: {
        recallAt1: recallAt(1),
        recallAt3: recallAt(3),
        recallAt6: recallAt(6),
        recallAtBudget: recallAt(budget),
        mrr: metrics.mrr,
        avgContextChars: metrics.avgContextChars,
        chunkCount: metrics.chunkCount,
      },
      caseScores: run.cases.map((item) => ({
        questionId: item.questionId,
        judgeScore: item.judgeScore,
        evidenceRecall: item.evidenceRecall,
      })),
    });
  }

  const first = rows[0];
  const sameConfig = rows.every(
    (row) =>
      row.chunking.id === first.chunking.id &&
      row.retrieval.topK === first.retrieval.topK &&
      (row.retrieval.rerankMode ?? "none") ===
        (first.retrieval.rerankMode ?? "none") &&
      (row.retrieval.queryExpansion ?? false) ===
        (first.retrieval.queryExpansion ?? false) &&
      row.promptVersion === first.promptVersion &&
      row.model === first.model &&
      row.judgeModel === first.judgeModel,
  );
  if (!sameConfig) {
    throw new Error(
      "各项目的配置不一致，横向对比不成立。请用同一份配置重跑后再合并。",
    );
  }

  return {
    codeVersion: CODE_VERSION,
    step: options.step,
    chunking: first.chunking,
    retrieval: first.retrieval,
    promptVersion: first.promptVersion,
    successThreshold: options.successThreshold,
    rows,
    note:
      `四个项目共用同一份配置（${first.chunking.label}，top-${first.retrieval.topK}，` +
      `${first.retrieval.rerankMode ?? "none"}` +
      `${first.retrieval.queryExpansion ? "，中英术语扩展" : ""}，` +
      `提示词 ${first.promptVersion}），被测模型 ${first.model}，打分模型 ${first.judgeModel}；` +
      `每份题目都是人工标注参考答案与证据位置。`,
  };
}
