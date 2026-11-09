import { useEffect, useState, type ReactNode } from "react";
import { ChevronRight, GitBranch } from "lucide-react";

import {
  CATEGORY_LABEL,
  DIFFICULTY_LABEL,
  FAILURE_LABEL,
  formatNumber,
  formatPercent,
  ladder,
  ladderRuns,
  modelComparison,
  multiProject,
  questions,
  report,
  runs,
  strategies,
  type QuestionCategory,
  type RunCase,
} from "@/data/report";
import { QuestionExplorer } from "@/components/eval/question-explorer";
import { AgentReplay } from "@/components/eval/agent-replay";
import { OutcomeMatrix } from "@/components/eval/outcome-matrix";
import { DataView } from "@/components/eval/data-view";
import { CostBreakdownPopover } from "@/components/eval/cost-breakdown";
import { ExportButtons } from "@/components/eval/export-buttons";
import { LadderSection } from "@/components/eval/ladder-section";
import { ModelComparisonSection } from "@/components/eval/model-comparison-section";
import { ProjectComparisonSection } from "@/components/eval/project-comparison-section";
import { BaselineSection } from "@/components/eval/baseline-section";
import { ThemeToggle, useTheme } from "@/components/theme-toggle";
import {
  StrategyCostChart,
  StrategyQualityChart,
} from "@/components/eval/strategy-charts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Separator } from "@/components/ui/separator";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";

const REPO_URL = "https://github.com/BaconChen34569/eval-bench";

const LOCAL_WORKBENCH_COMMANDS = `# 0. 构建本地工具页（只做一次，在仓库根目录执行）
cd site
npm ci
npm run build:local

# 1. 起本地工作台
cd ../harness
node --experimental-strip-types src/cli.ts serve

# 2. 浏览器打开
#    http://127.0.0.1:8787/      工具页：填数据 / 录题集 / 跑评测
#    http://127.0.0.1:8787/story 这一页的本地版本`;

const WINDOWS_COMMANDS = `# 0. 拉语料（在仓库根目录执行）
powershell -ExecutionPolicy Bypass -File corpus\\fetch.ps1

# 1. 校验评测集：证据行号必须真实存在
cd harness
node --experimental-strip-types src/validate.ts datasets/flask.json ../corpus/repos/flask-3.1.3

# 2. 跑完整评测：检索层 + judge 自检 + 生成层
#    没有密钥时只跑检索层，报告里不会出现生成层数据
node --experimental-strip-types src/cli.ts experiment datasets/flask.json ../corpus/repos/flask-3.1.3 --out out/report.json

# 3. 跑工具迭代阶梯：每轮只改一个变量
#    --reuse 会复用配置一致、且代码版本一致的已有运行记录
#    --baseline 传入上一版报告，把旧结果一并写进报告，用于展示优化前后
node --experimental-strip-types src/cli.ts ladder datasets/flask.json ../corpus/repos/flask-3.1.3 --out out/report.json --reuse out/report.json --baseline out/report-previous.json

# 4. 跑多模型对比：换被测模型，再让每把尺子各量一遍
#    主尺子量所有模型，其余尺子对同一批答案重新打分（答案不动）
#    需要在 harness/.env 里配好几家服务商的密钥
node --experimental-strip-types src/cli.ts compare datasets/flask.json ../corpus/repos/flask-3.1.3 --report out/report.json --report-out out/report.json

# 5. 密钥写在 harness/.env 里（已被 .gitignore 忽略），不要提交
#    DeepSeek 确认模型 id：node --experimental-strip-types src/cli.ts models`;

const UNIX_COMMANDS = `# 0. 拉语料（在仓库根目录执行）
bash corpus/fetch.sh

# 1. 校验评测集：证据行号必须真实存在
cd harness
node --experimental-strip-types src/validate.ts datasets/flask.json ../corpus/repos/flask-3.1.3

# 2. 跑完整评测：检索层 + judge 自检 + 生成层
#    没有密钥时只跑检索层，报告里不会出现生成层数据
node --experimental-strip-types src/cli.ts experiment \\
  datasets/flask.json ../corpus/repos/flask-3.1.3 --out out/report.json

# 3. 跑工具迭代阶梯：每轮只改一个变量
#    --reuse 会复用配置一致、且代码版本一致的已有运行记录
#    --baseline 传入上一版报告，把旧结果一并写进报告，用于展示优化前后
node --experimental-strip-types src/cli.ts ladder \\
  datasets/flask.json ../corpus/repos/flask-3.1.3 --out out/report.json \\
  --reuse out/report.json --baseline out/report-previous.json

# 4. 跑多模型对比：换被测模型，再让每把尺子各量一遍
#    主尺子量所有模型，其余尺子对同一批答案重新打分（答案不动）
#    需要在 harness/.env 里配好几家服务商的密钥
node --experimental-strip-types src/cli.ts compare \\
  datasets/flask.json ../corpus/repos/flask-3.1.3 \\
  --report out/report.json --report-out out/report.json

# 5. 密钥写在 harness/.env 里（已被 .gitignore 忽略），不要提交
#    DeepSeek 确认模型 id：node --experimental-strip-types src/cli.ts models`;

const best = strategies.reduce((a, b) => (b.mrr > a.mrr ? b : a));
const repoLines = strategies[0]?.totalRepoLines ?? 0;
const maxRecallAt6 = Math.max(...strategies.map((item) => item.recallAt6));
const fileCount = strategies[0]?.fileCount ?? 0;

const missesByStrategy = strategies.map((metrics) => {
  const missed = metrics.cases.filter((item) => item.recallAt6 < 1);
  const byCategory = new Map<QuestionCategory, string[]>();
  for (const item of missed) {
    const bucket = byCategory.get(item.category) ?? [];
    bucket.push(item.questionId);
    byCategory.set(item.category, bucket);
  }
  return { metrics, missed, byCategory };
});

const hardestStrategy = missesByStrategy.reduce((a, b) =>
  b.missed.length > a.missed.length ? b : a,
);

/** 把 ISO 时间戳压成本地时区的「月-日 时:分」。 */
function formatRunTime(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const judgeValidation = report.judgeValidation;
const hasJudgeValidation = judgeValidation.sampled > 0;
/** 生成层指标只有在真的跑过大模型调用时才会出现在报告里。 */
const hasGeneration = strategies.some((item) => item.successRate !== undefined);
const generationStrategies = strategies.filter(
  (item) => item.successRate !== undefined,
);

/** 生成层失败归因：把没拿到成功的题按失败类型拆开。 */
const generationFailures = runs.map((run) => {
  const failed = run.cases.filter(
    (item) => item.judgeScore < run.summary.successThreshold,
  );
  const byKind = new Map<string, string[]>();
  for (const item of failed) {
    const kind = item.failureKind ?? "missing-detail";
    const bucket = byKind.get(kind) ?? [];
    bucket.push(item.questionId);
    byKind.set(kind, bucket);
  }
  const byCategory = new Map<QuestionCategory, { total: number; success: number }>();
  for (const item of run.cases) {
    const bucket =
      byCategory.get(item.category) ?? { total: 0, success: 0 };
    bucket.total += 1;
    if (item.judgeScore >= run.summary.successThreshold) bucket.success += 1;
    byCategory.set(item.category, bucket);
  }
  return { run, failed, byKind, byCategory };
});

const totalFailed = generationFailures.reduce(
  (sum, item) => sum + item.failed.length,
  0,
);

/** 结论按真实数据算：成功率最高的策略，失败集中落在哪一侧。 */
const bestGeneration = [...generationFailures].sort(
  (a, b) => b.run.summary.successRate - a.run.summary.successRate,
)[0];
const bestFailedCount = bestGeneration?.failed.length ?? 0;
const bestWrongLocation =
  bestGeneration?.byKind.get("wrong-location")?.length ?? 0;

/** 成功率和成本之间的取舍，用真实数字说清楚。 */
const bestStrategy = [...generationStrategies].sort(
  (a, b) => (b.successRate ?? 0) - (a.successRate ?? 0),
)[0];
const worstStrategy = [...generationStrategies].sort(
  (a, b) => (a.successRate ?? 0) - (b.successRate ?? 0),
)[0];

/**
 * 首屏那个「最高成功率」取的是全站最好的一次运行——横向对比和迭代阶梯都算。
 * 阶梯的每一轮也是这个工具的一种配置，只看横向对比会低报自己的成绩。
 */
const headlineRun = [...new Map(
  [...runs, ...ladderRuns].map((run) => [run.runId, run]),
).values()]
  .filter((run) => run.cases.length === questions.length)
  .sort((a, b) => b.summary.successRate - a.summary.successRate)[0];

const headlineFailed = headlineRun
  ? headlineRun.cases.filter(
      (item) => item.judgeScore < headlineRun.summary.successThreshold,
    )
  : [];
const headlineWrongLocation = headlineFailed.filter(
  (item) => item.failureKind === "wrong-location",
).length;

/**
 * 页面按三章组织，导航和正文用的是同一份结构：
 * 改一处章节顺序，导航和首屏目录会一起动。
 */
type SectionMeta = { id: string; label: string; short: string };

const CHAPTERS: {
  id: string;
  numeral: string;
  title: string;
  lead: string;
  sections: SectionMeta[];
}[] = [
  {
    id: "agent",
    numeral: "1",
    title: "课设 Copilot 实战问答",
    lead: "先看东西本身：给它 Flask 3.1.3 这个仓库和一个关于代码的问题，它自己找代码、读代码、给出带行号引用的答案。下面按题号挑一道，看它当时到底怎么答的——包括答错的时候。",
    sections: [
      { id: "agent", label: "它是怎么工作的", short: "怎么工作" },
      { id: "ask", label: "实战问答", short: "问答" },
    ],
  },
  {
    id: "method",
    numeral: "2",
    title: "评测台怎么测",
    lead: "先把不花钱、不看运气的那一层做扎实，再谈生成质量：检索层决定模型能看到什么，生成层决定看到之后答得怎么样。本章的实验都在 Flask 3.1.3 上跑。",
    sections: [
      { id: "why", label: "为什么先测检索层", short: "为什么" },
      { id: "experiment", label: "切分策略对比", short: "切分对比" },
      ...(hasGeneration
        ? [{ id: "generation", label: "生成层结果", short: "生成层" }]
        : []),
    ],
  },
  {
    id: "result",
    numeral: "3",
    title: "结论有多硬",
    lead: "把「这一版比那一版好」拆成可以归因的每一步，再回头问一次：给出这个结论的那把尺子，本身可不可信。前三节都是 Flask 上的迭代史，最后一节把它扩到四个仓库。",
    sections: [
      ...(report.baseline
        ? [{ id: "baseline", label: "优化前后", short: "前后" }]
        : []),
      ...(ladder.length > 0
        ? [{ id: "ladder", label: "工具迭代史", short: "迭代史" }]
        : []),
      ...(modelComparison
        ? [{ id: "models", label: "多模型对比", short: "多模型" }]
        : []),
      ...(multiProject
        ? [{ id: "projects", label: "多项目对比", short: "多项目" }]
        : []),
    ],
  },
  {
    id: "evidence",
    numeral: "4",
    title: "证据与复现",
    lead: "每一个数字都能被打开看，也能被重新算一遍：逐题证据、失败分类、judge 自检，和一条命令就能跑的复现流水线。逐题证据与失败分类都来自 Flask 3.1.3。",
    sections: [
      { id: "questions", label: "逐题检索台", short: "逐题" },
      { id: "failures", label: "失败归因", short: "失败" },
      { id: "trust", label: "信任基础", short: "信任" },
      { id: "repro", label: "怎么复现", short: "复现" },
    ],
  },
];

const SECTIONS = CHAPTERS.flatMap((chapter) => chapter.sections);

/** 窄屏下拉里的选项带上章节序号，避免只剩下孤零零的小标题。 */
const NAV_ITEMS = CHAPTERS.flatMap((chapter) =>
  chapter.sections.map((section) => ({
    ...section,
    option: `${chapter.numeral} · ${section.short}`,
  })),
);

/** 章节标题：24px/600，悬停时露出一个锚点，方便评委直接引用某一节。 */
function SectionTitle({
  id,
  scope,
  children,
}: {
  id: string;
  scope?: string;
  children: ReactNode;
}) {
  return (
    <h3
      id={id}
      className="group flex flex-wrap items-baseline gap-2 text-2xl font-semibold tracking-tight"
    >
      {children}
      {scope ? <ScopeBadge text={scope} /> : null}
      <a
        href={`#${id}`}
        aria-label="本节链接"
        className="text-lg font-normal text-link opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
      >
        #
      </a>
    </h3>
  );
}

/**
 * 适用范围标签：这一节的数字是在哪个仓库上跑出来的。
 *
 * 页面里既有单个仓库（Flask）的结论，也有四个仓库的横向对比，
 * 不标清楚读者会以为所有数字都来自同一套题。
 */
function ScopeBadge({ text }: { text: string }) {
  return (
    <span className="rounded-full border bg-muted/40 px-2.5 py-0.5 align-middle text-xs font-normal font-medium text-muted-foreground">
      {text}
    </span>
  );
}

/**
 * 复现步骤：一格里的「做什么 + 为什么」。
 * 命令统一放在下面的整块代码里——窄卡片里放命令会被截断。
 */
function ReproStep({
  step,
  title,
  description,
}: {
  step: string;
  title: string;
  description: ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-lg border bg-secondary/40 p-4">
      <div className="flex items-center gap-2">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">
          {step}
        </span>
        <span className="text-sm font-medium">{title}</span>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground wrap-anywhere">
        {description}
      </p>
    </div>
  );
}

/**
 * 踩坑清单：同一份命令在不同系统上失败的原因不一样，
 * 写清楚症状比写「如有报错请搜索」有用。
 */
function PitfallList({ items }: { items: ReactNode[] }) {
  return (
    <ul className="flex min-w-0 flex-col gap-2">
      {items.map((item, index) => (
        <li
          key={index}
          className="min-w-0 text-xs leading-relaxed text-muted-foreground wrap-anywhere"
        >
          {item}
        </li>
      ))}
    </ul>
  );
}

/**
 * 章标题：一条横贯的分隔线 + 序号 + 一句话说明。
 * 页面上内容多，靠这条线告诉读者「现在读到第几章、这一章要解决什么」。
 */
function ChapterHeader({
  id,
  numeral,
  title,
  lead,
  first = false,
}: {
  id: string;
  numeral: string;
  title: string;
  lead: string;
  first?: boolean;
}) {
  return (
    <div
      id={id}
      className={`flex scroll-mt-16 flex-col gap-3 ${first ? "" : "mt-16 border-t pt-10"}`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">
          {numeral}
        </span>
        <span className="text-xs font-medium text-muted-foreground">
          第 {numeral} 章
        </span>
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      </div>
      <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
        {lead}
      </p>
    </div>
  );
}

function Metric({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border bg-card px-5 py-4 shadow-sm ${
        accent ? "border-chart-1/40 ring-1 ring-chart-1/20" : ""
      }`}
    >
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={`mt-1 font-mono text-2xl font-semibold tabular-nums ${
          accent ? "text-chart-1" : ""
        }`}
      >
        {value}
      </div>
      {hint && (
        <div className="mt-1 text-[11px] leading-snug text-muted-foreground">
          {hint}
        </div>
      )}
    </div>
  );
}

export default function App() {
  // 内容是客户端渲染的，浏览器自带的片段跳转发生在内容出现之前，这里补一次。
  useEffect(() => {
    const target = window.location.hash.slice(1);
    if (!target) return;
    const element = document.getElementById(target);
    element?.scrollIntoView({ block: "start" });
  }, []);

  const [view, setView] = useState<"story" | "data">("story");
  const [theme, setTheme] = useTheme();

  // 导航高亮跟着滚动走，评委长页面里不会迷路自己在看哪一节。
  const [activeSection, setActiveSection] = useState(SECTIONS[0].id);
  useEffect(() => {
    if (view !== "story") return;
    const update = () => {
      const line = 120;
      let current = SECTIONS[0].id;
      for (const section of SECTIONS) {
        const element = document.getElementById(section.id);
        if (element && element.getBoundingClientRect().top <= line) {
          current = section.id;
        }
      }
      // 页面滚到底时最后一节可能还没越过判定线，此时以"已到底"为准。
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) {
        current = SECTIONS[SECTIONS.length - 1].id;
      }
      setActiveSection(current);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, [view]);

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <nav className="sticky top-0 z-20 border-b bg-background">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-5 py-3.5 text-[13px] sm:gap-6 sm:px-8">
          <a
            href="#top"
            className="shrink-0 font-semibold tracking-tight"
            onClick={(event) => {
              event.preventDefault();
              window.scrollTo({ top: 0, behavior: "smooth" });
            }}
          >
            <span className="hidden sm:inline">评测台</span>
          </a>

          {view === "story" ? (
            <>
              {/* 十个章节标题平铺必然放不下，改为按章分组：序号 + 章内小标题。 */}
              <nav className="table-scroll hidden flex-1 items-center gap-1 overflow-x-auto scrollbar-none lg:flex">
                {CHAPTERS.map((chapter, chapterIndex) => (
                  <div
                    key={chapter.id}
                    className="flex shrink-0 items-center gap-0.5"
                  >
                    {chapterIndex > 0 && (
                      <span className="mx-2 h-3.5 w-px bg-border" aria-hidden />
                    )}
                    <span
                      className="mr-1 flex size-4 shrink-0 items-center justify-center rounded-full bg-secondary text-[10px] leading-none text-muted-foreground"
                      title={`第 ${chapter.numeral} 章 ${chapter.title}`}
                    >
                      {chapter.numeral}
                    </span>
                    {chapter.sections.map((section) => (
                      <a
                        key={section.id}
                        href={`#${section.id}`}
                        aria-current={
                          activeSection === section.id ? "true" : undefined
                        }
                        className={`rounded px-1.5 py-1 transition-colors ${
                          activeSection === section.id
                            ? "bg-accent font-medium text-foreground"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {section.short}
                      </a>
                    ))}
                  </div>
                ))}
              </nav>
              {/* 窄屏放不下章节标签，折成一个下拉。 */}
              <div className="min-w-0 flex-1 lg:hidden">
                <NativeSelect
                  size="sm"
                  className="truncate text-[13px]"
                  value={activeSection}
                  aria-label="章节导航"
                  onChange={(event) => {
                    document
                      .getElementById(event.target.value)
                      ?.scrollIntoView({ behavior: "smooth", block: "start" });
                  }}
                >
                  {NAV_ITEMS.map((item) => (
                    <NativeSelectOption key={item.id} value={item.id}>
                      {item.option}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
            </>
          ) : (
            <span className="min-w-0 flex-1 truncate text-xs leading-tight text-muted-foreground lg:text-[13px]">
              <span className="sm:hidden">指标可查 · 可筛 · 可导出</span>
              <span className="hidden sm:inline">
                数据视图：每个指标都可查、可筛、可导出
              </span>
            </span>
          )}

          <div className="ml-auto flex shrink-0 items-center gap-2">
            <div
              className="flex shrink-0 items-center gap-0.5 rounded-md border p-0.5"
              role="group"
              aria-label="视图"
            >
              {(
                [
                  ["story", "叙事"],
                  ["data", "数据"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setView(id)}
                  aria-pressed={view === id}
                  className={`rounded px-2.5 py-1 text-xs transition-colors ${
                    view === id
                      ? "bg-accent font-medium text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <ThemeToggle choice={theme} onChange={setTheme} />
          </div>
        </div>
      </nav>

      <div className="mx-auto w-full max-w-6xl px-5 pt-12 pb-10 sm:px-8 sm:pt-[50px] sm:pb-16">
        <header className="flex flex-col items-center gap-6 text-center">
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Badge variant="outline">StudyHack · 学习科研</Badge>
            <Badge variant="secondary">2026 Qoder 高校创造力大赛</Badge>
          </div>
          <div className="flex flex-col items-center gap-4">
            <h1 className="text-[32px] font-bold leading-[40px] tracking-tight sm:text-[40px] sm:leading-[48px]">
              课设 Copilot 评测台
            </h1>
            <p className="max-w-3xl text-base leading-[26px] text-foreground/80">
              课设 Copilot 能对着一个真实仓库回答代码问题，答案落在具体行号上。
              我们不只做了一个 Copilot，还给它配了一把尺子：
              在 <span className="font-mono">Flask 3.1.3</span> 上人工标注了{" "}
              {questions.length} 道代码问答题，每道题写清楚了答案必须落在哪几行代码上，
              再用同一套检索器去比较不同切分策略，把失败精确地定位到文件、行号和缺失的要点。
            </p>
            <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
              <span className="font-medium text-foreground">先说清楚数据的范围：</span>
              第 1、2 章和第 3 章的前三节，所有数字都来自{" "}
              <span className="font-mono text-foreground">Flask 3.1.3</span>{" "}
              这一个仓库——22 道题、一套检索器、一把尺子。
              第 3 章最后一节「多项目对比」才把它扩到 Flask / Requests / Werkzeug /
              Jinja2 四个仓库，看这把尺子换仓库还灵不灵。页面里每一节标题旁边都标了这一节的数据来自哪里。
            </p>
            {/* 首屏不放散装链接，直接给四章目录：读完这一行就知道整页怎么走。 */}
            <div className="grid w-full gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {CHAPTERS.map((chapter) => (
                <div
                  key={chapter.id}
                  className="flex flex-col gap-2 rounded-xl border bg-card px-4 py-3 text-left shadow-sm"
                >
                  <a
                    href={`#${chapter.sections[0].id}`}
                    className="flex items-center gap-2 text-sm font-medium text-foreground transition-colors hover:text-link"
                  >
                    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] text-primary-foreground">
                      {chapter.numeral}
                    </span>
                    {chapter.title}
                  </a>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {chapter.lead}
                  </p>
                  <div className="flex flex-wrap gap-x-3 gap-y-1">
                    {chapter.sections.map((section) => (
                      <a
                        key={section.id}
                        href={`#${section.id}`}
                        className="text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-link hover:underline"
                      >
                        {section.short}
                      </a>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="grid w-full gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric
              label="最高成功率"
              value={formatPercent(headlineRun?.summary.successRate ?? 0)}
              hint={`Flask · ${headlineRun?.chunking.label} · top-${headlineRun?.retrieval.topK} · ${questions.length} 题里 ${Math.round((headlineRun?.summary.successRate ?? 0) * questions.length)} 题达标`}
              accent
            />
            <Metric
              label="失败里有多少是定位错了"
              value={`${Math.round((headlineWrongLocation / Math.max(headlineFailed.length, 1)) * 100)}%`}
              hint={`Flask · ${headlineFailed.length} 次失败中 ${headlineWrongLocation} 次，瓶颈在检索侧`}
            />
            <Metric
              label="judge 自检一致率"
              value={formatPercent(report.judgeValidation.agreement)}
              hint={`Flask · ${report.judgeValidation.sampled} 题人工参考答案 · judge 均分 ${report.judgeValidation.meanJudgeScore.toFixed(2)} vs 人工 ${report.judgeValidation.meanHumanScore.toFixed(2)}`}
            />
            <Metric
              label="评测集"
              value={`${questions.length} 题 · ${formatNumber(repoLines)} 行`}
              hint={`Flask 3.1.3 · ${fileCount} 个文件 · 证据人工标注到行号`}
            />
          </div>
        </header>

        <Separator className="my-10" />

        <div className={view === "story" ? "contents" : "hidden"}>
        <ChapterHeader
          id="chapter-agent"
          numeral="1"
          title="课设 Copilot 实战问答"
          lead="先看东西本身：给它 Flask 3.1.3 这个仓库和一个关于代码的问题，它自己找代码、读代码、给出带行号引用的答案。下面每一段回答都是真实运行记录，不是演示动画。"
          first
        />

        <section id="agent" className="scroll-mt-16 mt-8 flex flex-col gap-6">
          <SectionTitle id="agent">课设 Copilot 怎么工作</SectionTitle>
          <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
            它做的事很朴素：给一个仓库和一个关于代码的问题，它自己找代码、读代码、写出答案，
            并且把答案落在具体行号上。被测模型是{" "}
            <span className="font-mono text-foreground">deepseek-flash</span>，
            跑在 Flask 3.1.3 的源码包上——{fileCount} 个文件、
            {formatNumber(repoLines)} 行真实代码。
          </p>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            {[
              {
                step: "1",
                title: "切分",
                detail: "按函数/类边界把仓库切成代码块，而不是按固定字符数硬切。",
              },
              {
                step: "2",
                title: "检索",
                detail: "BM25 打底，再按符号名和路径结构重排；中文提问会展开成英文候选词。",
              },
              {
                step: "3",
                title: "取上下文",
                detail: `取 top-${ladder[ladder.length - 1]?.retrieval.topK ?? 10} 个代码块拼成上下文，函数级切分下平均约 ${formatNumber(ladder[ladder.length - 1]?.retrievalMetrics.avgContextChars ?? 0)} 字符。`,
              },
              {
                step: "4",
                title: "作答",
                detail: "一次大模型调用，提示词要求先列依据再作答，答案必须带文件与行号引用。",
              },
              {
                step: "5",
                title: "被打分",
                detail: "评测时才发生：另一把尺子按 1-5 分打分，≥4 分算成功。",
              },
            ].map((item) => (
              <div key={item.step} className="rounded-lg border bg-card p-4 shadow-sm">
                <div className="flex items-center gap-2">
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">
                    {item.step}
                  </span>
                  <span className="text-sm font-medium">{item.title}</span>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  {item.detail}
                </p>
              </div>
            ))}
          </div>
          <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
            前四步是它真正干的活，第五步是评测台干的活。
            接下来这一小节直接把它的真实作答摊开给你看——包括它答错的那几道。
          </p>
        </section>

        <section id="ask" className="scroll-mt-16 mt-12 flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <SectionTitle id="ask" scope="Flask 3.1.3 · 22 道题">
              实战问答：挑一道题看它怎么答
            </SectionTitle>
            <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
              下面是 {questions.length} 道题，每道题一个题号。挑一个，下面就是完整的一次问答：
              问题、它拿到的代码块、它写出的答案、judge 的判语。
              可以在「起步版」和「最终版」之间切换——同一道题，
              同一个模型、同一把尺子，只是工具本身被改过。
            </p>
          </div>
          <AgentReplay />
        </section>

        <ChapterHeader
          id="chapter-method"
          numeral="2"
          title="评测台怎么测"
          lead="先把不花钱、不看运气的那一层做扎实，再谈生成质量：检索层决定模型能看到什么，生成层决定看到之后答得怎么样。本章的实验都在 Flask 3.1.3 上跑。"
        />

        <section id="why" className="scroll-mt-16 mt-8 flex flex-col gap-6">
          <SectionTitle id="why">为什么要先测检索层</SectionTitle>
          <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
            很多 Copilot 的演示停在「它答对了」。但答对的背后可能是运气：一次瞎猫撞上死耗子，
            一次检索到了无关但看起来很像的代码。我们把评测拆成两层，并且先把可以完全复现的那层做扎实。
          </p>
          <div className="grid gap-3 md:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">检索是回答质量的上限</CardTitle>
                <CardDescription>
                  标准答案要求的代码位置没被检索到，再强的模型也只能靠猜。
                </CardDescription>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">这一层不需要大模型</CardTitle>
                <CardDescription>
                  固定一套检索器，只换切分策略，分数变化就归因于切分本身。
                </CardDescription>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">任何人都能复现</CardTitle>
                <CardDescription>
                  跑一次命令几分钟出结果，结论不依赖任何一次模型调用的运气。
                </CardDescription>
              </CardHeader>
            </Card>
          </div>
        </section>

        <section id="experiment" className="scroll-mt-16 mt-12 flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <SectionTitle id="experiment" scope="Flask 3.1.3">
              切分策略对比实验
            </SectionTitle>
            <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
              同一个仓库、同一套检索器（BM25 + 结构感知重排 + 中英术语扩展）、
              同样的 top-6 召回预算，只改变代码块的切法：
              固定 800 字符、固定 400 字符、以及按函数/类边界切分。
            </p>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">检索质量：证据召回率</CardTitle>
                <CardDescription>
                  标准答案要求的证据，有多少比例出现在 top-1 / top-3 / top-6 里。
                </CardDescription>
              </CardHeader>
              <CardContent>
                <StrategyQualityChart />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">检索代价：送进模型的上下文</CardTitle>
                <CardDescription>
                  标签为切出的代码块数量，纵轴是实际拼进 prompt 的字符数。
                </CardDescription>
              </CardHeader>
              <CardContent>
                <StrategyCostChart />
              </CardContent>
            </Card>
          </div>

          <Card className="bg-secondary">
            <CardHeader>
              <CardTitle className="text-base">结论：精度和成本是一笔交易</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm leading-relaxed">
              <p>
                函数级切分把 recall@1 从{" "}
                <span className="font-mono">
                  {formatPercent(
                    strategies.find((s) => s.strategy.id === "fixed-800")!
                      .recallAt1,
                  )}
                </span>{" "}
                提到{" "}
                <span className="font-mono">
                  {formatPercent(best.recallAt1)}
                </span>
                ，MRR 从{" "}
                <span className="font-mono">
                  {strategies.find((s) => s.strategy.id === "fixed-800")!.mrr.toFixed(3)}
                </span>{" "}
                提到 <span className="font-mono">{best.mrr.toFixed(3)}</span>
                ：正确代码块被排到更靠前的位置，模型第一眼看到的就是对的。
              </p>
              <p>
                代价是上下文体积——函数级切分每次要送{" "}
                <span className="font-mono">
                  {formatNumber(best.avgContextChars)}
                </span>{" "}
                个字符进 prompt，是固定 800 字符策略的{" "}
                <span className="font-mono">
                  {(best.avgContextChars /
                    strategies.find((s) => s.strategy.id === "fixed-800")!
                      .avgContextChars).toFixed(1)}
                </span>{" "}
                倍。切得更准，但每次问一次也更贵。到底选哪个，取决于你的 token
                预算和你的问题是不是需要跨多个函数理解。
              </p>
              <p className="text-muted-foreground">
                注意最右边的数字：在同样的 top-6 预算下，三种策略里 recall@6 最高的也只有{" "}
                {formatPercent(maxRecallAt6)}
                。检索层本身就是瓶颈——放宽预算能继续往上拉，见下一节的迭代阶梯。
              </p>
            </CardContent>
          </Card>
        </section>

        {hasGeneration && (
          <section
            id="generation"
            className="scroll-mt-16 mt-12 flex flex-col gap-6"
          >
            <div className="flex flex-col gap-2">
              <SectionTitle id="generation" scope="Flask 3.1.3">
                生成层结果
              </SectionTitle>
              <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
                检索层决定「模型能看到什么」，生成层决定「模型看到之后答得怎么样」。
                同一批题、同一套检索结果，分别喂给三种切分策略下的上下文，
                再由 judge 按 1-5 分打分（≥4 分判为成功）。
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {generationStrategies.map((metrics) => (
                <Card key={metrics.strategy.id}>
                  <CardHeader>
                    <CardTitle className="text-base">
                      {metrics.strategy.label}
                    </CardTitle>
                    <CardDescription>
                      {metrics.chunkCount} 个代码块 · 上下文{" "}
                      {formatNumber(metrics.avgContextChars)} 字符
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-2">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
                        成功率
                      </span>
                      <span className="font-mono text-2xl font-semibold tabular-nums">
                        {formatPercent(metrics.successRate ?? 0)}
                      </span>
                    </div>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
                        平均 judge 分
                      </span>
                      <span className="font-mono text-sm tabular-nums">
                        {(metrics.avgJudgeScore ?? 0).toFixed(2)}
                      </span>
                    </div>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
                        平均 / P95 延迟
                      </span>
                      <span className="font-mono text-sm tabular-nums">
                        {formatNumber(metrics.avgLatencyMs ?? 0)} /{" "}
                        {formatNumber(metrics.p95LatencyMs ?? 0)} ms
                      </span>
                    </div>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
                        总成本 / 总 token
                      </span>
                      <span className="font-mono text-sm tabular-nums">
                        {report.costCurrency}
                        {(metrics.totalCost ?? 0).toFixed(4)} /{" "}
                        {formatNumber(metrics.totalTokens ?? 0)}
                      </span>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>

            <Card className="bg-secondary">
              <CardHeader>
                <CardTitle className="text-base">运行元信息</CardTitle>
                <CardDescription>
                  这一批数字是在什么条件下跑出来的，竞品页面上叫 run metadata。
                  没有它，跨策略比较就只是「两个数字比大小」。
                </CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                  <div>
                    <dt className="text-xs text-muted-foreground">评测模型</dt>
                    <dd className="font-mono">
                      {runs[0]?.model ?? report.repo}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">数据集 / 代码库</dt>
                    <dd className="font-mono">
                      {report.datasetId} / {report.repo}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">
                      评测集规模
                    </dt>
                    <dd className="font-mono">
                      {questions.length} 题 · {formatNumber(repoLines)} 行 ·{" "}
                      {fileCount} 个文件
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">
                      运行次数 / 总耗时
                    </dt>
                    <dd className="font-mono">
                      {runs.length} 次 ·{" "}
                      {formatNumber(
                        runs.reduce(
                          (sum, run) =>
                            sum +
                            (new Date(run.finishedAt).getTime() -
                              new Date(run.startedAt).getTime()),
                          0,
                        ) / 1000,
                      )}{" "}
                      秒
                    </dd>
                  </div>
                </dl>
                <details className="group mt-4 rounded-lg border bg-card">
                  <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium text-foreground">
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
                    逐次运行记录（{runs.length} 次）
                    <span className="text-xs font-normal text-muted-foreground">
                      runId · 起止时间 · 单次成本
                    </span>
                  </summary>
                  <div className="table-scroll overflow-x-auto px-4 pb-4">
                    <table className="eval-table w-full min-w-[640px] text-sm">
                      <thead>
                        <tr className="border-b text-left text-xs text-muted-foreground">
                          <th className="py-2 pr-3 font-medium">策略</th>
                          <th className="py-2 pr-3 font-medium">runId</th>
                          <th className="py-2 pr-3 font-medium">开始</th>
                          <th className="py-2 pr-3 font-medium">结束</th>
                          <th className="py-2 pr-3 text-right font-medium">用时</th>
                          <th className="py-2 text-right font-medium">成本</th>
                        </tr>
                      </thead>
                      <tbody className="font-mono tabular-nums">
                        {runs.map((run) => {
                          const elapsedMs =
                            new Date(run.finishedAt).getTime() -
                            new Date(run.startedAt).getTime();
                          return (
                            <tr key={run.runId} className="border-b last:border-0">
                              <td className="py-2 pr-3 font-sans">
                                {run.chunking.label}
                              </td>
                              <td className="py-2 pr-3 text-xs">
                                {run.runId}
                              </td>
                              <td className="py-2 pr-3 text-xs">
                                {formatRunTime(run.startedAt)}
                              </td>
                              <td className="py-2 pr-3 text-xs">
                                {formatRunTime(run.finishedAt)}
                              </td>
                              <td className="py-2 pr-3 text-right">
                                {formatNumber(elapsedMs / 1000)} s
                              </td>
                              <td className="py-2 text-right">
                                {report.costCurrency}
                                {run.summary.totalCost.toFixed(4)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </details>
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <CostBreakdownPopover />
                  <span className="text-xs text-muted-foreground">
                    成本里同时包含 agent 生成和 judge 打分两次调用
                  </span>
                </div>
              </CardContent>
            </Card>

            <Card className="bg-secondary">
              <CardContent className="pt-6 text-sm leading-relaxed">
                {bestStrategy && worstStrategy && bestStrategy !== worstStrategy ? (
                  <p>
                    成功率最高的是「{bestStrategy.strategy.label}」（
                    {formatPercent(bestStrategy.successRate ?? 0)}），是「
                    {worstStrategy.strategy.label}」（
                    {formatPercent(worstStrategy.successRate ?? 0)}）的{" "}
                    {((bestStrategy.successRate ?? 0) / (worstStrategy.successRate ?? 1)).toFixed(1)} 倍。
                    代价也写在同一张卡上：它的上下文是{" "}
                    {formatNumber(bestStrategy.avgContextChars ?? 0)} 字符，
                    P95 延迟 {formatNumber(bestStrategy.p95LatencyMs ?? 0)} ms，
                    token 消耗 {formatNumber(bestStrategy.totalTokens ?? 0)}。
                    精度换成本——评测台存在的意义就是把这种取舍摆到台面上，而不是靠感觉。
                  </p>
                ) : null}
                <p>
                  生成层的数字解释的是「检索质量如何传导到最终回答」：
                  上下文体积直接换算成 token 成本，而成功率由 judge 判定。
                  需要注意的是这些是一次运行的观测值，
                  跨策略比较时请以同一批题、同一模型为前提。
                </p>
                <p className="text-muted-foreground">
                  成本按服务商官方价目表折算：输入区分缓存命中与未命中，
                  并且把 judge 打分那一次调用也算进去了。
                  这里用的是闲时单价（DeepSeek 高峰时段翻倍），所以是量级参考而非账单。
                </p>
              </CardContent>
            </Card>

            <div className="flex min-w-0 flex-col gap-3">
              <h3 className="text-base font-semibold">生成层失败归因</h3>
              <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
                这里的失败类型不是听模型自己说的，是按 ground truth 判的：先看它有没有引用到仓库里根本不存在的位置（编造内容），
                再看检索有没有命中人工标注的证据——一条都没命中就是定位错了，说明瓶颈在检索侧；命中了但分数不够，才算要点漏了，说明该改的是提示词和模型。
                {totalFailed > 0
                  ? `三种策略加起来一共 ${totalFailed} 次未达成功线，按这个规则拆开是这样的：`
                  : "所有题目都达到了成功线。"}
              </p>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              {generationFailures.map(({ run, failed, byKind, byCategory }) => (
                <Card key={run.runId}>
                  <CardHeader>
                    <CardTitle className="text-base">
                      {run.chunking.label}
                    </CardTitle>
                    <CardDescription>
                      {failed.length} / {run.cases.length} 题未达成功线（
                      {run.summary.successThreshold} 分）
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex min-w-0 flex-col gap-3">
                    {failed.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        全部题目都达标。
                      </p>
                    ) : (
                      [...byKind.entries()].map(([kind, ids]) => (
                        <div
                          key={kind}
                          className="flex items-start justify-between gap-3"
                        >
                          <span className="text-sm">
                            {FAILURE_LABEL[kind as keyof typeof FAILURE_LABEL]}
                            <span className="text-muted-foreground">
                              {" "}
                              · {ids.length} 题
                            </span>
                          </span>
                          <span className="font-mono text-xs text-muted-foreground">
                            {ids.join(" ")}
                          </span>
                        </div>
                      ))
                    )}
                    <Separator className="my-1" />
                    {[...byCategory.entries()].map(([category, stat]) => (
                      <div
                        key={category}
                        className="flex items-center justify-between gap-3 text-xs"
                      >
                        <span className="text-muted-foreground">
                          {CATEGORY_LABEL[category as QuestionCategory]}
                        </span>
                        <span className="font-mono tabular-nums">
                          {stat.success} / {stat.total}
                        </span>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              ))}
            </div>

            {bestGeneration && bestFailedCount > 0 ? (
              <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
                成功率最高的是「{bestGeneration.run.chunking.label}」，它的 {bestFailedCount}{" "}
                次失败里有 {bestWrongLocation} 次是定位错了（
                {Math.round((bestWrongLocation / bestFailedCount) * 100)}%）
                ——也就是说主要瓶颈还在检索侧，下一步该换检索方式（混合检索、embedding 重排），
                而不是继续调提示词。
              </p>
            ) : null}

            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  胜负矩阵：同一题在三种切分策略下
                </CardTitle>
                <CardDescription>
                  每行一道题，每列一种切分策略，格子里是 judge 的打分。
                  横向看一行就知道这题在哪种切法下答得好。
                </CardDescription>
              </CardHeader>
              <CardContent>
                <OutcomeMatrix />
              </CardContent>
            </Card>
          </section>
        )}

        <ChapterHeader
          id="chapter-result"
          numeral="3"
          title="结论有多硬"
          lead="把「这一版比那一版好」拆成可以归因的每一步，再回头问一次：给出这个结论的那把尺子，本身可不可信。前三节都是 Flask 上的迭代史，最后一节把它扩到四个仓库。"
        />

        {report.baseline && (
          <section id="baseline" className="scroll-mt-16 mt-10 flex flex-col gap-6">
            <div className="flex flex-col gap-2">
              <SectionTitle id="baseline" scope="Flask 3.1.3">
                优化前后
              </SectionTitle>
              <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
                评测台自己也会犯错，也会用错方法。这一节把上一版跑出来的记录
                原样搬过来，和当前版本逐题对照——
                <span className="font-medium text-foreground">
                  同一批题、同一个模型、同一把 judge 尺子、同一条成功线
                </span>
                ，所以两边的数字可以直接比。
              </p>
            </div>

            <BaselineSection />
          </section>
        )}

        {ladder.length > 0 && (
          <section id="ladder" className="scroll-mt-16 mt-12 flex flex-col gap-6">
            <div className="flex flex-col gap-2">
              <SectionTitle id="ladder" scope="Flask 3.1.3">
                工具迭代史
              </SectionTitle>
              <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
                上面回答的是「哪种切法更好」。这一节回答另一个问题：
                <span className="font-medium text-foreground">
                  我们是怎么一步步把这个工具改好的
                </span>
                。
                每一轮都继承上一轮，只相对上一轮改一个变量——
                换一次切分方式、换一次排序方式、换一次提示词、放宽一次检索预算、
                补一次中英术语桥——
                然后用完全相同的协议重跑一遍：
                同样 {questions.length} 道题、同一个模型、同一套 judge、同样 {">="}4
                分的成功线。所以轮与轮之间的数字是可以直接比的。
              </p>
            </div>

            <LadderSection />

            <Card className="bg-secondary">
              <CardHeader>
                <CardTitle className="text-base">
                  为什么这个阶梯比一张排行榜更有用
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 text-sm leading-relaxed">
                <p>
                  排行榜只能告诉你「现在这个版本比那个版本好」。
                  阶梯能告诉你{" "}
                  <span className="font-medium text-foreground">
                    收益来自哪一层
                  </span>
                  ：改切分能救回多少题、改提示词能救回多少题、
                  放宽预算又能救回多少题。每一轮的收益都被单独归因了。
                </p>
                <p>
                  而且每一轮的改动都是可以复现的：命令写在下面的复现步骤里，
                  检索层的数字任何人几分钟就能重算一遍，生成层的数字则取决于
                  同一个模型同一批题。
                </p>
                <p className="text-muted-foreground">
                  阶梯也暴露了「改不动的地方」。有些题在最后一轮仍然没有答对——
                  它们不是被某一次改动修好的，而是从根本上缺了检索能力：
                  要么问题问的东西压根不在检索预算内，要么需要跨文件的推理，
                  这两种都需要比「调参」更大的改动。
                </p>
              </CardContent>
            </Card>
          </section>
        )}

        {modelComparison && (
          <section id="models" className="scroll-mt-16 mt-12 flex flex-col gap-6">
            <div className="flex flex-col gap-2">
              <SectionTitle id="models" scope="Flask 3.1.3 · 22 道题">
                多模型对比：这把尺子分不分得出好坏
              </SectionTitle>
              <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
                前面所有数字都来自同一个模型、同一个仓库（Flask 3.1.3）。现在把被测对象换掉：
                <span className="font-medium text-foreground">
                  同一份配置、同一批题，换三个模型来答
                </span>
                ，再用同一批尺子给它们打分。
                这一节要回答的不是「谁更强」——22 道题排出来的名次差一两位说明不了问题——
                而是{" "}
                <span className="font-medium text-foreground">
                  这把尺子能不能区分出模型的好坏，以及尺子自己有多可信
                </span>
                ：每份答案都被几把尺子各量一遍，答案一个字都没改，
                尺子之间的一致率和自评偏袒都能算出来。
              </p>
            </div>

            <ModelComparisonSection />
          </section>
        )}

        {multiProject && (
          <section id="projects" className="scroll-mt-16 mt-12 flex flex-col gap-6">
            <div className="flex flex-col gap-2">
              <SectionTitle
                id="projects"
                scope="Flask / Requests / Werkzeug / Jinja2"
              >
                多项目对比：换个仓库这把尺子还灵不灵
              </SectionTitle>
              <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
                前面所有数字都来自一个仓库（Flask 3.1.3）。这就把结论的适用范围限死在了一个项目上——
                换一套代码风格、换一种目录组织、换一个规模，它还量得出同样的东西吗？
                这里把被测对象换成四个真实项目：
                <span className="font-medium text-foreground">
                  同一份配置、同一把尺子、各自 22 道人工标注的题
                </span>
                。四个项目的语言、规模、目录结构都不一样，
                题也是各自单独标的，所以这份对比量的是尺子本身的迁移能力。
              </p>
            </div>

            <ProjectComparisonSection />
          </section>
        )}

        <ChapterHeader
          id="chapter-evidence"
          numeral="4"
          title="证据与复现"
          lead="每一个数字都能被打开看，也能被重新算一遍：逐题证据、失败分类、judge 自检，和一条命令就能跑的复现流水线。逐题证据与失败分类都来自 Flask 3.1.3。"
        />

        <section id="questions" className="scroll-mt-16 mt-10 flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <SectionTitle id="questions" scope="Flask 3.1.3">
              逐题检索台
            </SectionTitle>
            <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
              每道题都可以展开，对比三种策略各自把哪些代码块排在了前面，
              以及标准答案要求的位置有没有被命中。实心圆是命中，空心圆是没有覆盖到证据。
            </p>
          </div>
          <QuestionExplorer />
        </section>

        <section id="failures" className="scroll-mt-16 mt-12 flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <SectionTitle id="failures" scope="Flask 3.1.3">
              失败归因
            </SectionTitle>
            <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
              失败不是一句「模型不行」。这里把 top-6 都没命中标准答案的题目单独挑出来，
              按类别归类，看看 Agent 到底是在哪一类问题上失手。
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {missesByStrategy.map(({ metrics, missed, byCategory }) => (
              <Card key={metrics.strategy.id}>
                <CardHeader>
                  <CardTitle className="text-base">
                    {metrics.strategy.label}
                  </CardTitle>
                  <CardDescription>
                    top-6 内有 {missed.length} / {questions.length}{" "}
                    题没有命中任何一条标准证据
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex min-w-0 flex-col gap-3">
                  {byCategory.size === 0 && (
                    <p className="text-sm text-muted-foreground">
                      全部题目都在 top-6 内命中了证据。
                    </p>
                  )}
                  {[...byCategory.entries()].map(([category, ids]) => (
                    <div key={category} className="flex items-start justify-between gap-3">
                      <span className="text-sm">
                        {CATEGORY_LABEL[category]}
                        <span className="text-muted-foreground">
                          {" "}
                          · {ids.length} 题
                        </span>
                      </span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {ids.join(" ")}
                      </span>
                    </div>
                  ))}
                </CardContent>
              </Card>
            ))}
          </div>
          <p className="text-sm text-muted-foreground">
            最吃力的是{" "}
            <span className="font-medium text-foreground">
              {hardestStrategy.metrics.strategy.label}
            </span>{" "}
            策略下的 {hardestStrategy.missed.length} 道题。
            把它们的题目打开对照着看，就能判断：是切分把关键代码切碎了，
            还是提问里的词压根就没在代码里出现过。这两种失败要开的药方完全不同。
          </p>
        </section>

        <section id="trust" className="scroll-mt-16 mt-12 flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <SectionTitle id="trust" scope="Flask 3.1.3">
              信任基础：judge 自己够不够准
            </SectionTitle>
            <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
              用大模型给另一个大模型打分，会遇到一个循环论证的问题：分数到底准不准？
              我们的做法是先校验裁判本身——让 judge 去给<span className="font-medium text-foreground">人工写的参考答案</span>
              打分，再和人工给这份参考答案打的分相比。
              如果 judge 连人写的标准答案都打不出人工给的水平，那它给 Agent
              打的分更没有理由被相信。
            </p>
          </div>
          {hasJudgeValidation ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Metric
                  label="judge 与人工一致率"
                  value={formatPercent(judgeValidation.agreement)}
                  hint="相差不超过 1 分即视为一致"
                />
                <Metric
                  label="完全同分率"
                  value={formatPercent(judgeValidation.exactAgreement)}
                  hint="更严格的判定口径"
                />
                <Metric
                  label="judge 均分"
                  value={judgeValidation.meanJudgeScore.toFixed(2)}
                  hint={`人工均分 ${judgeValidation.meanHumanScore.toFixed(2)}`}
                />
                <Metric
                  label="参与校验题数"
                  value={String(judgeValidation.sampled)}
                  hint="每题都有人工标注的参考答案"
                />
              </div>
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">读数说明</CardTitle>
                  <CardDescription>{judgeValidation.note}</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3 text-sm leading-relaxed">
                  <p>
                    一致率如果明显偏低，说明 judge 系统性地偏严或偏松，
                    这时生成层的分数只能用于「同一把尺子下的相对比较」，
                    不能当成绝对质量分。
                  </p>
                  {judgeValidation.meanJudgeScore !==
                    judgeValidation.meanHumanScore && (
                    <p className="text-muted-foreground">
                      这一次 judge 的均分是{" "}
                      <span className="font-mono text-foreground">
                        {judgeValidation.meanJudgeScore.toFixed(2)}
                      </span>
                      ，人工是{" "}
                      <span className="font-mono text-foreground">
                        {judgeValidation.meanHumanScore.toFixed(2)}
                      </span>
                      ，偏差{" "}
                      {(
                        judgeValidation.meanJudgeScore -
                        judgeValidation.meanHumanScore
                      ).toFixed(2)}{" "}
                      分。所以下面的生成层分数请当成同一把尺子下的相对刻度，
                      而不是绝对的质量分。
                    </p>
                  )}
                  <p className="text-muted-foreground">
                    这个自检不依赖任何 Agent 输出，所以它可以和检索层一样完全离线复现：
                    只要评测集和模型一致，任何人都能算出同一份一致率。
                  </p>
                </CardContent>
              </Card>
              {modelComparison && modelComparison.agreementMatrix.length > 0 ? (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">
                      还有第二道校验：换一把尺子
                    </CardTitle>
                    <CardDescription>
                      自检只验证了「尺子对人工答案准不准」。
                      多模型对比那一节补上了另一半：同一批答案换一把尺子重打，
                      看两个尺子的判断差多少。
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3 text-sm leading-relaxed">
                    <p>
                      最不一致的一对尺子，一致率{" "}
                      <span className="font-mono text-foreground">
                        {formatPercent(
                          Math.min(
                            ...modelComparison.agreementMatrix.map(
                              (item) => item.agreement,
                            ),
                          ),
                        )}
                      </span>
                      ，有{" "}
                      <span className="font-mono text-foreground">
                        {Math.max(
                          ...modelComparison.agreementMatrix.map(
                            (item) => item.flips,
                          ),
                        )}
                      </span>{" "}
                      题的「达没达标」判断被翻转了。这个量级就是这套评测的误差下限——
                      它决定了模型之间差多少个百分点才算「真的分出高下」。
                    </p>
                  </CardContent>
                </Card>
              ) : null}
            </>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">当前状态：尚未运行</CardTitle>
                <CardDescription>{judgeValidation.note}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 text-sm leading-relaxed">
                <p className="text-muted-foreground">
                  judge 自检和生成层评测都需要真实的大模型调用。当前环境没有配置可用的模型密钥，
                  所以这一层的数据暂时是空的——站点上展示的所有数字都来自不依赖大模型的检索层，
                  没有任何一个数字是编出来的。
                </p>
                <p className="text-muted-foreground">
                  一旦配置密钥，同样的评测集会立刻补上 judge 一致率，
                  以及成功率、平均分、延迟与成本。
                </p>
              </CardContent>
            </Card>
          )}
        </section>

        <section id="repro" className="scroll-mt-16 mt-12 flex flex-col gap-6">
          <SectionTitle id="repro">怎么复现</SectionTitle>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">把代码拿走，本地跑一遍</CardTitle>
              <CardDescription>
                评测流水线和站点源码都开在 GitHub 上（MIT 许可）。clone 之后不需要注册、
                不需要密钥，几分钟就能跑出和本页一模一样的检索层数字。命令按系统分开给——
                同一串命令在 Windows 和 macOS/Linux 上踩的坑不在一处。
              </CardDescription>
            </CardHeader>
            <CardContent className="flex min-w-0 flex-col gap-4">
              <Button asChild size="lg" className="w-fit">
                <a
                  href={REPO_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  <GitBranch className="size-4" />
                  打开 GitHub 仓库（eval-bench）
                </a>
              </Button>

              <Tabs defaultValue="windows" className="min-w-0">
                <TabsList>
                  <TabsTrigger value="windows">Windows</TabsTrigger>
                  <TabsTrigger value="unix">macOS / Linux</TabsTrigger>
                </TabsList>

                <TabsContent
                  value="windows"
                  className="mt-4 flex min-w-0 flex-col gap-4"
                >
                  <div className="grid gap-3 lg:grid-cols-3">
                    <ReproStep
                      step="1"
                      title="拉语料"
                      description={
                        <>
                          先 <code className="font-mono">git clone</code> 仓库并进到{" "}
                          <code className="font-mono">eval-bench</code>，再跑仓库自带的{" "}
                          <code className="font-mono">corpus\fetch.ps1</code>：它从 PyPI
                          抓 Flask 3.1.3 等四个固定版本的源码包并解包，约 3 MB。
                          只要 PowerShell 5.1 以上加 Node.js，不用装 Python，也不用装 Git。
                        </>
                      }
                    />
                    <ReproStep
                      step="2"
                      title="跑离线检索层"
                      description={
                        <>
                          先切到 <span className="font-mono">harness</span>{" "}
                          再跑：<span className="font-mono">.env</span>{" "}
                          是按当前工作目录找的，在仓库根目录跑会读不到密钥。
                          这一层不花钱、不需要密钥。
                        </>
                      }
                    />
                    <ReproStep
                      step="3"
                      title="对照本页数字"
                      description={
                        <>
                          三种切分策略的 recall@1/3/6 与 MRR 会打在终端上，应当和这页完全一致。
                          生成层需要你自己的模型密钥。
                        </>
                      }
                    />
                  </div>

                  <h4 className="text-sm font-medium">完整命令（复制即用）</h4>
                  <pre className="table-scroll overflow-x-auto rounded-md bg-secondary/60 p-4 font-mono text-xs leading-relaxed">
                    <code>{WINDOWS_COMMANDS}</code>
                  </pre>

                  <div className="flex min-w-0 flex-col gap-2">
                    <h4 className="text-sm font-medium">Windows 上最容易踩的坑</h4>
                    <PitfallList
                      items={[
                        <>
                          <span className="font-medium text-foreground">中文输出乱码。</span>{" "}
                          Windows PowerShell 5.1 控制台默认 GBK，Node 打印的 UTF-8
                          中文会变成方块或问号。先执行一次{" "}
                          <code className="font-mono">
                            [Console]::OutputEncoding=[System.Text.Encoding]::UTF8
                          </code>
                          ；用 PowerShell 7 或 Windows Terminal 则默认就是 UTF-8。
                        </>,
                        <>
                          <span className="font-medium text-foreground">红色 NativeCommandError 是假警报。</span>{" "}
                          <code className="font-mono">node --experimental-strip-types</code>{" "}
                          会往 stderr 写一行 ExperimentalWarning，PowerShell 5.1
                          把它渲染成一条红色错误记录。命令其实已经成功，看后面的输出就行。
                        </>,
                        <>
                          <span className="font-medium text-foreground">续行符不一样。</span>{" "}
                          PowerShell 是反引号 <code className="font-mono">`</code>、
                          cmd 是 <code className="font-mono">^</code>、bash 是{" "}
                          <code className="font-mono">\</code>。本页给的 Windows
                          命令全部写成一行，不用续行；非要续行时反引号后面不能有空格。
                        </>,
                        <>
                          <span className="font-medium text-foreground">.ps1 要存成带 BOM 的 UTF-8。</span>{" "}
                          PowerShell 5.1 按 ANSI（GBK）读没有 BOM 的 .ps1，文件里有中文注释
                          就会直接 ParserError。<span className="font-mono">fetch.ps1</span>{" "}
                          已经是带 BOM 的；自己写脚本记得同样存。
                        </>,
                        <>
                          <span className="font-medium text-foreground">tar 可能会撞车。</span>{" "}
                          PowerShell 里的 tar 有可能是 Git 自带的 GNU tar，而不是 Windows
                          自带的 bsdtar。<span className="font-mono">fetch.ps1</span>{" "}
                          里已经把路径写死到 <span className="font-mono">System32\tar.exe</span>，
                          不用你操心。
                        </>,
                      ]}
                    />
                  </div>
                </TabsContent>

                <TabsContent
                  value="unix"
                  className="mt-4 flex min-w-0 flex-col gap-4"
                >
                  <div className="grid gap-3 lg:grid-cols-3">
                    <ReproStep
                      step="1"
                      title="拉语料"
                      description={
                        <>
                          先 <code className="font-mono">git clone</code> 仓库并进到{" "}
                          <code className="font-mono">eval-bench</code>，再跑仓库自带的{" "}
                          <code className="font-mono">corpus/fetch.sh</code>：它从 PyPI
                          抓 Flask 3.1.3 等四个固定版本的源码包并解包，约 3 MB。
                          只要 bash + curl + tar + Node.js，不用装 Python。
                        </>
                      }
                    />
                    <ReproStep
                      step="2"
                      title="跑离线检索层"
                      description={
                        <>
                          先切到 <span className="font-mono">harness</span>{" "}
                          再跑：<span className="font-mono">.env</span>{" "}
                          是按当前工作目录找的，在仓库根目录跑会读不到密钥。
                          这一层不花钱、不需要密钥。
                        </>
                      }
                    />
                    <ReproStep
                      step="3"
                      title="对照本页数字"
                      description={
                        <>
                          三种切分策略的 recall@1/3/6 与 MRR 会打在终端上，应当和这页完全一致。
                          生成层需要你自己的模型密钥。
                        </>
                      }
                    />
                  </div>

                  <h4 className="text-sm font-medium">完整命令（复制即用）</h4>
                  <pre className="table-scroll overflow-x-auto rounded-md bg-secondary/60 p-4 font-mono text-xs leading-relaxed">
                    <code>{UNIX_COMMANDS}</code>
                  </pre>

                  <div className="flex min-w-0 flex-col gap-2">
                    <h4 className="font-medium text-sm">macOS / Linux 上要注意的</h4>
                    <PitfallList
                      items={[
                        <>
                          <span className="font-medium text-foreground">必须先 cd harness。</span>{" "}
                          <span className="font-mono">.env</span> 和默认输出路径{" "}
                          <span className="font-mono">out/report.json</span>{" "}
                          都是按当前工作目录算的，在仓库根目录跑会读不到密钥，报告也会落到别处。
                        </>,
                        <>
                          <span className="font-medium text-foreground">Node 要 22.13 以上。</span>{" "}
                          <code className="font-mono">--experimental-strip-types</code>{" "}
                          从这个版本才可用；更老的 Node 改用{" "}
                          <code className="font-mono">npx tsx src/cli.ts …</code> 即可。
                        </>,
                        <>
                          <span className="font-medium text-foreground">tar 参数两个系统都吃。</span>{" "}
                          <span className="font-mono">fetch.sh</span> 用的{" "}
                          <code className="font-mono">--strip-components</code> 在 macOS
                          自带的 bsdtar 和 Linux 的 GNU tar 上都支持，不用改写法。
                        </>,
                      ]}
                    />
                  </div>
                </TabsContent>
              </Tabs>

              <p className="text-sm text-muted-foreground">
                需要 Node.js 22.13 以上（用 <code className="font-mono text-xs">--experimental-strip-types</code>{" "}
                直接跑 TypeScript，harness 本身零第三方依赖，不需要 npm install）。
                不想装 git 的话，仓库页的 Code → Download ZIP 拿到的永远是最新快照。
              </p>
              <p className="text-sm text-muted-foreground">
                评测集、检索器和切分策略全部开源，跑出来的每个数字都能在几分钟内被重新算一遍。
                代码在 <a href={REPO_URL} target="_blank" rel="noreferrer" className="underline underline-offset-4 hover:text-foreground">GitHub 仓库</a>（MIT 许可）。
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">不想啃命令行？起一个本地工作台</CardTitle>
              <CardDescription>
                仓库里还带一份本地工具页：起一个服务，打开浏览器就是录题集、校验证据、
                跑检索评测、看图表，没有介绍内容。它和这一页共用同一套组件、
                同一份 report.json 契约，所以数字口径一致；服务只监听 127.0.0.1，
                不对外暴露，产物也不进发布包。
              </CardDescription>
            </CardHeader>
            <CardContent className="flex min-w-0 flex-col gap-3">
              <pre className="table-scroll overflow-x-auto rounded-md bg-secondary/60 p-4 font-mono text-xs leading-relaxed">
                <code>{LOCAL_WORKBENCH_COMMANDS}</code>
              </pre>
              <p className="text-sm text-muted-foreground">
                打开 http://127.0.0.1:8787/ 就是工具页；
                同一端口下的 /story 是这一页的本地版本。命令和坑见仓库 README。
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">把数据带走</CardTitle>
              <CardDescription>
                页面上的每个数字都能下载：CSV 可直接进 Excel，JSON 是评测流水线产出的原始报告。
                除「多项目对比 CSV」外，其余 CSV 的数字都来自{" "}
                <span className="font-mono text-foreground">Flask 3.1.3</span>{" "}
                这一个仓库。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ExportButtons />
            </CardContent>
          </Card>
        </section>
        </div>

        {view === "data" && <DataView />}

        <footer className="mt-16 flex flex-col gap-6 rounded-xl border bg-card px-6 py-6 text-sm text-muted-foreground shadow-sm">
          <div className="grid gap-6 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-foreground">评测台</span>
              <span>数据集 {report.datasetId}</span>
              <span>仓库 {report.repo}</span>
              <a
                href={REPO_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex w-fit items-center gap-1 underline underline-offset-4 hover:text-foreground"
              >
                <GitBranch className="size-3.5" />
                开源仓库（MIT）
              </a>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-foreground">数据来源</span>
              <span>
                本页展示的全部指标来自本地评测流水线产出的 report.json，未使用任何模拟数据。
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-foreground">赛事</span>
              <span>StudyHack · 学习科研</span>
              <span>2026 Qoder 高校创造力大赛</span>
            </div>
          </div>
          <div className="border-t pt-4 text-xs">
            课设 Copilot 评测台 · 用 Qoder 构建，部署于 Qoder Sites
          </div>
        </footer>
      </div>
    </div>
  );
}
