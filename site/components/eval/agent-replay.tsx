import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Markdown } from "@/components/eval/markdown";
import { cn } from "@/lib/utils";
import {
  CATEGORY_LABEL,
  DIFFICULTY_LABEL,
  FAILURE_LABEL,
  citationHits,
  formatNumber,
  formatPercent,
  ladder,
  ladderRun,
  questions,
  report,
  type EvalRun,
  type LadderStep,
  type RunCase,
} from "@/data/report";

type Version = "final" | "base";

/** 起步版和最终版各取阶梯的首轮与末轮，回答文字都是真实运行记录。 */
const baseStep: LadderStep | undefined = ladder[0];
const finalStep: LadderStep | undefined = ladder[ladder.length - 1];
const baseRun = baseStep ? ladderRun(baseStep.id) : undefined;
const finalRun = finalStep ? ladderRun(finalStep.id) : undefined;

function caseOf(run: EvalRun | undefined, questionId: string): RunCase | undefined {
  return run?.cases.find((item) => item.questionId === questionId);
}

/** 这一轮的配置：切分方式 + 召回预算 + 提示词版本。 */
function configOf(step: LadderStep | undefined): string {
  if (!step) return "";
  return `${step.chunking.label} · top-${step.retrieval.topK} · ${
    step.promptVersion === "cite-first" ? "先列依据再作答" : "基准提示词"
  }`;
}

export function AgentReplay() {
  const [version, setVersion] = useState<Version>("final");
  const [filter, setFilter] = useState<"all" | "pass" | "fail">("all");
  const [expanded, setExpanded] = useState(false);

  const threshold = finalRun?.summary.successThreshold ?? 4;

  /** 默认落在提升最大的一道题上：同一道题，两个版本的差距最直观。 */
  const defaultId = useMemo(() => {
    let best = questions[0]?.questionId ?? "";
    let bestGap = -Infinity;
    for (const item of questions) {
      const finalScore = caseOf(finalRun, item.questionId)?.judgeScore ?? 0;
      const baseScore = caseOf(baseRun, item.questionId)?.judgeScore ?? 0;
      if (finalScore - baseScore > bestGap) {
        bestGap = finalScore - baseScore;
        best = item.questionId;
      }
    }
    return best;
  }, []);

  const [selectedId, setSelectedId] = useState(defaultId);

  const list = useMemo(
    () =>
      questions.filter((item) => {
        const record = caseOf(finalRun, item.questionId);
        if (!record) return false;
        if (filter === "pass") return record.judgeScore >= threshold;
        if (filter === "fail") return record.judgeScore < threshold;
        return true;
      }),
    [filter, threshold],
  );

  // 筛选后如果当前题不在列表里，就落到列表第一题，避免显示一道被筛掉的题。
  const selected =
    list.find((item) => item.questionId === selectedId) ??
    list[0] ??
    questions[0];
  const run = version === "final" ? finalRun : baseRun;
  const step = version === "final" ? finalStep : baseStep;
  const entry = selected ? caseOf(run, selected.questionId) : undefined;
  const otherEntry = selected
    ? caseOf(version === "final" ? baseRun : finalRun, selected.questionId)
    : undefined;
  const otherLabel = version === "final" ? "起步版" : "最终版";

  const passed = entry ? entry.judgeScore >= threshold : false;
  const hits = selected
    ? (entry?.citations ?? []).filter((citation) =>
        selected.gold.some((evidence) => citationHits(citation, evidence)),
      ).length
    : 0;

  if (!selected || !entry || !run || !step) {
    return (
      <p className="rounded-lg border bg-card px-4 py-6 text-sm text-muted-foreground">
        这一章需要生成层的运行记录，当前报告里没有，先看后面的评测台数据。
      </p>
    );
  }

  return (
    <div id="replay" className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 rounded-xl border bg-card px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            看哪个版本
          </span>
          {(
            [
              ["final", `最终版 · ${finalStep?.id ?? ""}`],
              ["base", `起步版 · ${baseStep?.id ?? ""}`],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => {
                setVersion(id);
                setExpanded(false);
              }}
              aria-pressed={version === id}
              className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                version === id
                  ? "border-transparent bg-foreground text-background"
                  : "border-border text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
          <span className="text-[11px] text-muted-foreground">
            {configOf(step)}
          </span>
          <div className="ml-auto flex flex-wrap gap-1.5">
            {(
              [
                ["all", "全部"],
                ["pass", "答对"],
                ["fail", "答错"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setFilter(id)}
                aria-pressed={filter === id}
                className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
                  filter === id
                    ? "border-transparent bg-primary text-primary-foreground"
                    : "border-border text-muted-foreground hover:bg-accent hover:text-foreground"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* 题号横向排开，题库不再占一列，省下来的宽度全给回答。 */}
        <div className="flex flex-wrap gap-1.5">
          {list.map((item) => {
            const record = caseOf(finalRun, item.questionId);
            const score = record?.judgeScore ?? 0;
            const ok = score >= threshold;
            const active = item.questionId === selected.questionId;
            return (
              <button
                key={item.questionId}
                type="button"
                title={item.question}
                onClick={() => {
                  setSelectedId(item.questionId);
                  setExpanded(false);
                }}
                aria-pressed={active}
                className={cn(
                  "flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[11px] tabular-nums transition-colors",
                  active
                    ? "border-transparent bg-foreground text-background"
                    : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    active
                      ? "bg-background"
                      : ok
                        ? "bg-chart-2"
                        : "bg-destructive",
                  )}
                />
                {item.questionId}
              </button>
            );
          })}
        </div>
        <p className="text-[11px] text-muted-foreground">
          圆点是最终版的 judge 结论：绿=达标（≥{threshold} 分），红=未达标。
        </p>
      </div>

      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2 rounded-xl border-l-2 border-border bg-card px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-semibold tracking-wide text-muted-foreground">
              提问
            </span>
            <span className="font-mono text-xs text-muted-foreground">
              {selected.questionId}
            </span>
            <Badge variant="secondary">{CATEGORY_LABEL[selected.category]}</Badge>
            <Badge variant="outline">{DIFFICULTY_LABEL[selected.difficulty]}</Badge>
          </div>
          <p className="text-[15px] leading-relaxed font-medium">
            {selected.question}
          </p>
        </div>

        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-secondary/50 px-4 py-2.5">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold tracking-wide text-muted-foreground">
                课设 Copilot 的回答
              </span>
              <Badge variant="outline">{step.id}</Badge>
            </div>
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px] text-muted-foreground/80">
                {formatNumber(entry.answer.length)} 字符
              </span>
              <button
                type="button"
                onClick={() => setExpanded(!expanded)}
                className="rounded-md px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {expanded ? "收起" : "展开全文"}
              </button>
            </div>
          </div>
          <div
            className={cn(
              "relative px-4 py-3 [&_code]:break-all",
              !expanded && "max-h-[420px] overflow-hidden",
            )}
          >
            <Markdown text={entry.answer} />
            {!expanded && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-card to-transparent" />
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <Badge
            variant={passed ? "default" : "destructive"}
            className={passed ? "bg-chart-2 text-white" : ""}
          >
            judge {entry.judgeScore}/5
          </Badge>
          {entry.failureKind && (
            <Badge variant="outline">{FAILURE_LABEL[entry.failureKind]}</Badge>
          )}
          <span>
            {otherLabel}同一题 {otherEntry?.judgeScore ?? "-"}/5 · 证据召回{" "}
            {formatPercent(entry.evidenceRecall)} · 延迟{" "}
            {formatNumber(entry.latencyMs)} ms · 花费 {report.costCurrency}
            {entry.cost.toFixed(4)}
          </span>
        </div>

        <div className="rounded-lg border-l-2 border-chart-1 bg-secondary/50 px-3.5 py-2.5">
          <div className="mb-1 text-[11px] font-semibold text-muted-foreground">
            judge 判语
          </div>
          <p className="text-xs leading-relaxed text-foreground">
            {entry.judgeReason}
          </p>
        </div>

        <details className="group rounded-lg border bg-card">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium text-foreground">
            <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
            检索证据
            <span className="text-xs font-normal text-muted-foreground">
              标准答案要求的位置，与这一轮实际送进 prompt 的代码块
            </span>
          </summary>
          <div className="grid gap-4 border-t px-4 py-4 sm:grid-cols-2">
            <div>
              <div className="mb-2 text-[11px] font-semibold text-muted-foreground">
                标准答案要求的证据
              </div>
              <ul className="flex flex-col gap-1.5">
                {selected.gold.map((evidence) => (
                  <li
                    key={`${evidence.file}-${evidence.startLine}`}
                    className="rounded-md bg-secondary/60 px-2.5 py-1.5 font-mono text-[11px]"
                  >
                    <div className="text-foreground">
                      {evidence.file}:{evidence.startLine}-{evidence.endLine}
                    </div>
                    {evidence.symbol && (
                      <div className="mt-0.5 text-muted-foreground">
                        {evidence.symbol}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <div className="mb-2 flex items-baseline justify-between gap-2 text-[11px] font-semibold text-muted-foreground">
                <span>送进 prompt 的代码块</span>
                <span className="font-mono">
                  {hits} / {(entry.citations ?? []).length} 命中证据
                </span>
              </div>
              <ol className="flex max-h-44 flex-col gap-1 overflow-auto">
                {(entry.citations ?? []).map((citation, index) => {
                  const hit = selected.gold.some((evidence) =>
                    citationHits(citation, evidence),
                  );
                  return (
                    <li
                      key={`${citation.file}-${citation.startLine}-${index}`}
                      className={cn(
                        "flex items-start gap-1.5 rounded px-1.5 py-1 font-mono text-[11px] leading-snug",
                        hit
                          ? "bg-chart-2/15 text-foreground"
                          : "text-muted-foreground",
                      )}
                    >
                      <span
                        className={hit ? "text-chart-2" : "text-muted-foreground/50"}
                      >
                        {hit ? "●" : "○"}
                      </span>
                      <span className="min-w-0 break-all">
                        {citation.file}:{citation.startLine}-{citation.endLine}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </div>
          </div>
        </details>

        <p className="text-xs text-muted-foreground">
          这一题在评测台里的完整记录（
          <a
            href="#questions"
            className="underline underline-offset-4 hover:text-foreground"
          >
            逐题检索台
          </a>
          ）里可以对照三种切分策略的检索排名。
        </p>
      </div>
    </div>
  );
}
