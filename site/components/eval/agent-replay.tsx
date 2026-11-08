import { useMemo, useState, type ReactNode } from "react";

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
        const entry = caseOf(finalRun, item.questionId);
        if (!entry) return false;
        if (filter === "pass") return entry.judgeScore >= threshold;
        if (filter === "fail") return entry.judgeScore < threshold;
        return true;
      }),
    [filter, threshold],
  );

  const selected =
    questions.find((item) => item.questionId === selectedId) ?? questions[0];
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
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-xl border bg-card px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">看哪个版本</span>
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
        </div>
        <div className="flex flex-wrap gap-1.5">
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

      <div className="grid gap-4 lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
        <aside className="min-w-0 lg:sticky lg:top-16 lg:self-start">
          <div className="mb-2 flex items-baseline justify-between gap-2 px-2.5 text-[11px] text-muted-foreground">
            <span>题目</span>
            <span>最终版 judge 分</span>
          </div>
          <ul className="flex max-h-[420px] flex-col gap-1 overflow-auto pr-1">
            {list.map((item) => {
              const record = caseOf(finalRun, item.questionId);
              const score = record?.judgeScore ?? 0;
              const ok = score >= threshold;
              const active = item.questionId === selected.questionId;
              return (
                <li key={item.questionId} className="min-w-0">
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedId(item.questionId);
                      setExpanded(false);
                    }}
                    className={cn(
                      "flex w-full min-w-0 items-center gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors",
                      active
                        ? "border-transparent bg-accent"
                        : "border-transparent hover:bg-accent/60",
                    )}
                  >
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {item.questionId}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs text-foreground/80">
                      {item.question}
                    </span>
                    <span
                      className={cn(
                        "shrink-0 font-mono text-[11px] tabular-nums",
                        ok ? "text-chart-2" : "text-destructive",
                      )}
                    >
                      {score}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>

        <div className="flex min-w-0 flex-col gap-4">
          <Card title={selected.question}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs text-muted-foreground">
                {selected.questionId}
              </span>
              <Badge variant="secondary">{CATEGORY_LABEL[selected.category]}</Badge>
              <Badge variant="outline">{DIFFICULTY_LABEL[selected.difficulty]}</Badge>
              <Badge
                variant={passed ? "default" : "destructive"}
                className={passed ? "bg-chart-2 text-white" : ""}
              >
                judge {entry.judgeScore}/5
              </Badge>
              {entry.failureKind && (
                <Badge variant="outline">{FAILURE_LABEL[entry.failureKind]}</Badge>
              )}
              <span className="text-[11px] text-muted-foreground">
                {otherLabel}同一题 {otherEntry?.judgeScore ?? "-"}/5 ·
                证据召回 {formatPercent(entry.evidenceRecall)} · 延迟{" "}
                {formatNumber(entry.latencyMs)} ms · 花费 {report.costCurrency}
                {entry.cost.toFixed(4)}
              </span>
            </div>
          </Card>

          <div className="rounded-lg border-l-2 border-chart-1 bg-secondary/50 px-3 py-2">
            <div className="mb-1 text-[11px] font-semibold text-muted-foreground">
              judge 判语（{step.id}）
            </div>
            <p className="text-xs leading-relaxed text-foreground">
              {entry.judgeReason}
            </p>
          </div>

          <div className="overflow-hidden rounded-lg border bg-card">
            <div className="flex items-center justify-between gap-3 border-b bg-secondary/50 px-3.5 py-2">
              <span className="text-[11px] font-semibold text-muted-foreground">
                课设 Copilot 的回答
              </span>
              <span className="font-mono text-[10px] text-muted-foreground/80">
                {formatNumber(entry.answer.length)} 字符
              </span>
            </div>
            <div
              className={cn(
                "relative px-3.5 py-3 [&_code]:break-all",
                !expanded && "max-h-96 overflow-hidden",
              )}
            >
              <Markdown text={entry.answer} />
              {!expanded && (
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-card to-transparent" />
              )}
            </div>
            <div className="flex justify-end border-t bg-secondary/30 px-3.5 py-1.5">
              <button
                type="button"
                onClick={() => setExpanded(!expanded)}
                className="rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {expanded ? "收起回答" : "展开全文"}
              </button>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-lg border bg-card px-3.5 py-3">
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

            <div className="rounded-lg border bg-card px-3.5 py-3">
              <div className="mb-2 flex items-baseline justify-between gap-2 text-[11px] font-semibold text-muted-foreground">
                <span>这一轮送进 prompt 的代码块</span>
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
                        hit ? "bg-chart-2/15 text-foreground" : "text-muted-foreground",
                      )}
                    >
                      <span className={hit ? "text-chart-2" : "text-muted-foreground/50"}>
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

          <p className="text-xs text-muted-foreground">
            这一题在评测台里的完整记录（
            <a href="#questions" className="underline underline-offset-4 hover:text-foreground">
              逐题检索台
            </a>
            ）里可以对照三种切分策略的检索排名。
          </p>
        </div>
      </div>
    </div>
  );
}

function Card({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-lg border bg-card px-3.5 py-3">
      <p className="mb-2 text-sm leading-relaxed font-medium">{title}</p>
      {children}
    </div>
  );
}
