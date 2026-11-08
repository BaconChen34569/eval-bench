import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  XAxis,
  YAxis,
} from "recharts";

import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  formatNumber,
  formatPercent,
  modelComparison,
  type ModelComparisonRow,
} from "@/data/report";

/**
 * 多模型对比：同一份配置，换被测模型，再用好几把尺子各量一遍。
 *
 * 这一节要回答的不是「哪个模型更强」——评测集只有 22 道题，
 * 排出来的名次差一两位说明不了问题。它要回答的是：
 * 这把尺子能不能区分出模型的好坏，以及尺子本身有多可信。
 */
export function ModelComparisonSection() {
  if (!modelComparison) return null;

  const {
    rows,
    judges,
    agreementMatrix,
    selfPreference,
    primaryJudge,
    successThreshold,
    note,
  } = modelComparison;

  const primaryIndex = Math.max(
    0,
    judges.findIndex((judge) => judge.model === primaryJudge),
  );

  const cellOf = (row: ModelComparisonRow, index: number) =>
    row.cells[index];

  const judgeLabel = (model: string) =>
    judges.find((judge) => judge.model === model)?.label ?? model;

  // 主尺子下的排名
  const ranked = [...rows].sort(
    (a, b) =>
      (cellOf(b, primaryIndex)?.successRate ?? 0) -
      (cellOf(a, primaryIndex)?.successRate ?? 0),
  );
  const leader = ranked[0];
  const runnerUp = ranked[1];

  // 尺子之间最不一致的一对
  const worstPair = [...agreementMatrix].sort(
    (a, b) => a.agreement - b.agreement,
  )[0];

  // 模型之间的差距，和尺子之间的差距，谁更大
  const modelGap =
    leader && runnerUp
      ? ((cellOf(leader, primaryIndex)?.successRate ?? 0) -
          (cellOf(runnerUp, primaryIndex)?.successRate ?? 0)) *
        100
      : 0;
  const rulerGap = worstPair ? (1 - worstPair.agreement) * 100 : 0;

  // 每把尺子下的分差：差距被尺子压扁，说明这把尺子不区分模型
  const spreadUnder = (index: number) => {
    const values = rows.map((row) => cellOf(row, index)?.successRate ?? 0);
    return (Math.max(...values) - Math.min(...values)) * 100;
  };
  const primarySpread = spreadUnder(primaryIndex);
  const flattened = judges
    .map((judge, index) => {
      const top = Math.max(
        ...rows.map((row) => cellOf(row, index)?.successRate ?? 0),
      );
      const tied = rows.filter(
        (row) => (cellOf(row, index)?.successRate ?? 0) === top,
      );
      return { judge, index, top, tied };
    })
    .filter(
      (item) =>
        item.index !== primaryIndex && spreadUnder(item.index) < primarySpread,
    )
    .map((item) =>
      item.tied.length === rows.length
        ? `${item.judge.label} 尺子下三个模型全部并列 ${formatPercent(item.top)}`
        : `${item.judge.label} 尺子下 ${item.tied
            .map((row) => row.agentProfileLabel)
            .join("、")} 并列 ${formatPercent(item.top)}`,
    );

  // 自评偏袒最明显的一把尺子
  const mostBiased = [...selfPreference].sort(
    (a, b) => Math.abs(b.gap) - Math.abs(a.gap),
  )[0];

  // 尺子之间判出不同结论的题：同一份答案，有人说达标有人说没达标
  const disputes = rows.flatMap((row) =>
    row.caseScores
      .filter((item) => {
        const sides = judges
          .map((judge) => item.scores[judge.model])
          .filter((score): score is number => score !== undefined)
          .map((score) => score >= successThreshold);
        return new Set(sides).size > 1;
      })
      .map((item) => ({ row, item })),
  );

  const chartData = rows.map((row) => {
    const entry: Record<string, string | number> = {
      label: row.agentProfileLabel,
    };
    judges.forEach((judge, index) => {
      entry[`judge${index}`] = cellOf(row, index)?.successRate ?? 0;
    });
    return entry;
  });

  const chartConfig = Object.fromEntries(
    judges.map((judge, index) => [
      `judge${index}`,
      {
        label: judge.label,
        color: `var(--chart-${(index % 5) + 1})`,
      },
    ]),
  ) satisfies ChartConfig;

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-xl border border-chart-1/30 bg-chart-1/10 px-5 py-4">
        <p className="text-sm leading-relaxed">
          {rows.length} 个被测模型、{judges.length} 把尺子，同一份配置（
          {modelComparison.chunking.label}，top-{modelComparison.retrieval.topK}，
          {modelComparison.retrieval.rerankMode ?? "none"}，提示词{" "}
          {modelComparison.promptVersion}），每道题{" "}
          {rows[0]?.caseScores.length ?? 0} 次打分。主尺子{" "}
          <span className="font-medium text-foreground">
            {judges[primaryIndex]?.label}
          </span>{" "}
          下的排名是{" "}
          {ranked.map((row, index) => (
            <span key={row.agentProfile}>
              {index > 0 ? "、" : ""}
              <span className="font-medium text-foreground">
                {row.agentProfileLabel}
              </span>
            </span>
          ))}
          。{leader && runnerUp ? (
            <>
              第一名比第二名高{" "}
              {modelGap.toFixed(1)}{" "}
              个百分点，{judges.length > 1 ? "但" : "，"}换成别的尺子{" "}
              {worstPair ? (
                <>
                  一致率最低的一对（
                  {judgeLabel(worstPair.judgeA)} ↔ {judgeLabel(worstPair.judgeB)}
                  ）只有{" "}
                  {formatPercent(worstPair.agreement)}
                  ，{worstPair.flips} 题的达标判定被翻转了
                </>
              ) : null}
              。{" "}
              <span className="font-medium text-foreground">
                这就是尺子的误差下限
              </span>
              {rulerGap > modelGap ? (
                <>
                  ——它（
                  {rulerGap.toFixed(1)}
                  个百分点）比第一名和第二名之间的{" "}
                  {modelGap.toFixed(1)} 个百分点还大（还没盖过第一名和最后一名之间{" "}
                  {primarySpread.toFixed(1)} 个百分点的总差距）。也就是说：模型之间
                  的总差距是真的，但相邻名次之间的差距比尺子本身的误差还小
                </>
              ) : (
                <>
                  ——它（
                  {rulerGap.toFixed(1)}
                  个百分点）还没超过第一名和第二名之间的{" "}
                  {modelGap.toFixed(1)} 个百分点，但换一把尺子仍然可能改写名次
                </>
              )}
              {flattened.length > 0 ? (
                <>
                  ，一换尺子就可能被抹平：{flattened.join("；")}
                </>
              ) : null}
              ，所以排名要连着一致率一起看。
            </>
          ) : null}
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.15fr_1fr]">
        <div className="rounded-xl border bg-card px-5 py-4 shadow-sm">
          <div className="mb-3">
            <div className="text-base font-semibold">同一份答案，几把尺子各打各的</div>
            <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
              每一根柱子是一把尺子。柱子越高，这把尺子越认可这个模型；
              同一模型的几根柱子差得越多，说明这把尺子的口径越不稳。
            </div>
          </div>
          <ChartContainer config={chartConfig} className="h-[260px] w-full">
            <BarChart data={chartData} margin={{ left: 4, right: 8, top: 16 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" tickLine={false} tickMargin={8} fontSize={12} />
              <YAxis
                domain={[0, 1]}
                tickLine={false}
                axisLine={false}
                width={44}
                fontSize={12}
                tickFormatter={(value: number) => `${Math.round(value * 100)}%`}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    formatter={(value, name) => (
                      <div className="flex w-full items-center justify-between gap-4">
                        <span className="text-muted-foreground">
                          {judges[Number(String(name).replace("judge", ""))]
                            ?.label ?? String(name)}
                        </span>
                        <span className="font-mono font-medium tabular-nums">
                          {formatPercent(Number(value))}
                        </span>
                      </div>
                    )}
                  />
                }
              />
              {judges.map((judge, index) => (
                <Bar
                  key={judge.model}
                  dataKey={`judge${index}`}
                  fill={`var(--color-judge${index})`}
                  radius={[4, 4, 0, 0]}
                >
                  <LabelList
                    dataKey={`judge${index}`}
                    position="top"
                    formatter={(value) => `${Math.round(Number(value) * 100)}%`}
                    fontSize={10}
                    fill="var(--foreground)"
                  />
                </Bar>
              ))}
              <ChartLegend content={<ChartLegendContent />} />
            </BarChart>
          </ChartContainer>
        </div>

        <div className="flex flex-col gap-4">
          <div className="rounded-xl border bg-card px-5 py-4 shadow-sm">
            <div className="text-base font-semibold">尺子之间有多一致</div>
            <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
              同一批答案，两把尺子各打一遍。相差不超过 1 分算一致；
              「翻转」指同一道题，两把尺子对「达没达标」的判断相反。
            </div>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[380px] text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">两把尺子</th>
                    <th className="py-2 pr-3 text-right font-medium">一致率</th>
                    <th className="py-2 pr-3 text-right font-medium">完全同分</th>
                    <th className="py-2 pr-3 text-right font-medium">翻转题数</th>
                    <th className="py-2 text-right font-medium">
                      A / B 成功率
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {agreementMatrix.map((item) => (
                    <tr
                      key={`${item.judgeA}-${item.judgeB}`}
                      className="border-b last:border-0"
                    >
                      <td className="py-2 pr-3 text-xs">
                        {judgeLabel(item.judgeA)} ↔ {judgeLabel(item.judgeB)}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono tabular-nums">
                        {formatPercent(item.agreement)}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono tabular-nums">
                        {formatPercent(item.exactAgreement)}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono tabular-nums">
                        {item.flips}
                        <span className="ml-1 text-[11px] text-muted-foreground">
                          / {item.sampled}
                        </span>
                      </td>
                      <td className="py-2 text-right font-mono tabular-nums">
                        {formatPercent(item.judgeASuccessRate)}
                        <span className="mx-1 text-muted-foreground">/</span>
                        {formatPercent(item.judgeBSuccessRate)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="rounded-xl border bg-card px-5 py-4 shadow-sm">
            <div className="text-base font-semibold">尺子偏袒自己那家吗</div>
            <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
              judge 自己也是模型。给它本家的模型打分，和给它别家的模型打分，
              平均差多少——差得多，说明它给的排名不能直接当结论。
            </div>
            <div className="mt-3 flex flex-col gap-2">
              {selfPreference.map((item) => (
                <div
                  key={item.judgeModel}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm"
                >
                  <span className="font-medium">{item.judgeProfileLabel}</span>
                  <span className="text-xs text-muted-foreground">
                    本家 {item.ownAvgScore.toFixed(2)} · 他家{" "}
                    {item.otherAvgScore.toFixed(2)}
                  </span>
                  <span
                    className={`font-mono tabular-nums ${
                      item.gap > 0.05
                        ? "text-chart-1"
                        : item.gap < -0.05
                          ? "text-chart-2"
                          : "text-muted-foreground"
                    }`}
                  >
                    {item.gap >= 0 ? "+" : ""}
                    {item.gap.toFixed(2)} 分 · 本家排第 {item.ownRank}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="eval-table w-full min-w-[860px] text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="py-2 pr-3 font-medium">被测模型</th>
              {judges.map((judge, index) => (
                <th
                  key={judge.model}
                  className="py-2 pr-3 text-right font-medium"
                >
                  {judge.label}
                  {index === primaryIndex ? (
                    <span className="ml-1 text-[10px] text-muted-foreground">
                      主尺子
                    </span>
                  ) : null}
                </th>
              ))}
              <th className="py-2 pr-3 text-right font-medium">平均成功率</th>
              <th className="py-2 pr-3 text-right font-medium">证据召回</th>
              <th className="py-2 pr-3 text-right font-medium">平均延迟</th>
              <th className="py-2 text-right font-medium">成本</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((row) => (
              <tr key={row.agentProfile} className="border-b last:border-0 align-top">
                <td className="py-2 pr-3">
                  <div className="font-medium">{row.agentProfileLabel}</div>
                  <div className="font-mono text-xs text-muted-foreground">
                    {row.agentModel}
                  </div>
                  {row.reused ? (
                    <div className="text-[11px] text-muted-foreground">
                      复用了已有的运行记录
                    </div>
                  ) : null}
                </td>
                {judges.map((judge, index) => (
                  <td
                    key={judge.model}
                    className="py-2 pr-3 text-right font-mono tabular-nums"
                  >
                    {formatPercent(cellOf(row, index)?.successRate ?? 0)}
                    <div className="text-[11px] text-muted-foreground">
                      均分 {(cellOf(row, index)?.avgJudgeScore ?? 0).toFixed(2)}
                    </div>
                  </td>
                ))}
                <td className="py-2 pr-3 text-right font-mono tabular-nums">
                  {formatPercent(row.avgSuccessRate)}
                </td>
                <td className="py-2 pr-3 text-right font-mono tabular-nums">
                  {formatPercent(row.avgEvidenceRecall)}
                </td>
                <td className="py-2 pr-3 text-right font-mono tabular-nums">
                  {formatNumber(row.avgLatencyMs)} ms
                </td>
                <td className="py-2 text-right font-mono tabular-nums">
                  ¥{row.totalCost.toFixed(4)}
                  <div className="text-[11px] text-muted-foreground">
                    生成 {row.agentCost.toFixed(4)} · 打分 {row.judgeCost.toFixed(4)}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">{note}</p>

      {disputes.length > 0 ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            <h3 className="text-base font-semibold">
              尺子判出分歧的 {disputes.length} 道题
            </h3>
            <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
              同一份答案，有的尺子判达标、有的判没达标。
              这就是尺子误差具体落在哪几题——{" "}
              <span className="font-medium text-foreground">
                看排名之前得先知道这些题的分数是稳的
              </span>
              。{mostBiased && Math.abs(mostBiased.gap) > 0.05 ? (
                <>
                  {" "}
                  偏袒最明显的是 {mostBiased.judgeProfileLabel}：
                  给本家 {mostBiased.ownAvgScore.toFixed(2)} 分，
                  给别家平均 {mostBiased.otherAvgScore.toFixed(2)} 分。
                </>
              ) : null}
            </p>
          </div>
          <div className="max-h-[360px] overflow-auto">
            <table className="eval-table w-full min-w-[520px] text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">被测模型</th>
                  <th className="py-2 pr-3 font-medium">题目</th>
                  {judges.map((judge) => (
                    <th key={judge.model} className="py-2 pr-3 text-right font-medium">
                      {judge.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {disputes.map(({ row, item }) => (
                  <tr
                    key={`${row.agentProfile}-${item.questionId}`}
                    className="border-b last:border-0"
                  >
                    <td className="py-1 pr-3 text-xs">{row.agentProfileLabel}</td>
                    <td className="py-1 pr-3 font-mono text-xs">
                      {item.questionId}
                    </td>
                    {judges.map((judge) => {
                      const score = item.scores[judge.model];
                      if (score === undefined) {
                        return (
                          <td key={judge.model} className="py-1 pr-3 text-right">
                            —
                          </td>
                        );
                      }
                      const passed = score >= successThreshold;
                      return (
                        <td key={judge.model} className="py-1 pr-3 text-right">
                          <span
                            className={`inline-flex h-7 min-w-8 items-center justify-center rounded px-1.5 font-mono text-[11px] tabular-nums ${
                              passed
                                ? "bg-chart-2/25 text-chart-2"
                                : "bg-chart-1/15 text-chart-1"
                            }`}
                          >
                            {score}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}
