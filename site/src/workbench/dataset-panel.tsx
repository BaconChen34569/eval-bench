import { useEffect, useRef, useState } from "react";
import { ClipboardCopy, Download, Loader2, TriangleAlert } from "lucide-react";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import { copyText, downloadText } from "@/src/workbench/clipboard";
import { parseQuestionsFile } from "@/src/workbench/question-import";
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
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sourceFile, setSourceFile] = useState("");
  const [sourceId, setSourceId] = useState("");
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
      // 记下这份题集是从哪个文件来的：文件名叫 flask，题集 id 却是 flask-v1，
      // 保存时得写回同一个文件，不然磁盘上会多出一份 flask-v1.json。
      const summary = (health?.datasets ?? []).find((item) => item.id === id);
      setSourceFile(summary?.file ?? "");
      setSourceId(loaded.id);
      setMessage(`已载入题集 ${loaded.id}（${loaded.questions.length} 道题）`);
    });

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    await run("load", async () => {
      const text = await file.text();
      // 题目数组、带 questions 的题集、单道题都认，
      // 解析不了就抛错，别把半截数据塞进状态里。
      const parsed = parseQuestionsFile(text);
      setDataset({
        id: parsed.meta.id ?? "my-dataset",
        repo: parsed.meta.repo ?? "",
        language: parsed.meta.language ?? "python",
        createdAt: parsed.meta.createdAt ?? today(),
        questions: parsed.questions,
      });
      setSelectedId("");
      setSourceFile("");
      setSourceId(parsed.meta.id ?? "my-dataset");
      setValidation(null);
      setMessage(
        `已从 ${file.name} 载入 ${parsed.questions.length} 道题，可以直接编辑`,
      );
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

  /**
   * 保存要写到哪个文件。
   *
   * 改了 id 就当是新题集（按新 id 存）；
   * 没改 id 但这份题集是从某个文件载入的，就写回那个文件，
   * 免得磁盘上多出一份内容相同、名字不同的副本。
   */
  const targetFile =
    dataset && sourceFile && dataset.id === sourceId ? sourceFile : "";

  const writeDataset = () =>
    run("save", async () => {
      if (!dataset) throw new Error("先载入或新建一套题集");
      const result = await api.saveDataset(dataset, targetFile);
      setMessage(`已保存到 ${result.path}`);
      const refreshed = await api.health();
      onHealthChange(refreshed);
    });

  // 同名文件会被直接覆盖，所以先问一句。
  const existing = dataset
    ? (health?.datasets ?? []).find(
        (item) => item.file === (targetFile || dataset.id),
      )
    : undefined;

  const save = () => {
    if (!dataset) return;
    if (existing) {
      setConfirmOpen(true);
      return;
    }
    void writeDataset();
  };

  const datasetJson = () =>
    JSON.stringify(
      dataset ?? { id: "", repo: "", language: "", createdAt: "", questions: [] },
      null,
      2,
    );

  const copyDataset = async () => {
    const ok = await copyText(datasetJson());
    setMessage(
      ok
        ? "题集 JSON 已复制，可以直接粘给模型或存成文件"
        : "复制失败，浏览器没给剪贴板权限",
    );
  };

  const downloadDataset = () => {
    if (!dataset) return;
    downloadText(`${dataset.id || "dataset"}.json`, datasetJson());
    setMessage(`已下载 ${dataset.id || "dataset"}.json`);
  };

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
                setSourceFile("");
                setSourceId("");
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
            <Button
              size="sm"
              variant="ghost"
              disabled={!dataset}
              onClick={() => void copyDataset()}
            >
              <ClipboardCopy className="mr-1 size-4" />
              复制题集 JSON
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!dataset}
              onClick={downloadDataset}
            >
              <Download className="mr-1 size-4" />
              下载题集
            </Button>
          </div>

          {!dataset && (
            <p className="text-xs text-muted-foreground">
              还没选题集。上面选一套现成的，或者「新建题集」自己录。
            </p>
          )}

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
              disabled={busy !== "" || !dataset}
              onClick={() => void validate()}
            >
              {busy === "validate" && (
                <Loader2 className="mr-1 size-4 animate-spin" />
              )}
              校验证据
            </Button>
            <Button
              size="sm"
              disabled={busy !== "" || !dataset}
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
              disabled={busy !== "" || !dataset}
              onClick={save}
            >
              {busy === "save" && (
                <Loader2 className="mr-1 size-4 animate-spin" />
              )}
              保存到 harness/datasets
            </Button>
          </div>

          {!dataset && (
            <p className="text-xs text-muted-foreground">
              先在上面载入或新建一套题集，这三个按钮才能用。
            </p>
          )}

          {dataset && (
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              {existing ? (
                <>
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
                  <span>
                    保存会写回 harness/datasets/{existing.file}.json，
                    磁盘上那份同名文件会被整个换掉。
                  </span>
                </>
              ) : (
                <span>
                  保存会写到 harness/datasets/{targetFile || dataset.id}.json。
                  {dataset.questions.length === 0
                    ? "现在一道题都没有，先加题再保存。"
                    : `共 ${dataset.questions.length} 道题。`}
                </span>
              )}
            </p>
          )}

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

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>覆盖已有的题集文件？</AlertDialogTitle>
            <AlertDialogDescription>
              harness/datasets/{existing?.file ?? targetFile ?? dataset?.id}.json
              已经存在，保存会把它整个换掉。磁盘上那份旧题集不会自动备份。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>先不存</AlertDialogCancel>
            <AlertDialogAction onClick={() => void writeDataset()}>
              覆盖保存
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
