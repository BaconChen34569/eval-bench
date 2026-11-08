import {
  baseline,
  bestRun,
  CATEGORY_LABEL,
  changes,
  formatNumber,
  formatPercent,
  strategies,
  type QuestionCategory,
} from "@/data/report";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

/**
 * 优化前后对比。
 *
 * 对比的前提是两边口径一致：同一批题、同一个模型、同一把 judge 尺子、
 * 同一套成功线。左边是上一版评测台跑出来的那次记录（从旧报告里原样搬过来，
 * 不是手写的数字），右边是当前版本的同口径记录。
 */
export function BaselineSection() {
  if (!baseline || !bestRun) return null;

  const currentStrategy = strategies.find(
    (item) => item.strategy.id === bestRun.chunking.id,
  );

  const rows: {
    label: string;
    before: number;
    after: number;
    format: (value: number) => string;
    better: "high" | "low";
  }[] = [
    {
      label: "成功率",
      before: baseline.summary.successRate,
      after: bestRun.summary.successRate,
      format: (value: number) => formatPercent(value),
      better: "high",
    },
    {
      label: "judge 均分",
      before: baseline.summary.avgJudgeScore,
      after: bestRun.summary.avgJudgeScore,
      format: (value: number) => value.toFixed(2),
      better: "high",
    },
    {
      label: "证据召回率",
      before: baseline.retrievalMetrics.recallAt6,
      after: currentStrategy?.recallAt6 ?? 0,
      format: (value: number) => formatPercent(value),
      better: "high",
    },
    {
      label: "MRR",
      before: baseline.retrievalMetrics.mrr,
      after: currentStrategy?.mrr ?? 0,
      format: (value: number) => value.toFixed(3),
      better: "high",
    },
    {
      label: "平均上下文（字符，越低越好）",
      before: baseline.retrievalMetrics.avgContextChars,
      after: currentStrategy?.avgContextChars ?? 0,
      format: (value: number) => formatNumber(Math.round(value)),
      better: "low",
    },
    {
      label: "切出的代码块数（越少越好）",
      before: baseline.retrievalMetrics.chunkCount,
      after: currentStrategy?.chunkCount ?? 0,
      format: (value: number) => formatNumber(value),
      better: "low",
    },
  ];

  const threshold = bestRun.summary.successThreshold;
  const beforeCases = new Map(
    baseline.cases.map((item) => [item.questionId, item]),
  );
  const flips = bestRun.cases
    .map((item) => {
      const before = beforeCases.get(item.questionId);
      return {
        questionId: item.questionId,
        category: item.category,
        before: before?.judgeScore ?? 0,
        after: item.judgeScore,
        delta: item.judgeScore - (before?.judgeScore ?? 0),
      };
    })
    .sort((a, b) => b.delta - a.delta);

  const improved = flips.filter((item) => item.delta > 0);
  const regressed = flips.filter((item) => item.delta < 0);
  const fixed = flips.filter(
    (item) => item.before < threshold && item.after >= threshold,
  );
  const stillFailing = flips.filter((item) => item.after < threshold);
  const rateDelta =
    bestRun.summary.successRate - baseline.summary.successRate;

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-xl border border-chart-2/30 bg-chart-2/10 px-5 py-4">
        <p className="text-sm leading-relaxed">
          同一批 {flips.length} 道题、同一个模型{" "}
          <span className="font-mono">{baseline.model}</span>、同一把 judge 尺子、
          同样 {">="} {threshold} 分的成功线，成功率从{" "}
          <span className="font-mono">
            {formatPercent(baseline.summary.successRate)}
          </span>{" "}
          变成{" "}
          <span className="font-mono text-chart-2">
            {formatPercent(bestRun.summary.successRate)}
          </span>
          {"（"}
          {(Math.abs(rateDelta) * 100).toFixed(1)} 个百分点）。{" "}
          {regressed.length > 0
            ? `有 ${regressed.length} 道题分数反而降了，这些也一并列在下面——改进不是单向的。`
            : "没有一道题的分数倒退。"}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">同一把尺子下的两项对比</CardTitle>
          <CardDescription>
            左栏是上一版（代码版本 {baseline.codeVersion}，
            {baseline.chunking.label}），右栏是当前版本
            （{bestRun.chunking.label}）。条形长度按两栏的最大值归一化。
            两栏取的都是「三种切分策略横向对比」里最好的那一次——
            迭代阶梯里的数字属于另一组配置，放在下一节。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {rows.map((row) => (
            <CompareRow key={row.label} {...row} />
          ))}
        </CardContent>
      </Card>

      {changes.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">数字为什么动了：这一版改了什么</CardTitle>
            <CardDescription>
              下面是代码层面的改动，不是结论。每一项都是独立的一处修改，
              数字变化是它们合起来的结果。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-2 text-sm leading-relaxed text-muted-foreground">
              {changes.map((item) => (
                <li key={item} className="flex gap-2">
                  <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-chart-3" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">逐题对照：到底修好了哪几道题</CardTitle>
          <CardDescription>
            {improved.length} 道题分数变高（其中 {fixed.length} 道题从不及格变成及格），
            {regressed.length} 道题变低，{stillFailing.length} 道题到当前版本仍然没答对。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="table-scroll overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">题目</th>
                  <th className="py-2 pr-3 font-medium">类别</th>
                  <th className="py-2 pr-3 text-right font-medium">旧版</th>
                  <th className="py-2 pr-3 text-right font-medium">当前</th>
                  <th className="py-2 text-right font-medium">变化</th>
                </tr>
              </thead>
              <tbody>
                {flips.map((item) => (
                  <tr key={item.questionId} className="border-b last:border-0">
                    <td className="py-2 pr-3 font-mono text-xs">
                      {item.questionId}
                    </td>
                    <td className="py-2 pr-3 text-xs text-muted-foreground">
                      {CATEGORY_LABEL[item.category as QuestionCategory]}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono tabular-nums text-muted-foreground">
                      {item.before}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono tabular-nums">
                      {item.after}
                    </td>
                    <td
                      className={`py-2 text-right font-mono tabular-nums ${
                        item.delta > 0
                          ? "text-chart-2"
                          : item.delta < 0
                            ? "text-chart-1"
                            : "text-muted-foreground"
                      }`}
                    >
                      {item.delta > 0 ? "+" : ""}
                      {item.delta}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Separator />
          <p className="text-xs leading-relaxed text-muted-foreground">
            分数涨的不代表整题都对：judge 打分是 1-5 的连续判断，
            涨 1 分可能只是补上了一个要点。反过来，
            分数没涨的题也未必完全没进步——它可能从「编造内容」变成了「要点漏了」，
            这类变化在失败归因那一节里能看到。
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function CompareRow({
  label,
  before,
  after,
  format,
  better,
}: {
  label: string;
  before: number;
  after: number;
  format: (value: number) => string;
  better: "high" | "low";
}) {
  const max = Math.max(before, after) || 1;
  const improved =
    better === "high" ? after > before : after < before;
  const width = (value: number) => `${Math.max(2, (value / max) * 100)}%`;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono tabular-nums">
          <span className="text-muted-foreground">{format(before)}</span>
          <span className="mx-1.5 text-muted-foreground">→</span>
          <span className={improved ? "text-chart-2" : "text-foreground"}>
            {format(after)}
          </span>
        </span>
      </div>
      <div className="flex flex-col gap-1">
        <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
          <div
            className="h-full rounded-full bg-muted-foreground/40"
            style={{ width: width(before) }}
          />
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
          <div
            className={`h-full rounded-full ${
              improved ? "bg-chart-2" : "bg-chart-3"
            }`}
            style={{ width: width(after) }}
          />
        </div>
      </div>
    </div>
  );
}
