import { useEffect, useRef, useState } from "react";
import { FileUp, FolderOpen, Loader2, RefreshCw, Wand2 } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";

import { setReport, type ExperimentReport } from "@/data/report";
import { cn } from "@/lib/utils";
import { api, type ReportFile } from "@/src/workbench/api";
import { countText, formatJson } from "@/src/workbench/json";

/**
 * 超过这个字符数，粘贴框就固定高度改成滚动。
 *
 * 报告 JSON 排完版往往上万字，框子跟着长会把下面的按钮顶出屏幕。
 */
const SCROLL_THRESHOLD = 600;

/** 只认得它该有的那几个字段，别的随便。 */
function parseReport(text: string): ExperimentReport {
  const parsed = JSON.parse(text) as Partial<ExperimentReport>;
  if (!parsed || !Array.isArray(parsed.strategies)) {
    throw new Error("这不是一份评测报告：里面没有 strategies 数组");
  }
  if (!parsed.datasetId || !parsed.repo) {
    throw new Error("报告缺少 datasetId 或 repo 字段");
  }
  return {
    costCurrency: "¥",
    judgeValidation: {
      sampled: 0,
      agreement: 0,
      meanJudgeScore: 0,
      meanHumanScore: 0,
      exactAgreement: 0,
      note: "这份报告里没有 judge 自检数据",
    },
    strategies: [],
    runs: [],
    ladder: [],
    ladderRuns: [],
    ...parsed,
  } as ExperimentReport;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 填数据出图：载入评测产物就出图。
 *
 * 产物默认落在 harness/out/report.json，
 * 所以默认先给出「直接读产物目录」这条路：不用自己在磁盘上翻文件。
 * 粘贴框留给从别处拿到的 JSON（比如同事发过来的）。
 */
export function LoadPanel({
  onReport,
}: {
  onReport: (report: ExperimentReport) => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [formatError, setFormatError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [files, setFiles] = useState<ReportFile[]>([]);
  const [outDir, setOutDir] = useState("");
  const [busy, setBusy] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  // 页面一打开就把产物目录列出来，用户一眼能看到自己的报告在哪儿。
  useEffect(() => {
    void refreshFiles();
  }, []);

  const refreshFiles = async () => {
    setBusy("list");
    try {
      const list = await api.reports();
      setFiles(list.files);
      setOutDir(list.outDir);
    } catch {
      // 服务没连上时下面有专门的提示条，这里不用再报一次。
    } finally {
      setBusy("");
    }
  };

  const apply = (raw: string, source: string) => {
    try {
      const next = parseReport(raw);
      setReport(next);
      onReport(next);
      setError(null);
      setLoaded(source);
    } catch (cause) {
      setLoaded(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const loadFromDisk = async (file: ReportFile) => {
    setBusy(file.name);
    setError(null);
    try {
      const report = await api.report(file.name);
      setReport(report);
      onReport(report);
      setLoaded(`${file.path}（${formatTime(file.mtime)}）`);
    } catch (cause) {
      setLoaded(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy("");
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    apply(await file.text(), file.name);
  };

  const beautify = () => {
    const result = formatJson(text);
    if (result.ok) {
      setText(result.text);
      setFormatError(null);
      setError(null);
    } else {
      setFormatError(
        result.problem?.line
          ? `${result.problem.message}（第 ${result.problem.line} 行第 ${result.problem.column} 列）`
          : result.problem?.message ?? "JSON 解析失败",
      );
    }
  };

  const stats = countText(text);
  const scrollable = text.length > SCROLL_THRESHOLD;
  const current = files.find((item) => item.name === "report.json");
  const reports = files.filter(
    (item) => item.kind === "report" && !item.isHistory,
  );
  const history = files.filter(
    (item) => item.kind === "report" && item.isHistory,
  );
  const others = files.filter((item) => item.kind === "other");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">填数据出图</CardTitle>
        <CardDescription>
          先从产物目录载入评测台跑出来的报告；也可以从别处拿一份 JSON 粘进来，
          粘进去会自动排好版。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={!current || busy !== ""}
              onClick={() => current && void loadFromDisk(current)}
            >
              {busy === "report.json" ? (
                <Loader2 className="mr-1 size-4 animate-spin" />
              ) : (
                <FolderOpen className="mr-1 size-4" />
              )}
              载入 report.json
            </Button>
            <Button
              size="icon-sm"
              variant="outline"
              disabled={busy !== ""}
              title="刷新产物列表"
              onClick={() => void refreshFiles()}
            >
              {busy === "list" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              <span className="sr-only">刷新产物</span>
            </Button>
            <span className="text-xs text-muted-foreground">
              {current
                ? `当前报告 ${formatSize(current.size)} · 改于 ${formatTime(current.mtime)}`
                : "这里还没有 report.json"}
            </span>
          </div>

          {outDir && (
            <p className="text-xs text-muted-foreground">
              产物目录：<code className="font-mono">{outDir}</code>
            </p>
          )}
        </div>

        {reports.length > 0 && (
          <details className="rounded-lg border bg-card">
            <summary className="cursor-pointer px-3 py-2 text-xs text-muted-foreground">
              产物目录里的 {reports.length + history.length} 份报告
              （点开可以挑历史副本）
            </summary>
            <ul className="flex flex-col gap-1 border-t px-3 py-2">
              {[...reports, ...history].map((item) => (
                <li key={item.name}>
                  <button
                    type="button"
                    disabled={busy !== ""}
                    onClick={() => void loadFromDisk(item)}
                    className="flex w-full flex-wrap items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-secondary disabled:opacity-50"
                  >
                    <span className="font-mono">{item.name}</span>
                    {item.isHistory && <Badge variant="outline">历史副本</Badge>}
                    <span className="text-muted-foreground">
                      {formatSize(item.size)} · {formatTime(item.mtime)}
                    </span>
                    {busy === item.name && (
                      <Loader2 className="size-3 animate-spin" />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}

        {others.length > 0 && (
          <details className="rounded-lg border bg-card">
            <summary className="cursor-pointer px-3 py-2 text-xs text-muted-foreground">
              另有 {others.length} 个中间产物（对比表、多项目汇总，载进来也画不出图）
            </summary>
            <ul className="flex flex-col gap-1 border-t px-3 py-2">
              {others.map((item) => (
                <li
                  key={item.name}
                  className="flex flex-wrap items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground"
                >
                  <span className="font-mono">{item.name}</span>
                  <span>
                    {formatSize(item.size)} · {formatTime(item.mtime)}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}

        <div className="flex flex-col gap-2 border-t pt-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-medium">手动粘一份 JSON</p>
              <p className="text-xs text-muted-foreground">
                从别处拿到的报告（比如同事发过来的）粘进来，粘进去就自动排好版。
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => fileRef.current?.click()}
              >
                <FileUp className="mr-1 size-4" />
                选文件
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(event) => void onFile(event.target.files?.[0])}
              />
            </div>
          </div>
          <Textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            onPaste={(event) => {
              // 粘贴进来的多半是压缩过的，等它落进框里再排版。
              const pasted = event.clipboardData.getData("text");
              if (!pasted) return;
              event.preventDefault();
              const result = formatJson(pasted);
              if (result.ok) {
                setText(result.text);
                setError(null);
                setFormatError(null);
              } else {
                setText(pasted);
                setFormatError("粘进来的这段不是合法 JSON，先原样留着，可以手动改");
              }
            }}
            onBlur={() => {
              if (!text.trim()) return;
              const result = formatJson(text);
              if (result.ok) setText(result.text);
            }}
            placeholder='{"datasetId":"flask-v1","repo":"Flask 3.1.3","strategies":[...]}'
            className={cn(
              "min-h-40 font-mono text-xs leading-relaxed",
              scrollable && "max-h-72 overflow-y-auto",
            )}
            spellCheck={false}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => apply(text, "粘贴内容")}>
              解析并载入
            </Button>
            <Button size="sm" variant="outline" onClick={beautify}>
              <Wand2 className="mr-1 size-4" />
              排版
            </Button>
            <span className="text-xs text-muted-foreground">
              {stats.lines} 行 · {stats.chars} 字符
            </span>
            {scrollable && (
              <span className="text-xs text-muted-foreground">
                内容较长，框内可以上下滚动。
              </span>
            )}
          </div>
        </div>

        {formatError && (
          <Alert variant="destructive">
            <AlertTitle>这段 JSON 排不了版</AlertTitle>
            <AlertDescription>
              {formatError}。改对之后点「排版」再点「解析并载入」。
            </AlertDescription>
          </Alert>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertTitle>载入失败</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {loaded && !error && (
          <p className="text-xs text-muted-foreground">
            已载入：{loaded}。下面的图表和逐题检索台用的就是这份数据。
          </p>
        )}
        {!loaded && !error && (
          <p className="text-xs text-muted-foreground">
            现在还没有数据。先在命令行跑一次评测，再点上面的「载入
            report.json」；或者直接粘一份 JSON 进来。
          </p>
        )}
      </CardContent>
    </Card>
  );
}
