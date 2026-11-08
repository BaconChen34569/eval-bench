import { useState } from "react";

import {
  PRICE,
  formatNumber,
  report,
  runs,
  summarizeRun,
} from "@/data/report";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

/**
 * 成本口径拆解：把「¥0.4402」这个总数拆成
 * 命中缓存的输入 / 未命中缓存的输入 / 输出三块，
 * 并且分开 agent 调用和 judge 调用——评测里 judge 也在花钱，
 * 只算其中一边就会低估成本。
 */
export function CostBreakdownPopover() {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className="inline-flex min-h-8 items-center rounded-md border border-dashed px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:border-solid hover:text-foreground"
        aria-label="成本口径拆解"
      >
        成本怎么算的？
      </PopoverTrigger>
      <PopoverContent className="w-[26rem] p-4" align="start" side="bottom">
        <div className="flex min-w-0 flex-col gap-3">
          <div>
            <h4 className="text-sm font-semibold">成本口径拆解</h4>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              按 DeepSeek 官方价目表折算（闲时价，高峰翻倍）：
              缓存命中输入 ¥{PRICE.cacheHit}/百万 token、未命中输入 ¥
              {PRICE.prompt}/百万、输出 ¥{PRICE.completion}/百万。
              <span className="text-foreground">agent 和 judge 两次调用都计入</span>
              ，只算一边会低估成本。
            </p>
          </div>

          <div className="table-scroll overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-1.5 pr-2 font-medium">切分策略</th>
                  <th className="py-1.5 pr-2 text-right font-medium">
                    命中输入
                  </th>
                  <th className="py-1.5 pr-2 text-right font-medium">
                    未命中输入
                  </th>
                  <th className="py-1.5 pr-2 text-right font-medium">输出</th>
                  <th className="py-1.5 text-right font-medium">总成本</th>
                </tr>
              </thead>
              <tbody className="font-mono tabular-nums">
                {runs.map((run) => {
                  const s = summarizeRun(run);
                  return (
                    <tr key={run.runId} className="border-b last:border-0">
                      <td className="py-1.5 pr-2 font-sans whitespace-nowrap">
                        {run.chunking.label}
                      </td>
                      <td className="py-1.5 pr-2 text-right whitespace-nowrap">
                        {formatNumber(s.agentCacheHitTokens)}
                      </td>
                      <td className="py-1.5 pr-2 text-right whitespace-nowrap">
                        {formatNumber(
                          s.agentCacheMissTokens + s.judgePromptTokens,
                        )}
                      </td>
                      <td className="py-1.5 pr-2 text-right whitespace-nowrap">
                        {formatNumber(
                          s.agentCompletionTokens + s.judgeCompletionTokens,
                        )}
                      </td>
                      <td className="py-1.5 text-right font-semibold whitespace-nowrap">
                        {report.costCurrency}
                        {s.totalCost.toFixed(4)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="text-[11px] leading-relaxed text-muted-foreground">
            单位是 token 数。judge 那次调用的缓存命中数报告里没单独记，
            表格里的「未命中输入」把两次调用的输入合在一起显示；
            单题精确拆解见逐题视图。
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
