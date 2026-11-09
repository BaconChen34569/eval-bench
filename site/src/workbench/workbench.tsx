import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ThemeToggle, useTheme } from "@/components/theme-toggle";

import { setReport, type ExperimentReport } from "@/data/report";
import { api, type Health } from "@/src/workbench/api";
import { DatasetPanel } from "@/src/workbench/dataset-panel";
import { LoadPanel } from "@/src/workbench/load-panel";
import { ReportPanel } from "@/src/workbench/report-panel";
import { SecretsPanel } from "@/src/workbench/secrets-panel";

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
  const [theme, setTheme] = useTheme();
  const resultRef = useRef<HTMLElement>(null);

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
  const applyReport = (next: ExperimentReport) => {
    setReport(next);
    setVersion((value) => value + 1);
    // 结果区在页面最下面，跑完评测得让人看见图，别自己去找。
    window.requestAnimationFrame(() => {
      resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
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
              {`cd harness
node --experimental-strip-types src/cli.ts serve`}
            </pre>
            <p className="mt-2 text-xs text-muted-foreground">
              {healthError}
            </p>
          </div>
        )}

        <Tabs value={tab} onValueChange={setTab} className="flex flex-col gap-4">
          <TabsList>
            <TabsTrigger value="load">填数据出图</TabsTrigger>
            <TabsTrigger value="dataset">录题集跑评测</TabsTrigger>
            <TabsTrigger value="secrets">模型密钥</TabsTrigger>
          </TabsList>

          <TabsContent value="load" className="flex flex-col gap-4">
            <LoadPanel onReport={applyReport} />
          </TabsContent>

          <TabsContent value="dataset" className="flex flex-col gap-4">
            <DatasetPanel
              health={health}
              onReport={applyReport}
              onHealthChange={setHealth}
            />
          </TabsContent>

          <TabsContent value="secrets" className="flex flex-col gap-4">
            <SecretsPanel />
          </TabsContent>
        </Tabs>

        {/* 结果区是三个 Tab 共用的，但密钥页跟报告没关系，不显示这块空图表。 */}
        {tab !== "secrets" && (
          <section ref={resultRef} className="flex flex-col gap-4 scroll-mt-20">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold tracking-wide text-muted-foreground">
                结果
              </h2>
              <span className="text-xs text-muted-foreground">
                图表和公开站是同一套组件，数字来自同一份报告
              </span>
            </div>
            <ReportPanel key={version} />
          </section>
        )}
      </main>
    </div>
  );
}
