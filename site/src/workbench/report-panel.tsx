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
import { LadderSection } from "@/components/eval/ladder-section";
import { ModelComparisonSection } from "@/components/eval/model-comparison-section";
import {
  StrategyCostChart,
  StrategyQualityChart,
} from "@/components/eval/strategy-charts";
import {
  formatNumber,
  formatPercent,
  ladder,
  modelComparison,
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
export function ReportPanel({
  variant,
}: {
  /** 哪个模块的结果区：每个模块各自有各自的空状态引导。 */
  variant: "load" | "dataset" | "gen";
}) {
  if (strategies.length === 0) {
    return (
      <div className="rounded-lg border bg-card px-4 py-6 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">这里还没有数据</p>
        {variant === "load" ? (
          <>
            <p className="mt-2">上面点「载入 report.json」就能出图：</p>
            <ul className="mt-2 flex list-disc flex-col gap-1 pl-5">
              <li>
                直接读评测台跑出来的产物（harness/out/report.json）；
              </li>
              <li>
                或者把从别处拿到的报告 JSON 粘进上面的框里。
              </li>
            </ul>
          </>
        ) : variant === "dataset" ? (
          <>
            <p className="mt-2">这个模块的结果来自你在这里跑的评测：</p>
            <ul className="mt-2 flex list-disc flex-col gap-1 pl-5">
              <li>上面录几道题，先点「校验证据」确认行号没抄错；</li>
              <li>再点「跑检索评测」，结果会直接送到这里。</li>
            </ul>
          </>
        ) : (
          <>
            <p className="mt-2">这个模块的结果来自生成层评测：</p>
            <ul className="mt-2 flex list-disc flex-col gap-1 pl-5">
              <li>上面选好题集和模型，点「开始跑」；</li>
              <li>
                跑完的策略总览、胜负矩阵、迭代阶梯和多模型对比都会送到这里。
              </li>
            </ul>
          </>
        )}
        <p className="mt-2 text-xs">
          这页不预置示例数据：看到的每个数字都来自你自己跑出来的那一份。
        </p>
      </div>
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
              只列这次真跑过的题——没跑的题不会画成 0 分。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <OutcomeMatrix />
          </CardContent>
        </Card>
      )}

      {ladder.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">迭代阶梯</CardTitle>
            <CardDescription>
              工具自己一轮轮改好，每轮只改一个变量，用同一套协议重跑。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <LadderSection />
          </CardContent>
        </Card>
      )}

      {modelComparison && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">多模型对比</CardTitle>
            <CardDescription>
              同一份配置换被测模型，再用好几把尺子各量一遍。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ModelComparisonSection />
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
