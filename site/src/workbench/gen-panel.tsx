import { useCallback, useEffect, useRef, useState } from "react";
import { FolderOpen, Loader2, Play, TriangleAlert } from "lucide-react";

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
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";

import type { ExperimentReport } from "@/data/report";
import {
  api,
  type GenJob,
  type GenMode,
  type GenOptions,
  type Health,
} from "@/src/workbench/api";
import { DirPicker } from "@/src/workbench/dir-picker";

const MODES: { id: GenMode; label: string; hint: string }[] = [
  {
    id: "single",
    label: "单模型",
    hint: "一种被测模型跑三种切分策略，比出哪种切法更好。",
  },
  {
    id: "ladder",
    label: "迭代阶梯",
    hint: "工具自己一轮轮改好，每轮只改一个变量，看成功率怎么被推上去。",
  },
  {
    id: "compare",
    label: "多模型对比",
    hint: "同一份配置换被测模型，再用好几把尺子各量一遍。",
  },
];

/**
 * 跑生成层。
 *
 * 检索层不花钱，生成层要真调模型——所以这里跑的是和命令行
 * experiment / ladder / compare 完全相同的那套代码，
 * 出来的数字可以直接和站上已发布的数字对照。
 */
export function GenPanel({
  health,
  onReport,
}: {
  health: Health | null;
  onReport: (report: ExperimentReport) => void;
}) {
  const [options, setOptions] = useState<GenOptions | null>(null);
  const [mode, setMode] = useState<GenMode>("single");
  const [datasetId, setDatasetId] = useState("");
  const [repoRoot, setRepoRoot] = useState("");
  const [agentProfile, setAgentProfile] = useState("");
  const [judgeProfile, setJudgeProfile] = useState("");
  const [agentProfiles, setAgentProfiles] = useState<string[]>([]);
  const [judgeProfiles, setJudgeProfiles] = useState<string[]>([]);
  const [stepId, setStepId] = useState("");
  const [limit, setLimit] = useState("0");
  const [judgeCheck, setJudgeCheck] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [job, setJob] = useState<GenJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const appliedRef = useRef<string | null>(null);

  useEffect(() => {
    void api
      .genOptions()
      .then((next) => {
        setOptions(next);
        setAgentProfile((current) => current || next.profiles[0]?.id || "");
        setJudgeProfile((current) => current || next.profiles[0]?.id || "");
        setAgentProfiles((current) =>
          current.length ? current : next.profiles.slice(0, 2).map((p) => p.id),
        );
        setJudgeProfiles((current) =>
          current.length ? current : next.profiles.slice(0, 1).map((p) => p.id),
        );
        setStepId((current) => current || next.ladder[next.ladder.length - 1]?.id || "");
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      );
  }, []);

  useEffect(() => {
    if (health && !repoRoot) setRepoRoot(health.defaultRepoRoot);
  }, [health, repoRoot]);

  useEffect(() => {
    if (health && !datasetId) setDatasetId(health.datasets[0]?.id ?? "");
  }, [health, datasetId]);

  // 任务在服务端跑，这里轮询看进度。
  const poll = useCallback(async (id: string) => {
    try {
      const next = await api.genJob(id);
      setJob(next);
      if (next.status !== "running") setError(next.error ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    if (!job || job.status !== "running") return;
    const timer = setInterval(() => void poll(job.id), 1500);
    return () => clearInterval(timer);
  }, [job, poll]);

  // 跑完就把报告送进结果区。同一份报告只送一次。
  useEffect(() => {
    if (!job || job.status !== "done" || !job.report) return;
    if (appliedRef.current === job.id) return;
    appliedRef.current = job.id;
    onReport(job.report);
  }, [job, onReport]);

  const running = job?.status === "running";
  const profiles = options?.profiles ?? [];

  const start = async () => {
    setError(null);
    setJob(null);
    appliedRef.current = null;
    try {
      const payload = {
        mode,
        datasetId,
        repoRoot,
        limit: Number(limit) > 0 ? Number(limit) : undefined,
        judgeCheck,
        ...(mode === "compare"
          ? {
              agentProfiles,
              judgeProfiles,
              stepId: stepId || undefined,
            }
          : {
              agentProfile: agentProfile || undefined,
              judgeProfile: judgeProfile || undefined,
            }),
      };
      const started = await api.startGen(payload);
      setJob({
        id: started.jobId,
        mode: started.mode,
        status: "running",
        log: [],
        startedAt: started.startedAt,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((item) => item !== id) : [...list, id];

  const dataset = health?.datasets.find((item) => item.id === datasetId);
  const questionCount = dataset?.questions ?? 0;
  const current = MODES.find((item) => item.id === mode);
  // 粗略估算这次要发多少次模型请求，好让用户知道大概要花多少钱。
  const calls =
    mode === "single"
      ? questionCount * 3 * 2 + (judgeCheck ? questionCount : 0)
      : mode === "ladder"
        ? questionCount * 7 * 2 + (judgeCheck ? questionCount : 0)
        : questionCount * agentProfiles.length * 2;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">跑生成层</CardTitle>
        <CardDescription>
          生成层要真的调模型，跑的是和命令行 experiment / ladder / compare
          完全相同的那套代码——出来的数字可以直接和站上已发布的数字对照。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-2">
          {MODES.map((item) => (
            <button
              key={item.id}
              type="button"
              disabled={running}
              onClick={() => setMode(item.id)}
              className={`inline-flex min-h-8 items-center rounded-full border px-3 text-xs font-medium transition-colors disabled:opacity-50 ${
                mode === item.id
                  ? "border-transparent bg-primary text-primary-foreground"
                  : "border-border text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{current?.hint}</p>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">题集</span>
            <NativeSelect
              value={datasetId}
              onChange={(event) => setDatasetId(event.target.value)}
              disabled={running}
            >
              <NativeSelectOption value="">（选择题集）</NativeSelectOption>
              {(health?.datasets ?? []).map((item) => (
                <NativeSelectOption key={item.id} value={item.id}>
                  {item.id} · {item.questions} 题
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              被测仓库
            </span>
            <div className="flex items-center gap-2">
              <Input
                value={repoRoot}
                onChange={(event) => setRepoRoot(event.target.value)}
                placeholder={health?.defaultRepoRoot ?? "被测仓库的根目录"}
                className="font-mono text-xs"
                disabled={running}
              />
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                disabled={running}
                onClick={() => setPickerOpen(true)}
              >
                <FolderOpen className="mr-1 size-4" />
                选择目录
              </Button>
            </div>
          </label>
        </div>

        {mode === "compare" ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <span className="text-xs font-medium text-muted-foreground">
                被测模型（至少两个）
              </span>
              <div className="flex flex-col gap-1.5 rounded-lg border p-3">
                {profiles.map((profile) => (
                  <label
                    key={profile.id}
                    className="flex items-center gap-2 text-sm"
                  >
                    <Checkbox
                      checked={agentProfiles.includes(profile.id)}
                      disabled={running}
                      onCheckedChange={() =>
                        setAgentProfiles((list) => toggle(list, profile.id))
                      }
                    />
                    <span>{profile.label}</span>
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {profile.model}
                    </span>
                  </label>
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-xs font-medium text-muted-foreground">
                尺子（第一个是主尺子）
              </span>
              <div className="flex flex-col gap-1.5 rounded-lg border p-3">
                {profiles.map((profile) => (
                  <label
                    key={profile.id}
                    className="flex items-center gap-2 text-sm"
                  >
                    <Checkbox
                      checked={judgeProfiles.includes(profile.id)}
                      disabled={running}
                      onCheckedChange={() =>
                        setJudgeProfiles((list) => toggle(list, profile.id))
                      }
                    />
                    <span>{profile.label}</span>
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {profile.model}
                    </span>
                  </label>
                ))}
              </div>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">
                  用阶梯的哪一轮配置
                </span>
                <NativeSelect
                  value={stepId}
                  onChange={(event) => setStepId(event.target.value)}
                  disabled={running}
                >
                  {(options?.ladder ?? []).map((step) => (
                    <NativeSelectOption key={step.id} value={step.id}>
                      {step.id} · {step.title}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </label>
            </div>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">
                被测模型
              </span>
              <NativeSelect
                value={agentProfile}
                onChange={(event) => setAgentProfile(event.target.value)}
                disabled={running}
              >
                {profiles.map((profile) => (
                  <NativeSelectOption key={profile.id} value={profile.id}>
                    {profile.label} · {profile.model}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">
                打分模型
              </span>
              <NativeSelect
                value={judgeProfile}
                onChange={(event) => setJudgeProfile(event.target.value)}
                disabled={running}
              >
                {profiles.map((profile) => (
                  <NativeSelectOption key={profile.id} value={profile.id}>
                    {profile.label} · {profile.model}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
          </div>
        )}

        {profiles.length === 0 && (
          <Alert variant="destructive">
            <AlertTitle>没有可用的模型档案</AlertTitle>
            <AlertDescription>
              先去「模型密钥」那一页配好一家服务商（接口地址、密钥、模型 id
              三样都要齐），再回来跑生成层。
            </AlertDescription>
          </Alert>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              只跑前几题
            </span>
            <Input
              type="number"
              min={0}
              value={limit}
              onChange={(event) => setLimit(event.target.value)}
              disabled={running}
            />
            <span className="text-[11px] text-muted-foreground">
              填 0 表示全部题目。第一次试跑建议填 3-5 题。
            </span>
          </label>
          <div className="flex items-end">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={judgeCheck}
                disabled={running}
                onCheckedChange={(value) => setJudgeCheck(value === true)}
              />
              <span>顺便做 judge 自检</span>
            </label>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={running || !datasetId || profiles.length === 0}
            onClick={() => void start()}
          >
            {running ? (
              <Loader2 className="mr-1 size-4 animate-spin" />
            ) : (
              <Play className="mr-1 size-4" />
            )}
            {running ? "跑着呢" : "开始跑"}
          </Button>
          {questionCount > 0 && (
            <span className="text-xs text-muted-foreground">
              {questionCount} 道题 · 大概 {calls} 次模型请求
            </span>
          )}
        </div>

        {job && (
          <div className="flex flex-col gap-2 rounded-lg border bg-card px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={job.status === "done" ? "default" : job.status === "error" ? "destructive" : "secondary"}>
                {job.status === "running"
                  ? "跑着呢"
                  : job.status === "done"
                    ? "跑完了"
                    : "出错了"}
              </Badge>
              <span className="font-mono text-[11px] text-muted-foreground">
                {job.id}
              </span>
            </div>
            {job.log.length > 0 && (
              <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md bg-secondary px-3 py-2 font-mono text-[11px] leading-relaxed">
                {job.log.join("\n")}
              </pre>
            )}
            {job.status === "done" && (
              <p className="text-xs text-muted-foreground">
                结果已经送到下面的结果区，和公开站是同一套图表。
              </p>
            )}
          </div>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertTitle>出错了</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {questionCount > 0 && (
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
            <span>
              生成层每道题都要调模型（被测一次、judge 再打一次分），
              跑一次是真花钱。先用「只跑前几题」试通链路，再放开跑全量。
            </span>
          </p>
        )}
      </CardContent>

      <DirPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        initialPath={repoRoot || health?.defaultRepoRoot || ""}
        onPick={(path) => setRepoRoot(path)}
      />
    </Card>
  );
}
