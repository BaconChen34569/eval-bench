import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ThemeToggle, useTheme } from "@/components/theme-toggle";

import { setReport, emptyReport, type ExperimentReport } from "@/data/report";
import { api, type GenMode, type Health } from "@/src/workbench/api";
import { DatasetPanel } from "@/src/workbench/dataset-panel";
import { GenPanel } from "@/src/workbench/gen-panel";
import { LoadPanel } from "@/src/workbench/load-panel";
import { ReportPanel } from "@/src/workbench/report-panel";
import { SecretsPanel } from "@/src/workbench/secrets-panel";

/** 三种跑法的名字，结果区要标出现在摆的是哪一份。 */
const GEN_MODE_LABELS: Record<GenMode, string> = {
  single: "单模型",
  ladder: "迭代阶梯",
  compare: "多模型对比",
};

/**
 * 本地工作台。
 *
 * 公开站是叙事页，这一页是工具页：
 * 打开就能粘数据看结果，或者直接录题集跑评测，不用先读一遍介绍。
 */
export function Workbench() {
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [tab, setTab] = useState("load");
  /**
   * 三份结果各归各的模块：
   * 「填数据出图」载入的报告、「录题集跑评测」跑出来的报告、
   * 「跑生成层」跑出来的报告互不串台。
   * 生成层内部再按跑法分开：单模型、迭代阶梯、多模型对比各存各的，
   * 跑完一种切到另一种，看到的还是刚跑完那一种的结果。
   */
  const [reports, setReports] = useState<{
    load: ExperimentReport | null;
    dataset: ExperimentReport | null;
    gen: Record<GenMode, ExperimentReport | null>;
  }>({
    load: null,
    dataset: null,
    gen: { single: null, ladder: null, compare: null },
  });
  const [genMode, setGenMode] = useState<GenMode>("single");
  const [theme, setTheme] = useTheme();
  const resultRef = useRef<HTMLElement>(null);
  /** 报告的当前值。换个跑法时要立刻拿到最新那份，所以放一份 ref。 */
  const reportsRef = useRef(reports);
  reportsRef.current = reports;

  useEffect(() => {
    api
      .health()
      .then((value) => {
        setHealth(value);
        setHealthError(null);
      })
      .catch((error: unknown) => {
        setHealthError(error instanceof Error ? error.message : String(error));
      });
  }, []);

  // 数据换了一份就把结果面板整块重挂一次，
  // 这样组件里 useMemo 缓存的旧结果不会留在屏幕上。
  const applyReport = useCallback(
    (
      next: ExperimentReport,
      source: "load" | "dataset" | GenMode,
    ) => {
      if (source === "load" || source === "dataset") {
        setReports((prev) => ({ ...prev, [source]: next }));
        setReport(next);
        setVersion((value) => value + 1);
        // 结果区在页面最下面，跑完评测得让人看见图，别自己去找。
        window.requestAnimationFrame(() => {
          resultRef.current?.scrollIntoView({
            behavior: "smooth",
            block: "start",
          });
        });
        return;
      }
      // 生成层：先按跑法存起来。是不是现在摆出来，看当前跑法是不是这一种。
      setReports((prev) => ({
        ...prev,
        gen: { ...prev.gen, [source]: next },
      }));
      if (source !== genMode) return;
      setReport(next);
      setVersion((value) => value + 1);
      window.requestAnimationFrame(() => {
        resultRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      });
    },
    [genMode],
  );

  // 换跑法就把这一种跑法的结果端上桌：没跑过的跑法是空的，
  // 不能把上一种跑法的结果留在那儿冒充。
  const changeGenMode = useCallback((next: GenMode) => {
    setGenMode(next);
    setReport(reportsRef.current.gen[next] ?? emptyReport());
    setVersion((value) => value + 1);
  }, []);

  // 生成层跑完，把报告按跑法存起来。
  const handleGenReport = useCallback(
    (next: ExperimentReport, mode: GenMode) => applyReport(next, mode),
    [applyReport],
  );

  // 换页时把这一页该看的报告放上桌：没跑过的页就是空的，
  // 不能把另一页的结果端过来。
  const switchTab = (next: string) => {    setTab(next);
    if (next === "secrets") return;
    const target =
      next === "load"
        ? reports.load
        : next === "dataset"
          ? reports.dataset
          : reports.gen[genMode];
    setReport(target ?? emptyReport());
    setVersion((value) => value + 1);
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-base font-semibold">课设 Copilot 本地评测工作台</h1>
            <p className="text-xs text-muted-foreground">
              打开就能填数据看结果，或者录一套题直接跑检索评测。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {healthError ? (
              <Badge variant="destructive">本地服务没连上</Badge>
            ) : health ? (
              <Badge variant="secondary">
                本地服务已连接 · 代码版本 {health.codeVersion}
              </Badge>
            ) : (
              <Badge variant="outline">
                <Loader2 className="mr-1 size-3 animate-spin" />
                连接本地服务
              </Badge>
            )}
            <Button variant="outline" size="sm" asChild>
              <a href="/story">叙事版站点</a>
            </Button>
            <ThemeToggle choice={theme} onChange={setTheme} />
          </div>
        </div>
      </header>

      <main className="mx-auto flex max-w-6xl flex-col gap-5 px-4 py-6">
        {healthError && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm">
            <p className="font-medium">连不上本地评测服务，录题集和跑评测暂时用不了。</p>
            <p className="mt-1 text-muted-foreground">
              先在仓库的 harness 目录里起服务，然后刷新本页：
            </p>
            <pre className="mt-2 overflow-x-auto rounded-md bg-secondary px-3 py-2 font-mono text-xs">
              {`cd harness && node --experimental-strip-types src/cli.ts serve`}
            </pre>
            <p className="mt-2 text-xs text-muted-foreground">
              {healthError}
            </p>
          </div>
        )}

        <Tabs value={tab} onValueChange={switchTab} className="flex flex-col gap-4">
          <TabsList>
            <TabsTrigger value="load">填数据出图</TabsTrigger>
            <TabsTrigger value="dataset">录题集跑评测</TabsTrigger>
            <TabsTrigger value="gen">跑生成层</TabsTrigger>
            <TabsTrigger value="secrets">模型密钥</TabsTrigger>
          </TabsList>

          <TabsContent value="load" className="flex flex-col gap-4">
            <LoadPanel onReport={(next) => applyReport(next, "load")} />
            <ResultSection
              variant="load"
              resultRef={resultRef}
              version={version}
            />
          </TabsContent>

          <TabsContent value="dataset" className="flex flex-col gap-4">
            <DatasetPanel
              health={health}
              onReport={(next) => applyReport(next, "dataset")}
              onHealthChange={setHealth}
            />
            <ResultSection
              variant="dataset"
              resultRef={resultRef}
              version={version}
            />
          </TabsContent>

          <TabsContent value="gen" className="flex flex-col gap-4">
            <GenPanel
              health={health}
              mode={genMode}
              onModeChange={changeGenMode}
              onReport={handleGenReport}
            />
            <ResultSection
              variant="gen"
              resultRef={resultRef}
              version={version}
              note={`跑法：${GEN_MODE_LABELS[genMode]}`}
            />
          </TabsContent>

          <TabsContent value="secrets" className="flex flex-col gap-4">
            <SecretsPanel />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}

/**
 * 结果区。
 *
 * 两个模块各有一份：填进来的数据和跑出来的结果是两回事，
 * 摆在同一个区块里会让人以为跑评测已经跑过了。
 */
function ResultSection({
  variant,
  resultRef,
  version,
  note,
}: {
  variant: "load" | "dataset" | "gen";
  resultRef: RefObject<HTMLElement | null>;
  version: number;
  /** 现在摆的是哪一份结果，说清楚免得看成别的跑法的。 */
  note?: string;
}) {
  return (
    <section ref={resultRef} className="flex flex-col gap-4 scroll-mt-20">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold tracking-wide text-muted-foreground">
          结果
          {note && (
            <Badge variant="outline" className="font-normal">
              {note}
            </Badge>
          )}
        </h2>
        <span className="text-xs text-muted-foreground">
          图表和公开站是同一套组件，数字来自同一份报告
        </span>
      </div>
      <ReportPanel key={version} variant={variant} />
    </section>
  );
}
