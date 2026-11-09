import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { OutcomeMatrix } from "@/components/eval/outcome-matrix";
import { QuestionExplorer } from "@/components/eval/question-explorer";
import { ExportButtons } from "@/components/eval/export-buttons";
import {
  StrategyCostChart,
  StrategyQualityChart,
} from "@/components/eval/strategy-charts";
import {
  formatNumber,
  formatPercent,
  questions,
  report,
  runs,
  strategies,
} from "@/data/report";

/**
 * 报告结果面板。
 *
 * 这里只做编排：表格、图表、逐题检索台、导出按钮
 * 都是公开站那套组件，工作台和公开站看到的是同一套实现。
 */
export function ReportPanel() {
  if (strategies.length === 0) {
    return (
      <p className="rounded-lg border bg-card px-4 py-6 text-sm text-muted-foreground">
        当前没有可展示的报告数据。粘一份 report.json，
        或者在「录题集跑评测」里跑一次检索评测。
      </p>
    );
  }

  const hasGeneration = runs.length > 0;

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">策略总览</CardTitle>
          <CardDescription>
            一行一种切分策略。检索层指标不花钱、结果可复现；
            生成层指标要调模型才拿得到。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="table-scroll overflow-x-auto">
            <table className="eval-table eval-table-dense w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">策略</th>
                  <th className="py-2 pr-3 text-right font-medium">代码块</th>
                  <th className="py-2 pr-3 text-right font-medium">上下文字符</th>
                  <th className="py-2 pr-3 text-right font-medium">recall@1</th>
                  <th className="py-2 pr-3 text-right font-medium">recall@3</th>
                  <th className="py-2 pr-3 text-right font-medium">recall@6</th>
                  <th className="py-2 pr-3 text-right font-medium">MRR</th>
                  <th className="py-2 text-right font-medium">达标题数</th>
                </tr>
              </thead>
              <tbody className="font-mono tabular-nums">
                {strategies.map((item) => {
                  const hit = item.cases.filter(
                    (entry) => entry.recallAt6 >= 1,
                  ).length;
                  return (
                    <tr key={item.strategy.id} className="border-b last:border-0">
                      <td className="py-2 pr-3 font-sans">{item.strategy.label}</td>
                      <td className="py-2 pr-3 text-right">{item.chunkCount}</td>
                      <td className="py-2 pr-3 text-right">
                        {formatNumber(item.avgContextChars)}
                      </td>
                      <td className="py-2 pr-3 text-right">
                        {formatPercent(item.recallAt1)}
                      </td>
                      <td className="py-2 pr-3 text-right">
                        {formatPercent(item.recallAt3)}
                      </td>
                      <td className="py-2 pr-3 text-right">
                        {formatPercent(item.recallAt6)}
                      </td>
                      <td className="py-2 pr-3 text-right">
                        {item.mrr.toFixed(3)}
                      </td>
                      <td className="py-2 text-right">
                        {hit} / {item.cases.length}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            数据集 {report.datasetId} · 仓库 {report.repo} ·{" "}
            {questions.length} 题 ·{" "}
            {formatNumber(strategies[0]?.totalRepoLines ?? 0)} 行仓库
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">检索质量</CardTitle>
            <CardDescription>
              top1 / top3 / top6 命中标准答案证据的比例。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <StrategyQualityChart />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">送进模型的上下文</CardTitle>
            <CardDescription>
              每道题平均送进去多少字符，以及切成了多少块。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <StrategyCostChart />
          </CardContent>
        </Card>
      </div>

      {hasGeneration && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">胜负矩阵</CardTitle>
            <CardDescription>
              每行一道题，每列一种切分策略，格子里是 judge 打分。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <OutcomeMatrix />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">逐题检索台</CardTitle>
          <CardDescription>
            标准答案要求的位置，和每种策略实际送进模型的代码块对一遍。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <QuestionExplorer />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">导出数据</CardTitle>
          <CardDescription>
            CSV 带 BOM，中文 Windows 的 Excel 双击打开也不乱码。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ExportButtons />
        </CardContent>
      </Card>
    </div>
  );
}
