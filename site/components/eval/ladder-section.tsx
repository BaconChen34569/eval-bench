import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "recharts";
import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";

import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  CATEGORY_LABEL,
  formatNumber,
  formatPercent,
  ladder,
  ladderRuns,
  type QuestionCategory,
} from "@/data/report";

const progressConfig = {
  successRate: { label: "成功率", color: "var(--chart-2)" },
  recall: { label: "证据召回率", color: "var(--chart-3)" },
} satisfies ChartConfig;

const costConfig = {
  cost: { label: "本轮成本", color: "var(--chart-4)" },
  context: { label: "上下文字符", color: "var(--chart-3)" },
} satisfies ChartConfig;

/**
 * 工具迭代史：每一轮只相对上一轮改一个变量，用同一套协议重跑。
 *
 * 图表把两层指标叠在一起看：检索层的证据召回率是上限，
 * 生成层的成功率受它约束。两层的走势能对上，才说明改的地方真的起作用了。
 */
export function LadderSection() {
  if (ladder.length === 0) return null;

  const progress = ladder.map((step) => ({
    label: step.id,
    title: step.title,
    successRate: step.summary.successRate,
    recall: step.retrievalMetrics.recallAtBudget,
  }));

  const cost = ladder.map((step) => ({
    label: step.id,
    title: step.title,
    cost: step.summary.totalCost,
    context: step.retrievalMetrics.avgContextChars,
  }));

  const best = ladder.reduce((a, b) =>
    b.summary.successRate > a.summary.successRate ||
    (b.summary.successRate === a.summary.successRate &&
      b.summary.totalCost < a.summary.totalCost)
      ? b
      : a,
  );
  // 没有独立带来收益的轮次：成功率没涨，成本还涨了。
  // 注意这些改动可能被后面的轮次继承，所以只能说明「这一轮单独看不出来」。
  const flat = ladder.flatMap((step, index) => {
    if (index === 0) return [];
    const previous = ladder[index - 1];
    if (
      step.summary.successRate > previous.summary.successRate + 0.001 ||
      step.summary.totalCost <= previous.summary.totalCost
    ) {
      return [];
    }
    const rise = Math.round(
      ((step.summary.totalCost - previous.summary.totalCost) /
        previous.summary.totalCost) *
        100,
    );
    return [{ step, rise }];
  });
  // 单独一轮把成功率拉低的情况。这也得说出来，
  // 阶梯的价值不在于每一轮都涨，而在于每一轮的涨跌都能解释。
  const regressed = ladder.flatMap((step, index) => {
    if (index === 0) return [];
    const previous = ladder[index - 1];
    const delta = step.summary.successRate - previous.summary.successRate;
    if (delta >= -0.001) return [];
    const recallDelta =
      step.retrievalMetrics.recallAtBudget -
      previous.retrievalMetrics.recallAtBudget;
    // 这一轮改的是提示词的话，后面几轮还留着它——说明它是被继承的，
    // 而不是被回滚掉的。
    const promptChanged = step.promptVersion !== previous.promptVersion;
    const inherited = promptChanged
      ? ladder.slice(index + 1).filter((later) => later.promptVersion === step.promptVersion)
          .length
      : 0;
    return [{ step, drop: Math.abs(delta * 100), recallDelta, inherited }];
  });
  const bestRecall = ladder.reduce((a, b) =>
    b.retrievalMetrics.recallAtBudget > a.retrievalMetrics.recallAtBudget ? b : a,
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-xl border border-chart-2/30 bg-chart-2/10 px-5 py-4">
        <p className="text-sm leading-relaxed">
          {ladder.length} 轮跑下来，最优的是{" "}
          <span className="font-medium text-foreground">
            {best.id} {best.title}
          </span>
          ，成功率 {formatPercent(best.summary.successRate)}
          {best.id !== ladder[0].id ? (
            <>
              ，比起点 {ladder[0].id} 高{" "}
              {((best.summary.successRate - ladder[0].summary.successRate) * 100).toFixed(1)}{" "}
              个百分点
            </>
          ) : null}
          。检索层召回最高的是 {bestRecall.id}（{formatPercent(bestRecall.retrievalMetrics.recallAtBudget)}）
          {bestRecall.id === best.id ? (
            <>
              ，两层指标在最后一轮对上了：检索能捞回更多证据，生成层也真的答对了更多题。
            </>
          ) : (
            <>
              ，但它的成功率并不是最高——{" "}
              <span className="font-medium text-foreground">
                检索命中更多，不等于答得更对
              </span>
            </>
          )}
          {flat.length > 0 ? (
            <>
              {" "}
              也要说清楚：
              {flat
                .map(
                  ({ step, rise }) =>
                    `${step.id} 单独看没有换来更高的成功率，成本反而涨了 ${rise}%`,
                )
                .join("；")}
              。它的改动被后面的轮次继承，所以判断一个改动有没有用，本来就不能只看一轮。
            </>
          ) : null}
          {regressed.length > 0 ? (
            <>
              {" "}
              还有一轮要单独说：
              {regressed
                .map(({ step, drop, recallDelta, inherited }) => {
                  const recallNote =
                    Math.abs(recallDelta) < 0.001
                      ? "同一轮里检索层的召回率和上一轮一模一样，所以掉分不是检索变差，而是改动本身的副作用"
                      : `同一轮里检索层的召回率还涨了 ${(recallDelta * 100).toFixed(1)} 个百分点，但成功率反而掉了——说明瓶颈在生成侧`;
                  const inheritNote =
                    inherited > 0
                      ? `这个改动被后面 ${inherited} 轮一路继承了下去，最终那一轮做到了 ${formatPercent(best.summary.successRate)}。`
                      : "";
                  return `${step.id} 单独看把成功率拉低了 ${drop.toFixed(1)} 个百分点——${recallNote}。${inheritNote}`;
                })
                .join("；")}
              一个单独看是负收益的改动，把它从曲线里抹掉，就没法知道后面的收益有多少来自它——
              所以失败的轮次不能删。
            </>
          ) : null}
        </p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <CardShell
          title="检索涨了，生成跟上来了吗"
          description="两条线放在一起看：检索层的证据召回率是上限，生成层的成功率受它约束。两层走势能对上，才说明改的地方真起作用了。"
        >
          <ChartContainer config={progressConfig} className="h-[260px] w-full">
            <LineChart data={progress} margin={{ left: 4, right: 8, top: 16 }}>
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
                          {name === "successRate" ? "成功率" : "证据召回率"}
                        </span>
                        <span className="font-mono font-medium tabular-nums">
                          {formatPercent(Number(value))}
                        </span>
                      </div>
                    )}
                    labelFormatter={(_label, payload) => {
                      const entry = payload?.[0]?.payload as
                        | { title?: string }
                        | undefined;
                      return entry?.title ?? "";
                    }}
                  />
                }
              />
              <Line
                dataKey="recall"
                type="monotone"
                stroke="var(--color-recall)"
                strokeWidth={2}
                dot={{ r: 3 }}
                isAnimationActive={false}
              />
              <Line
                dataKey="successRate"
                type="monotone"
                stroke="var(--color-successRate)"
                strokeWidth={2}
                dot={{ r: 3 }}
                isAnimationActive={false}
              />
              <ChartLegend content={<ChartLegendContent />} />
            </LineChart>
          </ChartContainer>
        </CardShell>

        <CardShell
          title="每一轮的代价"
          description="上下文变大会直接换算成 token 成本。放宽检索预算能多捞回一点证据，但账单会跟着涨。"
        >
          <ChartContainer config={costConfig} className="h-[260px] w-full">
            <BarChart data={cost} margin={{ left: 4, right: 4, top: 16 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" tickLine={false} tickMargin={8} fontSize={12} />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={48}
                fontSize={12}
                tickFormatter={(value: number) => `${Math.round(value / 1000)}k`}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    formatter={(value, name) => (
                      <div className="flex w-full items-center justify-between gap-4">
                        <span className="text-muted-foreground">
                          {name === "cost" ? "本轮成本" : "上下文字符"}
                        </span>
                        <span className="font-mono font-medium tabular-nums">
                          {name === "cost"
                            ? `¥${Number(value).toFixed(4)}`
                            : formatNumber(Number(value))}
                        </span>
                      </div>
                    )}
                    labelFormatter={(_label, payload) => {
                      const entry = payload?.[0]?.payload as
                        | { title?: string }
                        | undefined;
                      return entry?.title ?? "";
                    }}
                  />
                }
              />
              <Bar dataKey="context" radius={[4, 4, 0, 0]} isAnimationActive={false}>
                {cost.map((item) => (
                  <Cell key={item.label} fill="var(--color-context)" />
                ))}
                <LabelList
                  dataKey="cost"
                  position="top"
                  formatter={(value) => `¥${Number(value).toFixed(3)}`}
                  fontSize={11}
                  fill="var(--foreground)"
                />
              </Bar>
            </BarChart>
          </ChartContainer>
        </CardShell>
      </div>

      <div className="table-scroll overflow-x-auto">
        <table className="eval-table w-full min-w-[820px] text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="py-2 pr-3 font-medium">轮次</th>
              <th className="py-2 pr-3 font-medium">这一轮改了什么</th>
              <th className="py-2 pr-3 text-right font-medium">成功率</th>
              <th className="py-2 pr-3 text-right font-medium">judge 均分</th>
              <th className="py-2 pr-3 text-right font-medium">证据召回</th>
              <th className="py-2 pr-3 text-right font-medium">上下文</th>
              <th className="py-2 text-right font-medium">成本</th>
            </tr>
          </thead>
          <tbody>
            {ladder.map((step, index) => {
              const previous = index > 0 ? ladder[index - 1] : undefined;
              const delta = previous
                ? step.summary.successRate - previous.summary.successRate
                : 0;
              return (
                <tr key={step.id} className="border-b last:border-0 align-top">
                  <td className="py-2 pr-3">
                    <div className="font-mono text-xs">{step.id}</div>
                    <div className="font-sans text-xs">{step.title}</div>
                  </td>
                  <td className="py-2 pr-3 text-xs text-muted-foreground">
                    {step.change}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono tabular-nums">
                    {formatPercent(step.summary.successRate)}
                    {previous && Math.abs(delta) > 0.001 ? (
                      <span
                        className={`ml-1 text-[11px] ${
                          delta > 0 ? "text-chart-2" : "text-chart-1"
                        }`}
                      >
                        {delta > 0 ? "+" : ""}
                        {(delta * 100).toFixed(1)} pt
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono tabular-nums">
                    {step.summary.avgJudgeScore.toFixed(2)}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono tabular-nums">
                    {formatPercent(step.retrievalMetrics.recallAtBudget)}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono tabular-nums">
                    {formatNumber(step.retrievalMetrics.avgContextChars)}
                  </td>
                  <td className="py-2 text-right font-mono tabular-nums">
                    ¥{step.summary.totalCost.toFixed(4)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <FlipAnalysis />
    </div>
  );
}

/**
 * 逐题的翻转：哪道题在第几轮被修好了，哪道题从头到尾都没修好。
 *
 * 这是阶梯最有说服力的部分——不是总分涨了几个点，
 * 而是能指出具体是哪几道题、卡在哪一轮。
 */
function FlipAnalysis() {
  const runsByStep = ladder.map((step) => ({
    step,
    run: ladderRuns.find((run) => run.runId === step.runId),
  }));

  if (runsByStep.some((item) => !item.run)) return null;

  const questionIds = [...new Set(runsByStep[0].run!.cases.map((c) => c.questionId))].sort(
    (a, b) => a.localeCompare(b, undefined, { numeric: true }),
  );

  const threshold = runsByStep[0].run!.summary.successThreshold;
  const categoryOf = new Map(
    runsByStep[0].run!.cases.map((c) => [c.questionId, c.category]),
  );

  const rows = questionIds.map((questionId) => {
    const scores = runsByStep.map(({ run }) => {
      const entry = run!.cases.find((c) => c.questionId === questionId);
      return entry?.judgeScore ?? 0;
    });
    const passes = scores.map((score) => score >= threshold);
    const firstPass = passes.findIndex(Boolean);
    return {
      questionId,
      category: categoryOf.get(questionId) as QuestionCategory,
      scores,
      passes,
      /** 第一次达标的轮次，从 0 开始；-1 表示全程没达标 */
      fixedAt: firstPass === -1 ? -1 : firstPass,
    };
  });

  const improved = rows.filter((row) => row.fixedAt > 0);
  const neverPassed = rows.filter((row) => row.fixedAt === -1);
  const alwaysPassed = rows.filter((row) => row.fixedAt === 0);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-col gap-2">
        <h3 className="text-base font-semibold">逐题翻转：到底修好了哪几道题</h3>
        <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
          总分只涨了几个点，说不清改动的效果。这里逐题看：每一行是一道题，
          每一列是一轮，格子是 judge 打分。绿色是达标，橙色是没达标。
          {improved.length > 0 ? (
            <>
              {" "}
              <span className="font-medium text-foreground">
                {improved.length} 道题是在某一轮被修好的
              </span>
              ，其中 {improved.filter((row) => row.fixedAt === 1).length} 道题在换切分方式那一轮就修好了。
            </>
          ) : null}
        </p>
      </div>

      <details className="group rounded-lg border bg-card">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium text-foreground">
          <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
          逐题翻转矩阵（{rows.length} 题 × {ladder.length} 轮）
          <span className="text-xs font-normal text-muted-foreground">
            哪道题在第几轮被修好
          </span>
        </summary>
        <div className="table-scroll overflow-x-auto px-4 pb-4">
          <table className="w-full min-w-[560px] border-separate border-spacing-0.5 text-sm">
          <thead>
            <tr>
              <th className="w-16 pb-2 text-left text-xs font-medium text-muted-foreground">
                题目
              </th>
              <th className="pb-2 text-left text-xs font-medium text-muted-foreground">
                类别
              </th>
              {ladder.map((step) => (
                <th
                  key={step.id}
                  className="pb-2 text-center text-xs font-medium text-muted-foreground"
                  title={step.title}
                >
                  {step.id}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.questionId}>
                <td className="py-1 pr-2 font-mono text-xs">{row.questionId}</td>
                <td className="py-1 pr-2 text-xs text-muted-foreground">
                  {CATEGORY_LABEL[row.category]}
                </td>
                {row.scores.map((score, index) => (
                  <td key={index} className="p-0">
                    <div
                      title={`${ladder[index].id} · judge ${score}/5`}
                      className={`flex h-8 items-center justify-center rounded text-[11px] font-mono tabular-nums ${
                        row.passes[index]
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
              {runsByStep.map(({ run }) => (
                <td
                  key={run!.runId}
                  className="pt-2 text-center text-xs font-mono tabular-nums text-muted-foreground"
                >
                  {run!.cases.filter((c) => c.judgeScore >= threshold).length}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
        </div>
      </details>

      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-chart-2/25 px-2.5 py-0.5 font-medium text-chart-2">
          ≥ {threshold} 分 达标
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-chart-1/15 px-2.5 py-0.5 font-medium text-chart-1">
          &lt; {threshold} 分 未达标
        </span>
        <span>
          {alwaysPassed.length} 道题一开始就能答对，{improved.length}{" "}
          道题在迭代中被修好，{neverPassed.length} 道题到最后一轮仍然没答对。
        </span>
      </div>
    </div>
  );
}

function CardShell({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-xl border bg-card px-5 py-4 shadow-sm">
      <div className="mb-3">
        <div className="text-base font-semibold">{title}</div>
        <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {description}
        </div>
      </div>
      {children}
    </div>
  );
}
