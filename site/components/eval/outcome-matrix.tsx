import {
  CATEGORY_LABEL,
  FAILURE_LABEL,
  questions,
  runs,
  type QuestionCategory,
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

  // 只列真正跑过的题。
  // 检索层对整套题都算过，生成层可能只跑了前几题；
  // 没跑的题不能画成 0 分——那看着像"这题失败了"，其实压根没问过。
  const ranIds = new Set<string>();
  for (const run of runs) {
    for (const item of run.cases) ranIds.add(item.questionId);
  }
  const rows = questions
    .filter((question) => ranIds.has(question.questionId))
    .map((question) => ({
      questionId: question.questionId,
      category: question.category as QuestionCategory,
    }));
  // 报告里只有生成层记录、没有检索层题目时，按运行记录本身列题
  for (const run of runs) {
    for (const item of run.cases) {
      if (rows.some((row) => row.questionId === item.questionId)) continue;
      rows.push({
        questionId: item.questionId,
        category: (item as RunCase & { category?: QuestionCategory }).category,
      });
    }
  }

  if (runs.length === 0) {
    return (
      <p className="rounded-lg border bg-card px-4 py-6 text-sm text-muted-foreground">
        这一章要生成层的运行记录（模型回答 + judge 打分），
        当前这份报告里没有，先看检索层的策略对比。
      </p>
    );
  }

  const best = wins.reduce((a, b) => (b.count > a.count ? b : a));

  const hasMissing = rows.some((row) =>
    runs.some((run) => !run.cases.some((item) => item.questionId === row.questionId)),
  );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="table-scroll overflow-x-auto">
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
            {rows.map((row) => (
              <tr key={row.questionId}>
                <td className="py-1 pr-2 font-mono text-xs">
                  <a
                    href="#questions"
                    className="hover:text-chart-1 hover:underline"
                  >
                    {row.questionId}
                  </a>
                </td>
                <td className="py-1 pr-2 text-xs text-muted-foreground">
                  {row.category ? CATEGORY_LABEL[row.category] : "—"}
                </td>
                {cells(row.questionId).map(({ run, entry, score, pass, kind }) => (
                  <td key={run.runId} className="p-0">
                    <div
                      title={
                        entry
                          ? `${run.chunking.label} · judge ${score}/5${
                              kind ? ` · ${FAILURE_LABEL[kind]}` : " · 达标"
                            }`
                          : `${run.chunking.label} · 这条策略没跑到这一题`
                      }
                      className={`flex h-8 items-center justify-center rounded text-[11px] font-mono tabular-nums ${
                        !entry
                          ? "bg-muted/40 text-muted-foreground"
                          : pass
                            ? "bg-chart-2/25 text-chart-2"
                            : "bg-chart-1/15 text-chart-1"
                      }`}
                    >
                      {entry ? score : "—"}
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
        {hasMissing && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-muted/40 px-2.5 py-0.5 font-medium text-muted-foreground">
            — 这条策略没跑到这一题
          </span>
        )}
        <span>
          格子里是 judge 打分。同一行横向看，就是这道题在三种切分策略下的差异。
        </span>
      </div>
    </div>
  );
}
