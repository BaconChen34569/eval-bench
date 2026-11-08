import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  XAxis,
  YAxis,
} from "recharts";

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { formatNumber, formatPercent, strategies } from "@/data/report";

const qualityConfig = {
  recallAt1: { label: "recall@1", color: "var(--chart-1)" },
  recallAt3: { label: "recall@3", color: "var(--chart-3)" },
  recallAt6: { label: "recall@6", color: "var(--chart-2)" },
} satisfies ChartConfig;

const costConfig = {
  context: { label: "送入模型的上下文字符数", color: "var(--chart-4)" },
} satisfies ChartConfig;

export function StrategyQualityChart() {
  const data = strategies.map((item) => ({
    label: item.strategy.label,
    recallAt1: item.recallAt1,
    recallAt3: item.recallAt3,
    recallAt6: item.recallAt6,
  }));

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <ChartContainer config={qualityConfig} className="h-[280px] w-full">
        <BarChart data={data} margin={{ left: 4, right: 4, top: 16 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="label" tickLine={false} tickMargin={8} fontSize={12} />
          <YAxis
            domain={[0, 0.6]}
            tickLine={false}
            axisLine={false}
            width={44}
            fontSize={12}
            tickFormatter={(value: number) => `${Math.round(value * 100)}%`}
          />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Bar dataKey="recallAt1" fill="var(--color-recallAt1)" radius={[4, 4, 0, 0]} isAnimationActive={false} />
          <Bar dataKey="recallAt3" fill="var(--color-recallAt3)" radius={[4, 4, 0, 0]} isAnimationActive={false} />
          <Bar dataKey="recallAt6" fill="var(--color-recallAt6)" radius={[4, 4, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ChartContainer>
      <details className="group rounded-lg border bg-secondary px-3 py-2">
        <summary className="cursor-pointer list-none text-xs text-muted-foreground transition-colors hover:text-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span className="transition-transform group-open:rotate-90">›</span>
            看数据表
          </span>
        </summary>
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="py-1.5 pr-3 font-medium">策略</th>
              <th className="py-1.5 pr-3 text-right font-medium">recall@1</th>
              <th className="py-1.5 pr-3 text-right font-medium">recall@3</th>
              <th className="py-1.5 text-right font-medium">recall@6</th>
            </tr>
          </thead>
          <tbody className="font-mono tabular-nums">
            {data.map((item) => (
              <tr key={item.label} className="border-b last:border-0">
                <td className="py-1.5 pr-3 font-sans">{item.label}</td>
                <td className="py-1.5 pr-3 text-right">{formatPercent(item.recallAt1)}</td>
                <td className="py-1.5 pr-3 text-right">{formatPercent(item.recallAt3)}</td>
                <td className="py-1.5 text-right">{formatPercent(item.recallAt6)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

export function StrategyCostChart() {
  const data = strategies.map((item) => ({
    label: item.strategy.label,
    context: item.avgContextChars,
    chunks: item.chunkCount,
  }));

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <ChartContainer config={costConfig} className="h-[280px] w-full">
        <BarChart data={data} margin={{ left: 4, right: 4, top: 16 }}>
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
                formatter={(value, name) => {
                  if (name === "context") {
                    return (
                      <div className="flex w-full items-center justify-between gap-4">
                        <span className="text-muted-foreground">上下文字符</span>
                        <span className="font-mono font-medium tabular-nums">
                          {Number(value).toLocaleString("zh-CN")}
                        </span>
                      </div>
                    );
                  }
                  return null;
                }}
              />
            }
          />
          <Bar dataKey="context" radius={[4, 4, 0, 0]} isAnimationActive={false}>
            {data.map((item) => (
              <Cell key={item.label} fill="var(--color-context)" />
            ))}
            <LabelList
              dataKey="chunks"
              position="top"
              formatter={(value) => `${value} 块`}
              fontSize={11}
              fill="var(--muted-foreground)"
            />
          </Bar>
        </BarChart>
      </ChartContainer>
      <details className="group rounded-lg border bg-secondary px-3 py-2">
        <summary className="cursor-pointer list-none text-xs text-muted-foreground transition-colors hover:text-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span className="transition-transform group-open:rotate-90">›</span>
            看数据表
          </span>
        </summary>
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="py-1.5 pr-3 font-medium">策略</th>
              <th className="py-1.5 pr-3 text-right font-medium">上下文字符</th>
              <th className="py-1.5 text-right font-medium">代码块数</th>
            </tr>
          </thead>
          <tbody className="font-mono tabular-nums">
            {data.map((item) => (
              <tr key={item.label} className="border-b last:border-0">
                <td className="py-1.5 pr-3 font-sans">{item.label}</td>
                <td className="py-1.5 pr-3 text-right">
                  {formatNumber(item.context)}
                </td>
                <td className="py-1.5 text-right">{item.chunks}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
