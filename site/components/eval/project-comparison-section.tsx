import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  XAxis,
  YAxis,
} from "recharts";
import type { ReactNode } from "react";

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  CATEGORY_LABEL,
  formatNumber,
  formatPercent,
  multiProject,
  narrative,
  type QuestionCategory,
} from "@/data/report";

const successConfig = {
  successRate: { label: "成功率", color: "var(--chart-2)" },
} satisfies ChartConfig;

const recallConfig = {
  recall: { label: "证据召回率", color: "var(--chart-3)" },
} satisfies ChartConfig;

const CATEGORY_ORDER: QuestionCategory[] = [
  "architecture",
  "code-location",
  "debugging",
  "convention",
];

/**
 * 多项目对比：同一份配置、同一把尺子，换四个仓库各跑一轮。
 *
 * 单仓库的数字说明不了评测台本身成不成立——
 * 换个语言、换个规模、换一套目录结构之后还能量出同样的东西，才是关键。
 */
export function ProjectComparisonSection() {
  if (!multiProject || multiProject.rows.length === 0) return null;

  const rows = [...multiProject.rows].sort(
    (a, b) => b.successRate - a.successRate,
  );
  const best = rows[0];
  const worst = rows[rows.length - 1];
  const spread = best.successRate - worst.successRate;

  // 七轮阶梯迭代是在 Flask 上调的，这一行属于样本内结果。
  const tunedProject =
    rows.find((row) => row.project === "flask")?.label ?? best.label;

  const successData = rows.map((row) => ({
    label: row.label,
    successRate: row.successRate,
    successText: formatPercent(row.successRate),
  }));
  const recallData = rows.map((row) => ({
    label: row.label,
    recall: row.retrievalMetrics.recallAtBudget,
    recallText: formatPercent(row.retrievalMetrics.recallAtBudget),
  }));

  const totalQuestions = rows.reduce((sum, row) => sum + row.questions, 0);
  const totalCost = rows.reduce((sum, row) => sum + row.totalCost, 0);

  // 样本内这个偏差必须留着：AI 评语也好、模板也好，
  // 都不能把「配置是在 Flask 上调出来的」这件事说漏了。
  const biasNote = `需要交代一个偏差：七轮迭代都是在 ${tunedProject} 上调的，所以它这一行属于"样本内"；其余 ${rows.length - 1} 个项目的配置一行没在它们身上改过，才是泛化检验。`;

  return (
    <div className="flex flex-col gap-6">
      {narrative.multiProject ? (
        <div className="rounded-xl border border-chart-2/30 bg-chart-2/10 px-5 py-4">
          <p className="text-sm leading-relaxed">{narrative.multiProject}</p>
          {narrative.model ? (
            <p className="mt-2 text-xs text-muted-foreground">
              这段评语由 {narrative.model} 照着这次跑出来的数字生成，数字本身来自上面的运行记录。
            </p>
          ) : null}
          <p className="mt-2 text-sm leading-relaxed">{biasNote}</p>
        </div>
      ) : (
      <div className="rounded-xl border border-chart-2/30 bg-chart-2/10 px-5 py-4">
        <p className="text-sm leading-relaxed">
          四个项目共用同一份配置（{multiProject.chunking.label}，top-
          {multiProject.retrieval.topK}，
          {multiProject.retrieval.rerankMode === "structure-aware"
            ? "结构感知重排"
            : multiProject.retrieval.rerankMode ?? "不重排"}
          {multiProject.retrieval.queryExpansion ? "，中英术语扩展" : ""}，提示词{" "}
          {multiProject.promptVersion}），被测模型 {multiProject.rows[0].model}，
          打分模型 {multiProject.rows[0].judgeModel}。共 {totalQuestions} 道题，
          全部人工标注了参考答案与证据位置。
          <span className="font-medium text-foreground">
            同一把尺子量出 {formatPercent(spread)} 的落差
          </span>
          ：最高的是 {best.label}（{formatPercent(best.successRate)}），
          最低的是 {worst.label}（{formatPercent(worst.successRate)}）。
          这条落差本身说明尺子有区分度——它不是对所有答案都给同一个分。
          <br />
          {biasNote}
        </p>
      </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <CardShell
          title="同一把尺子，量四个仓库"
          description="柱子高度是 judge 判定的成功率。四个项目跑的是同一份配置、同一把尺子，差别只来自仓库本身。"
        >
          <ChartContainer config={successConfig} className="h-[240px] w-full">
            <BarChart data={successData} margin={{ left: 4, right: 4, top: 20 }}>
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
                    formatter={(value) => (
                      <div className="flex w-full items-center justify-between gap-4">
                        <span className="text-muted-foreground">成功率</span>
                        <span className="font-mono font-medium tabular-nums">
                          {formatPercent(Number(value))}
                        </span>
                      </div>
                    )}
                  />
                }
              />
              <Bar
                dataKey="successRate"
                radius={[4, 4, 0, 0]}
                isAnimationActive={false}
              >
                {successData.map((item) => (
                  <Cell key={item.label} fill="var(--color-successRate)" />
                ))}
                <LabelList
                  dataKey="successText"
                  position="top"
                  fontSize={11}
                  fill="var(--foreground)"
                />
              </Bar>
            </BarChart>
          </ChartContainer>
        </CardShell>

        <CardShell
          title="检索层能捞回多少"
          description="检索层的证据召回率是生成层成功率的上限。这一层不花钱、完全可复现，任何人都能跑出同样的数字。"
        >
          <ChartContainer config={recallConfig} className="h-[240px] w-full">
            <BarChart data={recallData} margin={{ left: 4, right: 4, top: 20 }}>
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
                    formatter={(value) => (
                      <div className="flex w-full items-center justify-between gap-4">
                        <span className="text-muted-foreground">证据召回率</span>
                        <span className="font-mono font-medium tabular-nums">
                          {formatPercent(Number(value))}
                        </span>
                      </div>
                    )}
                  />
                }
              />
              <Bar
                dataKey="recall"
                radius={[4, 4, 0, 0]}
                isAnimationActive={false}
              >
                {recallData.map((item) => (
                  <Cell key={item.label} fill="var(--color-recall)" />
                ))}
                <LabelList
                  dataKey="recallText"
                  position="top"
                  fontSize={11}
                  fill="var(--foreground)"
                />
              </Bar>
            </BarChart>
          </ChartContainer>
        </CardShell>
      </div>

      <div className="table-scroll overflow-x-auto">
        <table className="eval-table w-full min-w-[900px] text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="py-2 pr-3 font-medium">项目</th>
              <th className="py-2 pr-3 text-right font-medium">题数</th>
              <th className="py-2 pr-3 text-right font-medium">仓库规模</th>
              <th className="py-2 pr-3 text-right font-medium">成功率</th>
              <th className="py-2 pr-3 text-right font-medium">judge 均分</th>
              <th className="py-2 pr-3 text-right font-medium">证据召回</th>
              <th className="py-2 pr-3 text-right font-medium">recall@1</th>
              <th className="py-2 pr-3 text-right font-medium">MRR</th>
              <th className="py-2 pr-3 text-right font-medium">尺子一致率</th>
              <th className="py-2 pr-3 text-right font-medium">上下文</th>
              <th className="py-2 pr-3 text-right font-medium">延迟</th>
              <th className="py-2 text-right font-medium">成本</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.project} className="border-b last:border-0 align-top">
                <td className="py-2 pr-3">
                  <div className="font-medium">{row.label}</div>
                  <div className="font-mono text-xs text-muted-foreground">
                    {row.repo}
                  </div>
                </td>
                <td className="py-2 pr-3 text-right font-mono tabular-nums">
                  {row.questions}
                </td>
                <td className="py-2 pr-3 text-right text-xs text-muted-foreground">
                  <div className="whitespace-nowrap">
                    {row.fileCount} 文件
                  </div>
                  <div className="whitespace-nowrap font-mono tabular-nums">
                    {formatNumber(row.repoLines)} 行
                  </div>
                </td>
                <td className="py-2 pr-3 text-right font-mono tabular-nums">
                  {formatPercent(row.successRate)}
                </td>
                <td className="py-2 pr-3 text-right font-mono tabular-nums">
                  {row.avgJudgeScore.toFixed(2)}
                </td>
                <td className="py-2 pr-3 text-right font-mono tabular-nums">
                  {formatPercent(row.avgEvidenceRecall)}
                </td>
                <td className="py-2 pr-3 text-right font-mono tabular-nums">
                  {formatPercent(row.retrievalMetrics.recallAt1)}
                </td>
                <td className="py-2 pr-3 text-right font-mono tabular-nums">
                  {row.retrievalMetrics.mrr.toFixed(3)}
                </td>
                <td className="py-2 pr-3 text-right font-mono tabular-nums">
                  {row.judgeValidation ? (
                    <span title={`judge 给本项目 ${row.judgeValidation.sampled} 份人工参考答案打分，与人工评分相差不超过 1 分即算一致`}>
                      {formatPercent(row.judgeValidation.agreement)}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="py-2 pr-3 text-right font-mono tabular-nums">
                  {formatNumber(row.retrievalMetrics.avgContextChars)}
                </td>
                <td className="py-2 pr-3 text-right font-mono tabular-nums">
                  {formatNumber(row.avgLatencyMs)} ms
                </td>
                <td className="py-2 text-right font-mono tabular-nums">
                  ¥{row.totalCost.toFixed(4)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t text-xs text-muted-foreground">
              <td className="py-2 pr-3 font-medium">合计</td>
              <td className="py-2 pr-3 text-right font-mono tabular-nums">
                {totalQuestions}
              </td>
              <td />
              <td />
              <td />
              <td />
              <td />
              <td />
              <td />
              <td />
              <td />
              <td className="py-2 text-right font-mono tabular-nums">
                ¥{totalCost.toFixed(4)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <CategoryBreakdown />
    </div>
  );
}

/**
 * 分类别看：四个项目在四类题上的成功率。
 *
 * 总分会被题量摊平，看不出尺子在哪一类题上失灵。
 */
function CategoryBreakdown() {
  if (!multiProject) return null;
  const rows = multiProject.rows;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-col gap-2">
        <h3 className="text-base font-semibold">分类别看：尺子在哪一类题上失灵</h3>
        <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
          总分会被题量摊平，看不出问题出在哪一类题。
          每一格是「答对题数 / 该类总题数」，颜色越深说明这一类答得越准。
        </p>
      </div>
      <div className="table-scroll overflow-x-auto">
        <table className="eval-table w-full min-w-[560px] text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="py-2 pr-3 font-medium">项目</th>
              {CATEGORY_ORDER.map((category) => (
                <th
                  key={category}
                  className="py-2 pr-3 text-center font-medium"
                >
                  {CATEGORY_LABEL[category]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.project} className="border-b last:border-0">
                <td className="py-2 pr-3 font-medium">{row.label}</td>
                {CATEGORY_ORDER.map((category) => {
                  const bucket = row.byCategory[category];
                  if (!bucket || bucket.total === 0) {
                    return (
                      <td
                        key={category}
                        className="py-2 pr-3 text-center font-mono text-xs text-muted-foreground"
                      >
                        —
                      </td>
                    );
                  }
                  const rate = bucket.success / bucket.total;
                  return (
                    <td key={category} className="py-2 pr-3 text-center">
                      <span
                        className="inline-flex min-w-[52px] items-center justify-center rounded bg-chart-2/20 px-2 py-1 font-mono text-xs tabular-nums"
                        style={{
                          backgroundColor: `color-mix(in oklab, var(--chart-2) ${Math.round(
                            rate * 60,
                          )}%, transparent)`,
                        }}
                      >
                        {bucket.success}/{bucket.total}
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
