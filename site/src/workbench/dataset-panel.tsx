import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

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
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";

import type { ExperimentReport } from "@/data/report";
import {
  api,
  type Health,
  type ValidateResult,
  type WorkDataset,
} from "@/src/workbench/api";
import { QuestionEditor } from "@/src/workbench/question-editor";

function blankDataset(): WorkDataset {
  return {
    id: "my-dataset",
    repo: "",
    language: "python",
    createdAt: new Date().toISOString().slice(0, 10),
    questions: [],
  };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * 录题集跑评测。
 *
 * 校验和评测都走 harness 的接口，
 * 页面只负责收集题——判断证据对不对、算召回率的是评测台本身。
 */
export function DatasetPanel({
  health,
  onReport,
  onHealthChange,
}: {
  health: Health | null;
  onReport: (report: ExperimentReport) => void;
  onHealthChange: (health: Health) => void;
}) {
  const [repoRoot, setRepoRoot] = useState("");
  const [dataset, setDataset] = useState<WorkDataset | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [validation, setValidation] = useState<ValidateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (health && !repoRoot) setRepoRoot(health.defaultRepoRoot);
  }, [health, repoRoot]);

  // 服务起来后直接把第一套题集载入，省得用户先在空下拉框里选一次。
  const autoLoaded = useRef(false);
  useEffect(() => {
    const first = health?.datasets?.[0];
    if (!first || autoLoaded.current) return;
    autoLoaded.current = true;
    void loadDataset(first.id);
  }, [health]);

  const run = async (name: string, action: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    setMessage(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy("");
    }
  };

  const loadDataset = (id: string) =>
    run("load", async () => {
      if (!id) {
        setDataset(null);
        return;
      }
      // 先把下拉框选中的值定下来，否则请求回来之前它会弹回空值。
      setSelectedId(id);
      const loaded = await api.dataset(id);
      setDataset(loaded);
      setValidation(null);
      setMessage(`已载入题集 ${loaded.id}（${loaded.questions.length} 道题）`);
    });

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    await run("load", async () => {
      const text = await file.text();
      const parsed = JSON.parse(text) as WorkDataset;
      setDataset(parsed);
      setSelectedId("");
      setValidation(null);
      setMessage(`已从 ${file.name} 载入题集，可以直接编辑`);
    });
  };

  const validate = () =>
    run("validate", async () => {
      if (!dataset) throw new Error("先载入或新建一套题集");
      const result = await api.validate(dataset, repoRoot);
      setValidation(result);
      setMessage(
        result.problems.length === 0
          ? `证据全部校验通过（仓库 ${result.repoRoot}）`
          : `发现 ${result.problems.length} 个问题`,
      );
    });

  const evaluate = () =>
    run("evaluate", async () => {
      if (!dataset) throw new Error("先载入或新建一套题集");
      const result = await api.evaluate(dataset, repoRoot);
      const next: ExperimentReport = {
        datasetId: result.datasetId,
        repo: result.repo,
        costCurrency: "¥",
        judgeValidation: {
          sampled: 0,
          agreement: 0,
          meanJudgeScore: 0,
          meanHumanScore: 0,
          exactAgreement: 0,
          note: "本地工作台只跑检索层，不调用模型，所以没有 judge 数据",
        },
        strategies: result.strategies,
        runs: [],
        ladder: [],
        ladderRuns: [],
      };
      onReport(next);
      setMessage(
        `检索评测跑完了：${result.strategies.length} 种策略，仓库 ${result.repoRoot}`,
      );
    });

  const save = () =>
    run("save", async () => {
      if (!dataset) throw new Error("先载入或新建一套题集");
      const result = await api.saveDataset(dataset);
      setMessage(`已保存到 ${result.path}`);
      const refreshed = await api.health();
      onHealthChange(refreshed);
    });

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">被测仓库</CardTitle>
          <CardDescription>
            评测在这个仓库上跑，证据行号也是对着它校验的。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Input
            value={repoRoot}
            onChange={(event) => setRepoRoot(event.target.value)}
            placeholder="D:\\qcode\\creativity_race\\corpus\\repos\\flask-3.1.3"
            className="font-mono text-xs"
          />
          <p className="text-xs text-muted-foreground">
            留空就用服务启动时的默认仓库。路径写错了校验会直接报文件不存在。
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">题集</CardTitle>
          <CardDescription>
            从 harness/datasets 里选一套，或者新建一套开始录题。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <NativeSelect
              value={selectedId}
              onChange={(event) => void loadDataset(event.target.value)}
              className="w-full sm:w-64"
            >
              <NativeSelectOption value="">（选择题集）</NativeSelectOption>
              {(health?.datasets ?? []).map((item) => (
                <NativeSelectOption key={item.id} value={item.id}>
                  {item.id} · {item.questions} 题
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setDataset(blankDataset());
                setSelectedId("");
                setValidation(null);
                setMessage("新建了一套空题集，先加题");
              }}
            >
              新建题集
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => fileRef.current?.click()}
            >
              从文件载入
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(event) => void onFile(event.target.files?.[0])}
            />
          </div>

          {dataset && (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">
                  题集 id（保存时的文件名）
                </span>
                <Input
                  value={dataset.id}
                  onChange={(event) =>
                    setDataset({ ...dataset, id: event.target.value })
                  }
                  className="font-mono"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">
                  仓库名（报告里显示用）
                </span>
                <Input
                  value={dataset.repo}
                  onChange={(event) =>
                    setDataset({ ...dataset, repo: event.target.value })
                  }
                  placeholder="Flask 3.1.3"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">
                  语言
                </span>
                <Input
                  value={dataset.language}
                  onChange={(event) =>
                    setDataset({ ...dataset, language: event.target.value })
                  }
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">
                  建题日期
                </span>
                <Input
                  type="date"
                  value={dataset.createdAt?.slice(0, 10) || today()}
                  onChange={(event) =>
                    setDataset({ ...dataset, createdAt: event.target.value })
                  }
                />
              </label>
            </div>
          )}

          {dataset && <QuestionEditor dataset={dataset} onChange={setDataset} />}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">跑一遍</CardTitle>
          <CardDescription>
            校验只查证据行号对不对；跑评测会算出三种切分策略的召回率，
            这一层不花钱、结果完全可复现。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== ""}
              onClick={() => void validate()}
            >
              {busy === "validate" && (
                <Loader2 className="mr-1 size-4 animate-spin" />
              )}
              校验证据
            </Button>
            <Button
              size="sm"
              disabled={busy !== ""}
              onClick={() => void evaluate()}
            >
              {busy === "evaluate" && (
                <Loader2 className="mr-1 size-4 animate-spin" />
              )}
              跑检索评测
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== ""}
              onClick={() => void save()}
            >
              {busy === "save" && (
                <Loader2 className="mr-1 size-4 animate-spin" />
              )}
              保存到 harness/datasets
            </Button>
          </div>

          <p className="text-xs text-muted-foreground">
            保存的文件名是题集 id（{dataset?.id ?? "my-dataset"}.json）。
            磁盘上已有的同名文件会被覆盖，改之前先想清楚。
          </p>

          {message && (
            <p className="text-xs text-muted-foreground">{message}</p>
          )}
          {error && (
            <Alert variant="destructive">
              <AlertTitle>出错了</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {validation && (
            <div className="flex flex-col gap-2">
              {validation.problems.length > 0 && (
                <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2">
                  <div className="mb-1 flex items-center gap-2">
                    <Badge variant="destructive">
                      {validation.problems.length} 个问题
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      这些不改就没法评测
                    </span>
                  </div>
                  <ul className="flex flex-col gap-1 text-xs">
                    {validation.problems.map((item, index) => (
                      <li key={index} className="font-mono">
                        · {item}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {validation.warnings.length > 0 && (
                <details className="rounded-lg border bg-secondary px-3 py-2">
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    {validation.warnings.length} 条提示（不阻断评测）
                  </summary>
                  <ul className="mt-2 flex flex-col gap-1 text-xs">
                    {validation.warnings.map((item, index) => (
                      <li key={index} className="font-mono">
                        · {item}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
