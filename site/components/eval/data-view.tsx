import {
  CATEGORY_LABEL,
  DIFFICULTY_LABEL,
  FAILURE_LABEL,
  formatNumber,
  formatPercent,
  ladder,
  modelComparison,
  questions,
  report,
  runs,
  strategies,
  summarizeRun,
  type RunCase,
} from "@/data/report";
import { CostBreakdownPopover } from "@/components/eval/cost-breakdown";
import { ExportButtons } from "@/components/eval/export-buttons";
import { OutcomeMatrix } from "@/components/eval/outcome-matrix";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useMemo, useState } from "react";

/**
 * 数据视图：给想自己看数的人准备的密集表格。
 * 叙事视图负责把结论讲清楚，这个视图负责让每个数字都能查到、能筛、能导出。
 */
export function DataView() {
  const [keyword, setKeyword] = useState("");
  const comparison = modelComparison;

  const rows = useMemo(() => {
    const key = keyword.trim().toLowerCase();
    const out: {
      question: (typeof questions)[number];
      cells: {
        run: (typeof runs)[number];
        entry: RunCase | undefined;
        recallAt6: number;
        firstHitRank: number;
      }[];
    }[] = [];

    for (const question of questions) {
      if (
        key &&
        !question.question.toLowerCase().includes(key) &&
        !question.questionId.toLowerCase().includes(key)
      ) {
        continue;
      }
      out.push({
        question,
        cells: runs.map((run) => {
          const entry = run.cases.find(
            (item) => item.questionId === question.questionId,
          );
          const retrieval = strategies
            .find((item) => item.strategy.id === run.chunking.id)
            ?.cases.find((item) => item.questionId === question.questionId);
          return {
            run,
            entry,
            recallAt6: retrieval?.recallAt6 ?? 0,
            firstHitRank: retrieval?.firstHitRank ?? 0,
          };
        }),
      });
    }
    return out;
  }, [keyword, questions, runs, strategies]);

  return (
    <div id="data-view" className="flex flex-col gap-6">
      <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">
          先说清楚范围：
        </span>
        本视图里的全部数字都来自{" "}
        <span className="font-mono text-foreground">Flask 3.1.3</span>{" "}
        这一个仓库（多模型对比一节是同一批 Flask 题换模型、换尺子重打）。
        跨仓库的横向对比在叙事视图的「多项目对比」一节。
      </p>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">策略总览</CardTitle>
          <CardDescription>
            一行一种切分策略，检索层和生成层的指标并排放，方便横向比对。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="table-scroll overflow-x-auto">
            <table className="eval-table eval-table-dense w-full min-w-[900px] text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">策略</th>
                  <th className="py-2 pr-3 text-right font-medium">代码块</th>
                  <th className="py-2 pr-3 text-right font-medium">上下文字符</th>
                  <th className="py-2 pr-3 text-right font-medium">recall@1</th>
                  <th className="py-2 pr-3 text-right font-medium">recall@6</th>
                  <th className="py-2 pr-3 text-right font-medium">MRR</th>
                  <th className="py-2 pr-3 text-right font-medium">成功率</th>
                  <th className="py-2 pr-3 text-right font-medium">judge 均分</th>
                  <th className="py-2 pr-3 text-right font-medium">P95 延迟</th>
                  <th className="py-2 text-right font-medium">总成本</th>
                </tr>
              </thead>
              <tbody className="font-mono tabular-nums">
                {strategies.map((item) => (
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
                      {formatPercent(item.recallAt6)}
                    </td>
                    <td className="py-2 pr-3 text-right">{item.mrr.toFixed(3)}</td>
                    <td className="py-2 pr-3 text-right">
                      {item.successRate !== undefined
                        ? formatPercent(item.successRate)
                        : "-"}
                    </td>
                    <td className="py-2 pr-3 text-right">
                      {item.avgJudgeScore !== undefined
                        ? item.avgJudgeScore.toFixed(2)
                        : "-"}
                    </td>
                    <td className="py-2 pr-3 text-right">
                      {item.p95LatencyMs !== undefined
                        ? `${formatNumber(item.p95LatencyMs)} ms`
                        : "-"}
                    </td>
                    <td className="py-2 text-right">
                      {item.totalCost !== undefined
                        ? `${report.costCurrency}${item.totalCost.toFixed(4)}`
                        : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <CostBreakdownPopover />
            <span className="text-xs text-muted-foreground">
              数据集 {report.datasetId} · 仓库 {report.repo} ·{" "}
              {questions.length} 题 · {formatNumber(strategies[0]?.totalRepoLines ?? 0)} 行
            </span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">运行记录</CardTitle>
          <CardDescription>
            每次运行的条件和花费，含 agent 与 judge 两次调用的 token 构成。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="table-scroll overflow-x-auto">
            <table className="eval-table eval-table-dense w-full min-w-[820px] text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">策略</th>
                  <th className="py-2 pr-3 font-medium">模型</th>
                  <th className="py-2 pr-3 font-medium">开始</th>
                  <th className="py-2 pr-3 font-medium">结束</th>
                  <th className="py-2 pr-3 text-right font-medium">agent 输入</th>
                  <th className="py-2 pr-3 text-right font-medium">judge 输入</th>
                  <th className="py-2 pr-3 text-right font-medium">输出</th>
                  <th className="py-2 text-right font-medium">总成本</th>
                </tr>
              </thead>
              <tbody className="font-mono tabular-nums">
                {runs.map((run) => {
                  const s = summarizeRun(run);
                  const started = new Date(run.startedAt);
                  const finished = new Date(run.finishedAt);
                  const fmt = (d: Date) =>
                    `${String(d.getMonth() + 1).padStart(2, "0")}-${String(
                      d.getDate(),
                    ).padStart(2, "0")} ${String(d.getHours()).padStart(
                      2,
                      "0",
                    )}:${String(d.getMinutes()).padStart(2, "0")}`;
                  return (
                    <tr key={run.runId} className="border-b last:border-0">
                      <td className="py-2 pr-3 font-sans">{run.chunking.label}</td>
                      <td className="py-2 pr-3 text-xs">{run.model}</td>
                      <td className="py-2 pr-3 text-xs">{fmt(started)}</td>
                      <td className="py-2 pr-3 text-xs">{fmt(finished)}</td>
                      <td className="py-2 pr-3 text-right">
                        {formatNumber(
                          s.agentCacheHitTokens + s.agentCacheMissTokens,
                        )}
                      </td>
                      <td className="py-2 pr-3 text-right">
                        {formatNumber(s.judgePromptTokens)}
                      </td>
                      <td className="py-2 pr-3 text-right">
                        {formatNumber(
                          s.agentCompletionTokens + s.judgeCompletionTokens,
                        )}
                      </td>
                      <td className="py-2 text-right">
                        {report.costCurrency}
                        {s.totalCost.toFixed(4)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

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

      <Card>
        <CardHeader>
          <CardTitle className="text-base">逐题明细</CardTitle>
          <CardDescription>
            每行一道题，列出三种策略下的召回、首个命中排名、judge 分数和失败类型。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="筛选题号或题干，例如 q07"
            className="mb-4 max-w-sm"
          />
          <div className="table-scroll overflow-x-auto">
            <table className="eval-table eval-table-dense w-full min-w-[900px] text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">题号</th>
                  <th className="py-2 pr-3 font-medium">类别</th>
                  <th className="py-2 pr-3 font-medium">难度</th>
                  {runs.map((run) => (
                    <th
                      key={run.runId}
                      className="py-2 pr-3 text-right font-medium"
                    >
                      {run.chunking.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(({ question, cells }) => (
                  <tr key={question.questionId} className="border-b last:border-0">
                    <td className="py-2 pr-3 font-mono text-xs">
                      {question.questionId}
                    </td>
                    <td className="py-2 pr-3 text-xs">
                      {CATEGORY_LABEL[question.category]}
                    </td>
                    <td className="py-2 pr-3 text-xs text-muted-foreground">
                      {DIFFICULTY_LABEL[question.difficulty]}
                    </td>
                    {cells.map(({ run, entry, recallAt6, firstHitRank }) => {
                      const pass =
                        entry &&
                        entry.judgeScore >= run.summary.successThreshold;
                      return (
                        <td
                          key={run.runId}
                          className="py-2 pr-3 text-right font-mono text-xs tabular-nums"
                        >
                          <div
                            className={
                              pass ? "text-chart-2" : "text-muted-foreground"
                            }
                          >
                            {entry ? `${entry.judgeScore}/5` : "-"}
                          </div>
                          <div className="text-[10px] text-muted-foreground">
                            r6 {formatPercent(recallAt6)}
                            {firstHitRank > 0 ? ` · #${firstHitRank}` : ""}
                          </div>
                          {entry?.failureKind && (
                            <div className="text-[10px] text-chart-1">
                              {FAILURE_LABEL[entry.failureKind]}
                            </div>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            共 {rows.length} / {questions.length} 题
          </p>
        </CardContent>
      </Card>

      {ladder.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">迭代阶梯</CardTitle>
            <CardDescription>
              每一轮只相对上一轮改一个变量，其余全部锁死，所以轮与轮之间可以直接比。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="table-scroll overflow-x-auto">
              <table className="eval-table eval-table-dense w-full min-w-[900px] text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">轮次</th>
                    <th className="py-2 pr-3 font-medium">改动</th>
                    <th className="py-2 pr-3 text-right font-medium">topK</th>
                    <th className="py-2 pr-3 text-right font-medium">重排</th>
                    <th className="py-2 pr-3 font-medium">提示词</th>
                    <th className="py-2 pr-3 text-right font-medium">recall@预算</th>
                    <th className="py-2 pr-3 text-right font-medium">成功率</th>
                    <th className="py-2 pr-3 text-right font-medium">judge 均分</th>
                    <th className="py-2 pr-3 text-right font-medium">上下文</th>
                    <th className="py-2 text-right font-medium">总成本</th>
                  </tr>
                </thead>
                <tbody className="font-mono tabular-nums">
                  {ladder.map((step) => (
                    <tr key={step.id} className="border-b last:border-0">
                      <td className="py-2 pr-3 font-sans">
                        {step.id} · {step.title}
                      </td>
                      <td className="py-2 pr-3 font-sans text-xs text-muted-foreground">
                        {step.change}
                      </td>
                      <td className="py-2 pr-3 text-right">{step.retrieval.topK}</td>
                      <td className="py-2 pr-3 text-right">
                        {step.retrieval.rerankMode ?? "none"}
                      </td>
                      <td className="py-2 pr-3 font-sans text-xs">
                        {step.promptVersion}
                      </td>
                      <td className="py-2 pr-3 text-right">
                        {formatPercent(step.retrievalMetrics.recallAtBudget)}
                      </td>
                      <td className="py-2 pr-3 text-right">
                        {formatPercent(step.summary.successRate)}
                      </td>
                      <td className="py-2 pr-3 text-right">
                        {step.summary.avgJudgeScore.toFixed(2)}
                      </td>
                      <td className="py-2 pr-3 text-right">
                        {formatNumber(step.retrievalMetrics.avgContextChars)}
                      </td>
                      <td className="py-2 text-right">
                        {report.costCurrency}
                        {step.summary.totalCost.toFixed(4)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {comparison && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">多模型对比</CardTitle>
            <CardDescription>
              同一份配置下换被测模型，每把尺子各量一遍。
              主尺子是量所有模型的那一把，其余尺子只给同一批答案重新打分。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="table-scroll overflow-x-auto">
              <table className="eval-table eval-table-dense w-full min-w-[820px] text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">被测模型</th>
                    {comparison.judges.map((judge) => (
                      <th
                        key={judge.model}
                        className="py-2 pr-3 text-right font-medium"
                      >
                        {judge.label}
                        {judge.model === comparison.primaryJudge ? (
                          <span className="ml-1 text-[10px] text-muted-foreground">
                            主尺子
                          </span>
                        ) : null}
                      </th>
                    ))}
                    <th className="py-2 pr-3 text-right font-medium">平均</th>
                    <th className="py-2 pr-3 text-right font-medium">证据召回</th>
                    <th className="py-2 pr-3 text-right font-medium">延迟</th>
                    <th className="py-2 text-right font-medium">总成本</th>
                  </tr>
                </thead>
                <tbody className="font-mono tabular-nums">
                  {comparison.rows.map((row) => (
                    <tr key={row.agentProfile} className="border-b last:border-0">
                      <td className="py-2 pr-3 font-sans">
                        {row.agentProfileLabel}
                        <div className="font-mono text-xs text-muted-foreground">
                          {row.agentModel}
                        </div>
                      </td>
                      {row.cells.map((cell) => (
                        <td key={cell.judgeModel} className="py-2 pr-3 text-right">
                          {formatPercent(cell.successRate)}
                        </td>
                      ))}
                      <td className="py-2 pr-3 text-right">
                        {formatPercent(row.avgSuccessRate)}
                      </td>
                      <td className="py-2 pr-3 text-right">
                        {formatPercent(row.avgEvidenceRecall)}
                      </td>
                      <td className="py-2 pr-3 text-right">
                        {formatNumber(row.avgLatencyMs)}
                      </td>
                      <td className="py-2 text-right">
                        {report.costCurrency}
                        {row.totalCost.toFixed(4)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="table-scroll mt-4 overflow-x-auto">
              <table className="eval-table eval-table-dense w-full min-w-[620px] text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">两把尺子</th>
                    <th className="py-2 pr-3 text-right font-medium">一致率</th>
                    <th className="py-2 pr-3 text-right font-medium">完全同分</th>
                    <th className="py-2 text-right font-medium">翻转判定数</th>
                  </tr>
                </thead>
                <tbody className="font-mono tabular-nums">
                  {comparison.agreementMatrix.map((item) => (
                    <tr
                      key={`${item.judgeA}-${item.judgeB}`}
                      className="border-b last:border-0"
                    >
                      <td className="py-2 pr-3 font-sans">
                        {item.judgeA} ↔ {item.judgeB}
                      </td>
                      <td className="py-2 pr-3 text-right">
                        {formatPercent(item.agreement)}
                      </td>
                      <td className="py-2 pr-3 text-right">
                        {formatPercent(item.exactAgreement)}
                      </td>
                      <td className="py-2 text-right">
                        {item.flips} / {item.sampled}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="table-scroll mt-4 overflow-x-auto">
              <table className="eval-table eval-table-dense w-full min-w-[620px] text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">尺子</th>
                    <th className="py-2 pr-3 text-right font-medium">本家均分</th>
                    <th className="py-2 pr-3 text-right font-medium">他家均分</th>
                    <th className="py-2 pr-3 text-right font-medium">差值</th>
                    <th className="py-2 text-right font-medium">本家名次</th>
                  </tr>
                </thead>
                <tbody className="font-mono tabular-nums">
                  {comparison.selfPreference.map((item) => (
                    <tr
                      key={item.judgeModel}
                      className="border-b last:border-0"
                    >
                      <td className="py-2 pr-3 font-sans">
                        {item.judgeProfileLabel}
                      </td>
                      <td className="py-2 pr-3 text-right">
                        {item.ownAvgScore.toFixed(2)}
                      </td>
                      <td className="py-2 pr-3 text-right">
                        {item.otherAvgScore.toFixed(2)}
                      </td>
                      <td className="py-2 pr-3 text-right">
                        {item.gap >= 0 ? "+" : ""}
                        {item.gap.toFixed(2)}
                      </td>
                      <td className="py-2 text-right">{item.ownRank}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">导出数据</CardTitle>
          <CardDescription>
            页面上的每个数字都能带走——CSV 可直接进 Excel，JSON 是评测流水线产出的原始报告。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ExportButtons />
        </CardContent>
      </Card>
    </div>
  );
}
