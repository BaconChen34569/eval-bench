import {
  CATEGORY_LABEL,
  DIFFICULTY_LABEL,
  FAILURE_LABEL,
  ladder,
  questions,
  report,
  runs,
  type RunCase,
} from "@/data/report";
import { Button } from "@/components/ui/button";

function download(name: string, mime: string, content: string) {
  // CSV 必须带 UTF-8 BOM，否则 Excel 在中文 Windows 上按 GBK 解码会显示乱码。
  const payload = mime.startsWith("text/csv") ? `\uFEFF${content}` : content;
  const blob = new Blob([payload], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 逐题结果表：每行一道题在一种策略下的完整结果。 */
export function buildCsv(): string {
  const header = [
    "questionId",
    "question",
    "category",
    "difficulty",
    "strategy",
    "recallAt1",
    "recallAt3",
    "recallAt6",
    "firstHitRank",
    "judgeScore",
    "evidenceRecall",
    "failureKind",
    "latencyMs",
    "cost",
    "goldFiles",
    "topCitations",
  ];

  const rows: (string | number)[][] = [];
  for (const question of questions) {
    for (const run of runs) {
      const entry = run.cases.find(
        (item) => item.questionId === question.questionId,
      ) as RunCase | undefined;
      const retrieval = report.strategies
        .find((item) => item.strategy.id === run.chunking.id)
        ?.cases.find((item) => item.questionId === question.questionId);

      rows.push([
        question.questionId,
        question.question,
        CATEGORY_LABEL[question.category],
        DIFFICULTY_LABEL[question.difficulty],
        run.chunking.label,
        retrieval ? retrieval.recallAt1.toFixed(4) : "",
        retrieval ? retrieval.recallAt3.toFixed(4) : "",
        retrieval ? retrieval.recallAt6.toFixed(4) : "",
        retrieval ? retrieval.firstHitRank : "",
        entry ? entry.judgeScore : "",
        entry ? entry.evidenceRecall.toFixed(4) : "",
        entry?.failureKind ? FAILURE_LABEL[entry.failureKind] : entry ? "达标" : "",
        entry ? entry.latencyMs : "",
        entry ? entry.cost.toFixed(8) : "",
        question.gold.map((g) => `${g.file}:${g.startLine}-${g.endLine}`).join(" | "),
        (retrieval?.citations ?? [])
          .map((c) => `${c.file}:${c.startLine}-${c.endLine}`)
          .join(" | "),
      ]);
    }
  }

  return [header, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\n");
}

/** 策略总览表：三种切分策略的检索层与生成层指标。 */
export function buildStrategyCsv(): string {
  const header = [
    "strategy",
    "chunkCount",
    "avgChunkChars",
    "avgContextChars",
    "recallAt1",
    "recallAt3",
    "recallAt6",
    "mrr",
    "successRate",
    "avgJudgeScore",
    "avgLatencyMs",
    "p95LatencyMs",
    "avgCost",
    "totalCost",
    "totalTokens",
  ];

  const rows = report.strategies.map((item) => [
    item.strategy.label,
    item.chunkCount,
    item.avgChunkChars,
    item.avgContextChars,
    item.recallAt1.toFixed(4),
    item.recallAt3.toFixed(4),
    item.recallAt6.toFixed(4),
    item.mrr.toFixed(6),
    item.successRate !== undefined ? item.successRate.toFixed(4) : "",
    item.avgJudgeScore !== undefined ? item.avgJudgeScore.toFixed(4) : "",
    item.avgLatencyMs !== undefined ? item.avgLatencyMs.toFixed(0) : "",
    item.p95LatencyMs !== undefined ? item.p95LatencyMs.toFixed(0) : "",
    item.avgCost !== undefined ? item.avgCost.toFixed(8) : "",
    item.totalCost !== undefined ? item.totalCost.toFixed(8) : "",
    item.totalTokens !== undefined ? item.totalTokens : "",
  ]);

  return [header, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\n");
}

/** 迭代阶梯总览表：每一轮改了什么、检索层涨了多少、生成层涨了多少。 */
export function buildLadderCsv(): string {
  const header = [
    "step",
    "title",
    "change",
    "chunking",
    "topK",
    "rerankMode",
    "promptVersion",
    "recallAt1",
    "recallAt3",
    "recallAt6",
    "recallAtBudget",
    "mrr",
    "avgContextChars",
    "successRate",
    "avgJudgeScore",
    "avgEvidenceRecall",
    "totalCost",
    "totalTokens",
  ];

  const rows = ladder.map((step) => [
    step.id,
    step.title,
    step.change,
    step.chunking.label,
    step.retrieval.topK,
    step.retrieval.rerankMode ?? "none",
    step.promptVersion,
    step.retrievalMetrics.recallAt1.toFixed(4),
    step.retrievalMetrics.recallAt3.toFixed(4),
    step.retrievalMetrics.recallAt6.toFixed(4),
    step.retrievalMetrics.recallAtBudget.toFixed(4),
    step.retrievalMetrics.mrr.toFixed(6),
    Math.round(step.retrievalMetrics.avgContextChars),
    step.summary.successRate.toFixed(4),
    step.summary.avgJudgeScore.toFixed(4),
    step.summary.avgEvidenceRecall.toFixed(4),
    step.summary.totalCost.toFixed(8),
    step.summary.totalTokens,
  ]);

  return [header, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\n");
}

export function ExportButtons() {
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={() =>
          download("eval-bench-cases.csv", "text/csv;charset=utf-8", buildCsv())
        }
      >
        下载逐题结果 CSV
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() =>
          download(
            "eval-bench-strategies.csv",
            "text/csv;charset=utf-8",
            buildStrategyCsv(),
          )
        }
      >
        下载策略总览 CSV
      </Button>
      {ladder.length > 0 && (
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            download(
              "eval-bench-ladder.csv",
              "text/csv;charset=utf-8",
              buildLadderCsv(),
            )
          }
        >
          下载迭代阶梯 CSV
        </Button>
      )}
      <Button
        variant="outline"
        size="sm"
        onClick={() =>
          download(
            "eval-bench-report.json",
            "application/json",
            JSON.stringify(report, null, 2),
          )
        }
      >
        下载原始 report.json
      </Button>
    </div>
  );
}
