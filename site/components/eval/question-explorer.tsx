import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Markdown } from "@/components/eval/markdown";
import { cn } from "@/lib/utils";
import {
  CATEGORY_LABEL,
  DIFFICULTY_LABEL,
  FAILURE_LABEL,
  bestRun,
  citationHits,
  formatNumber,
  formatPercent,
  questions,
  report,
  runs,
  strategies,
  type QuestionCategory,
} from "@/data/report";

const CATEGORIES: (QuestionCategory | "all")[] = [
  "all",
  "architecture",
  "code-location",
  "debugging",
  "convention",
];

export function QuestionExplorer() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<QuestionCategory | "all">("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [runId, setRunId] = useState(bestRun.runId);
  const [expandedAnswer, setExpandedAnswer] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return questions.filter((item) => {
      if (category !== "all" && item.category !== category) return false;
      if (!keyword) return true;
      return (
        item.question.toLowerCase().includes(keyword) ||
        item.questionId.toLowerCase().includes(keyword)
      );
    });
  }, [query, category]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索题目或题号，例如 q07、session"
          className="sm:max-w-sm"
        />
        <div className="flex flex-wrap gap-2">
          {CATEGORIES.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setCategory(item)}
              className={`inline-flex min-h-8 items-center rounded-full border px-3 text-xs font-medium transition-colors ${
                category === item
                  ? "border-transparent bg-primary text-primary-foreground"
                  : "border-border text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
            >
              {item === "all" ? "全部" : CATEGORY_LABEL[item]}
            </button>
          ))}
        </div>
        <span className="text-xs text-muted-foreground sm:ml-auto">
          {filtered.length} / {questions.length} 题
        </span>
      </div>

      <ul className="flex flex-col gap-2">
        {filtered.map((item) => {
          const open = expanded === item.questionId;
          const missed = strategies.filter((strategy) => {
            const found = strategy.cases.find(
              (entry) => entry.questionId === item.questionId,
            );
            return found ? found.recallAt6 < 1 : false;
          });

          return (
            <li
              key={item.questionId}
              className="rounded-lg border bg-card transition-colors"
            >
              <button
                type="button"
                onClick={() => setExpanded(open ? null : item.questionId)}
                className="flex w-full flex-col gap-2 px-4 py-3 text-left sm:flex-row sm:items-start sm:gap-3"
                aria-expanded={open}
              >
                <span className="font-mono text-xs text-muted-foreground sm:mt-0.5">
                  {item.questionId}
                </span>
                <span className="flex-1 text-sm leading-relaxed">
                  {item.question}
                </span>
                <span className="flex shrink-0 flex-wrap items-center gap-2">
                  <Badge variant="secondary">
                    {CATEGORY_LABEL[item.category]}
                  </Badge>
                  <Badge variant="outline">
                    {DIFFICULTY_LABEL[item.difficulty]}
                  </Badge>
                  {missed.length > 0 && (
                    <Badge variant="destructive">
                      {missed.length} 种策略未命中
                    </Badge>
                  )}
                </span>
              </button>

              {open && (
                <div className="grid gap-4 border-t px-4 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
                  <div>
                    <h4 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground">
                      标准答案要求的证据
                    </h4>
                    <ul className="flex flex-col gap-2">
                      {item.gold.map((evidence) => (
                        <li
                          key={`${evidence.file}-${evidence.startLine}`}
                          className="rounded-md bg-secondary/60 px-3 py-2 font-mono text-xs"
                        >
                          <div className="text-foreground">
                            {evidence.file}:{evidence.startLine}-{evidence.endLine}
                          </div>
                          {evidence.symbol && (
                            <div className="mt-1 text-muted-foreground">
                              {evidence.symbol}
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-3">
                    {strategies.map((strategy) => {
                      const found = strategy.cases.find(
                        (entry) => entry.questionId === item.questionId,
                      );
                      const citations = found?.citations ?? [];
                      return (
                        <div key={strategy.strategy.id}>
                          <div className="mb-2 flex items-baseline justify-between gap-2">
                            <span className="text-xs font-semibold">
                              {strategy.strategy.label}
                            </span>
                            <span className="font-mono text-[11px] text-muted-foreground">
                              {found ? formatPercent(found.recallAt6) : "-"}
                            </span>
                          </div>
                          <ol className="flex flex-col gap-1">
                            {citations.map((citation, index) => {
                              const hit = item.gold.some((evidence) =>
                                citationHits(citation, evidence),
                              );
                              return (
                                <li
                                  key={`${citation.file}-${citation.startLine}-${index}`}
                                  className={`flex items-start gap-1.5 rounded px-1.5 py-1 font-mono text-[11px] leading-snug ${
                                    hit
                                      ? "bg-chart-2/15 text-foreground"
                                      : "text-muted-foreground"
                                  }`}
                                >
                                  <span
                                    className={
                                      hit
                                        ? "text-chart-2"
                                        : "text-muted-foreground/50"
                                    }
                                  >
                                    {hit ? "●" : "○"}
                                  </span>
                                  <span className="min-w-0 break-words">
                                    {citation.file}:{citation.startLine}-
                                    {citation.endLine}
                                  </span>
                                </li>
                              );
                            })}
                          </ol>
                          <p className="mt-2 text-[11px] text-muted-foreground">
                            首个正确证据排名：
                            {found && found.firstHitRank > 0
                              ? ` 第 ${found.firstHitRank} 位`
                              : " 未进入 top6"}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {open && (
                <div className="flex flex-col gap-3 border-t px-4 py-4">
                  <div>
                    <h4 className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground">
                      三种策略在这道题上的横向对比
                    </h4>
                    <div className="table-scroll overflow-x-auto">
                      <table className="w-full min-w-[520px] text-xs">
                        <thead>
                          <tr className="border-b text-left text-[11px] text-muted-foreground">
                            <th className="py-1.5 pr-3 font-medium">策略</th>
                            <th className="py-1.5 pr-3 text-right font-medium">
                              judge
                            </th>
                            <th className="py-1.5 pr-3 text-right font-medium">
                              证据召回
                            </th>
                            <th className="py-1.5 pr-3 font-medium">结果</th>
                            <th className="py-1.5 text-right font-medium">
                              延迟
                            </th>
                          </tr>
                        </thead>
                        <tbody className="tabular-nums">
                          {runs.map((run) => {
                            const entry = run.cases.find(
                              (candidate) =>
                                candidate.questionId === item.questionId,
                            );
                            if (!entry) return null;
                            const pass =
                              entry.judgeScore >= run.summary.successThreshold;
                            const selected = run.runId === runId;
                            return (
                              <tr
                                key={run.runId}
                                className={`border-b last:border-0 ${
                                  selected ? "bg-secondary/60" : ""
                                }`}
                              >
                                <td className="py-1.5 pr-3 font-sans">
                                  {run.chunking.label}
                                </td>
                                <td
                                  className={`py-1.5 pr-3 text-right font-mono ${
                                    pass ? "text-chart-2" : "text-destructive"
                                  }`}
                                >
                                  {entry.judgeScore}/5
                                </td>
                                <td className="py-1.5 pr-3 text-right font-mono">
                                  {formatPercent(entry.evidenceRecall)}
                                </td>
                                <td className="py-1.5 pr-3">
                                  {entry.failureKind
                                    ? FAILURE_LABEL[entry.failureKind]
                                    : "达标"}
                                </td>
                                <td className="py-1.5 text-right font-mono text-muted-foreground">
                                  {formatNumber(entry.latencyMs)} ms
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-3">
                    <h4 className="text-xs font-semibold tracking-wide text-muted-foreground">
                      生成层：模型实际回答与 judge 判语
                    </h4>
                    <div className="flex flex-wrap gap-1.5">
                      {runs.map((run) => (
                        <button
                          key={run.runId}
                          type="button"
                          onClick={() => setRunId(run.runId)}
                          className={`inline-flex min-h-8 items-center rounded-md border px-3 text-xs font-medium transition-colors ${
                            run.runId === runId
                              ? "border-transparent bg-foreground text-background"
                              : "border-border text-muted-foreground hover:bg-accent hover:text-foreground"
                          }`}
                        >
                          {run.chunking.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {(() => {
                    const run = runs.find((item) => item.runId === runId);
                    const found = run?.cases.find(
                      (entry) => entry.questionId === item.questionId,
                    );
                    if (!run || !found) {
                      return (
                        <p className="text-xs text-muted-foreground">
                          这个策略下没有这道题的生成层结果。
                        </p>
                      );
                    }
                    const threshold = run.summary.successThreshold;
                    const passed = found.judgeScore >= threshold;
                    const answerKey = `${item.questionId}::${run.runId}`;
                    const answerOpen = expandedAnswer === answerKey;
                    return (
                      <div className="flex min-w-0 flex-col gap-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge
                            variant={passed ? "default" : "destructive"}
                            className={passed ? "bg-chart-2 text-white" : ""}
                          >
                            judge {found.judgeScore}/5
                          </Badge>
                          {found.failureKind && (
                            <Badge variant="outline">
                              {FAILURE_LABEL[found.failureKind]}
                            </Badge>
                          )}
                          <span className="text-[11px] text-muted-foreground">
                            证据召回 {formatPercent(found.evidenceRecall)} ·
                            延迟 {found.latencyMs} ms ·
                            花费 {report.costCurrency}
                            {found.cost.toFixed(4)}
                          </span>
                        </div>

                        <div className="rounded-md border-l-2 border-chart-1 bg-secondary/50 px-3 py-2">
                          <div className="mb-1 text-[11px] font-semibold text-muted-foreground">
                            judge 判语
                          </div>
                          <p className="text-xs leading-relaxed text-foreground">
                            {found.judgeReason}
                          </p>
                        </div>

                        <div
                          id="model-answer"
                          className="overflow-hidden rounded-md border bg-card"
                        >
                          <div className="flex items-center justify-between gap-3 border-b bg-secondary/50 px-3.5 py-2">
                            <span className="text-[11px] font-semibold text-muted-foreground">
                              模型回答
                            </span>
                            <span className="font-mono text-[10px] text-muted-foreground/80">
                              {formatNumber(found.answer.length)} 字符
                            </span>
                          </div>
                          <div
                            className={cn(
                              "relative px-3.5 py-3",
                              !answerOpen && "max-h-96 overflow-hidden",
                            )}
                          >
                            <Markdown text={found.answer} />
                            {!answerOpen && (
                              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-card to-transparent" />
                            )}
                          </div>
                          <div className="flex justify-end border-t bg-secondary/30 px-3.5 py-1.5">
                            <button
                              type="button"
                              onClick={() =>
                                setExpandedAnswer(answerOpen ? null : answerKey)
                              }
                              className="inline-flex min-h-8 items-center rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                            >
                              {answerOpen ? "收起回答" : "展开全文"}
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {filtered.length === 0 && (
        <p className="py-10 text-center text-sm text-muted-foreground">
          没有匹配的题目，换个关键词试试。
        </p>
      )}
    </div>
  );
}
