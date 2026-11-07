import type { BaselineSnapshot, ExperimentReport } from "./schema.ts";

/**
 * 从上一版报告里抽出对照快照。
 *
 * 站点要展示「优化前后」，就得同时握着前后两组数字。
 * 前一组不靠回忆手写——直接把旧报告里最好的那次横向对比运行原样搬过来，
 * 连同它那一版的检索层指标，这样前后量的是同一把尺子。
 */
export function readBaseline(
  report: ExperimentReport,
): BaselineSnapshot | undefined {
  const runs = (report.runs ?? []).filter((run) => run.origin !== "ladder");
  if (runs.length === 0) return undefined;

  const best = runs.reduce((a, b) =>
    b.summary.successRate > a.summary.successRate ? b : a,
  );
  const metrics = report.strategies?.find(
    (item) => item.strategy.id === best.chunking.id,
  );

  return {
    codeVersion: best.codeVersion,
    chunking: best.chunking,
    model: best.model,
    summary: best.summary,
    retrievalMetrics: {
      recallAt1: metrics?.recallAt1 ?? 0,
      recallAt3: metrics?.recallAt3 ?? 0,
      recallAt6: metrics?.recallAt6 ?? 0,
      mrr: metrics?.mrr ?? 0,
      avgContextChars: metrics?.avgContextChars ?? 0,
      chunkCount: metrics?.chunkCount ?? 0,
    },
    cases: best.cases.map((item) => ({
      questionId: item.questionId,
      category: item.category,
      judgeScore: item.judgeScore,
      evidenceRecall: item.evidenceRecall,
      failureKind: item.failureKind,
    })),
  };
}
