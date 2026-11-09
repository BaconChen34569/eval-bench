import { useRef, useState } from "react";
import { FileUp } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";

import sampleReport from "@/data/report.json";
import { setReport, type ExperimentReport } from "@/data/report";

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

/**
 * 填数据出图：粘一份 report.json 就出图。
 *
 * 这份报告可以用评测台命令行产出，产物路径就是 harness/out/report.json；
 * 也就是说本地工作台和命令行读到的是同一份数据，不会各算各的。
 */
export function LoadPanel({
  onReport,
}: {
  onReport: (report: ExperimentReport) => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    apply(await file.text(), file.name);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">填数据出图</CardTitle>
        <CardDescription>
          把评测台跑出来的 report.json 粘进来，或者直接选文件。
          命令行产物默认在 harness/out/report.json。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder='{"datasetId":"flask-v1","repo":"Flask 3.1.3","strategies":[...]}'
          className="min-h-40 font-mono text-xs"
          spellCheck={false}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => apply(text, "粘贴内容")}>
            解析并载入
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => fileRef.current?.click()}
          >
            <FileUp className="mr-1 size-4" />
            选 report.json 文件
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              apply(
                JSON.stringify(sampleReport),
                "示例：公开站那份 Flask 报告",
              )
            }
          >
            载入示例
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(event) => void onFile(event.target.files?.[0])}
          />
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertTitle>载入失败</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {loaded && !error && (
          <p className="text-xs text-muted-foreground">
            已载入：{loaded}。下面的图表和逐题检索台用的是这份数据。
          </p>
        )}
        {!loaded && !error && (
          <p className="text-xs text-muted-foreground">
            现在看到的是随包附带的示例报告（公开站那份 Flask 报告）。
            粘自己的 report.json 就会替换掉它。
          </p>
        )}
      </CardContent>
    </Card>
  );
}
