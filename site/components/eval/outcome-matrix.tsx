import {
  CATEGORY_LABEL,
  FAILURE_LABEL,
  questions,
  runs,
  type RunCase,
} from "@/data/report";

/**
 * 22 题 × 3 策略的胜负矩阵：每格是一次评测结果，绿色达标、橙色未达标。
 * 这是竞品 experiment compare 的核心形态，评委一眼能看出"哪题在哪种策略下变好了"。
 */
export function OutcomeMatrix() {
  const threshold = runs[0]?.summary.successThreshold ?? 4;

  const cells = (questionId: string) =>
    runs.map((run) => {
      const entry = run.cases.find(
        (item) => item.questionId === questionId,
      ) as RunCase | undefined;
      const score = entry?.judgeScore ?? 0;
      const pass = entry ? score >= run.summary.successThreshold : false;
      return {
        run,
        entry,
        score,
        pass,
        kind: entry?.failureKind,
      };
    });

  const wins = runs.map((run) => ({
    run,
    count: run.cases.filter(
      (item) => item.judgeScore >= run.summary.successThreshold,
    ).length,
  }));
  const best = wins.reduce((a, b) => (b.count > a.count ? b : a));

  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] border-separate border-spacing-0.5 text-sm">
          <thead>
            <tr>
              <th className="w-16 pb-2 text-left text-xs font-medium text-muted-foreground">
                题目
              </th>
              <th className="pb-2 text-left text-xs font-medium text-muted-foreground">
                类别
              </th>
              {runs.map((run) => (
                <th
                  key={run.runId}
                  className="pb-2 text-center text-xs font-medium text-muted-foreground"
                >
                  {run.chunking.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {questions.map((question) => (
              <tr key={question.questionId}>
                <td className="py-1 pr-2 font-mono text-xs">
                  <a
                    href="#questions"
                    className="hover:text-chart-1 hover:underline"
                  >
                    {question.questionId}
                  </a>
                </td>
                <td className="py-1 pr-2 text-xs text-muted-foreground">
                  {CATEGORY_LABEL[question.category]}
                </td>
                {cells(question.questionId).map(({ run, score, pass, kind }) => (
                  <td key={run.runId} className="p-0">
                    <div
                      title={`${run.chunking.label} · judge ${score}/5${
                        kind ? ` · ${FAILURE_LABEL[kind]}` : " · 达标"
                      }`}
                      className={`flex h-8 items-center justify-center rounded text-[11px] font-mono tabular-nums ${
                        pass
                          ? "bg-chart-2/25 text-chart-2"
                          : "bg-chart-1/15 text-chart-1"
                      }`}
                    >
                      {score}
                    </div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td className="pt-2 text-xs font-medium text-muted-foreground">
                达标
              </td>
              <td />
              {wins.map(({ run, count }) => (
                <td
                  key={run.runId}
                  className={`pt-2 text-center text-xs font-mono tabular-nums ${
                    run.runId === best.run.runId
                      ? "font-semibold text-chart-2"
                      : "text-muted-foreground"
                  }`}
                >
                  {count} / {run.cases.length}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-chart-2/25 px-2.5 py-0.5 font-medium text-chart-2">
          ≥ {threshold} 分 达标
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-chart-1/15 px-2.5 py-0.5 font-medium text-chart-1">
          &lt; {threshold} 分 未达标
        </span>
        <span>
          格子里是 judge 打分。同一行横向看，就是这道题在三种切分策略下的差异。
        </span>
      </div>
    </div>
  );
}
