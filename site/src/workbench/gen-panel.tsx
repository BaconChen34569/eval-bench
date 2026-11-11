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
import { Progress } from "@/components/ui/progress";

import type { ExperimentReport } from "@/data/report";
import {
  api,
  type GenJob,
  type GenMode,
  type GenOptions,
  type Health,
  type WorkDataset,
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
 * 等的时候该说的话。
 *
 * 生成层一跑就是几分钟，页面光转圈不给信息，人是坐不住的。
 * 这些话把「为什么要这么久」「现在能不能走开」讲清楚。
 */
const WAIT_TIPS = [
  "每一道题都要被测模型答一次、judge 再打一次分，所以慢是正常的——这就是评测台在干的事。",
  "可以把这个页面最小化：任务跑在本地服务里，关掉页面它也照跑，回来刷新就能接着看进度。",
  "预算按「模型请求次数」估：一道题 = 被测一次 + 打分一次。跑完这里会写明实际发了多少次。",
  "如果卡在第一题别急着停——第一次请求要等模型冷启动，通常比后面的慢得多。",
  "跑出来的数字会和命令行 experiment / ladder / compare 完全一致，可以直接对照着看。",
];

/** 把毫秒写成「3 分 12 秒」这样的大白话。 */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest > 0 ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

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
  const [datasetDetail, setDatasetDetail] = useState<WorkDataset | null>(null);
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
  const [clock, setClock] = useState(() => Date.now());
  const appliedRef = useRef<string | null>(null);
  const logRef = useRef<HTMLPreElement | null>(null);

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

  // 题集明细：算 judge 自检要抽几题，得知道哪几题带人工评分。
  useEffect(() => {
    if (!datasetId) {
      setDatasetDetail(null);
      return;
    }
    let alive = true;
    void api
      .dataset(datasetId)
      .then((value) => {
        if (alive) setDatasetDetail(value);
      })
      .catch(() => {
        if (alive) setDatasetDetail(null);
      });
    return () => {
      alive = false;
    };
  }, [datasetId]);

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

  // 跑着的时候每秒走一下表，用来算「已经跑了多久」「大概还要多久」。
  useEffect(() => {
    if (!job || job.status !== "running") return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [job]);

  // 日志一直往下滚，用户不用手动拖。
  useEffect(() => {
    const node = logRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [job?.log.length]);

  // 刷新页面后接上还在跑的任务：进度不该因为刷新一次就丢掉。
  useEffect(() => {
    void api
      .genRunning()
      .then((current) => {
        if (!current || current.status !== "running") return;
        setJob(current);
        // 任务跑的是哪种跑法，表单就跟着显示哪种，别让人以为跑错了。
        setMode(current.mode);
      })
      .catch(() => {
        // 服务刚起的时候可能还没准备好，忽略即可
      });
  }, []);

  // 跑完就把报告送进结果区。同一份报告只送一次。
  useEffect(() => {
    if (!job || job.status !== "done" || !job.report) return;
    if (appliedRef.current === job.id) return;
    appliedRef.current = job.id;
    onReport(job.report);
  }, [job, onReport]);

  const running = job?.status === "running";
  const profiles = options?.profiles ?? [];

  const progress = job?.progress;
  const elapsedMs = job
    ? Math.max(
        0,
        (job.finishedAt ? new Date(job.finishedAt).getTime() : clock) -
          new Date(job.startedAt).getTime(),
      )
    : 0;
  // 剩余时间按「已完成部分的平均速度」外推，只是估算，够用户判断要不要等。
  const etaMs =
    running && progress && progress.done > 0 && progress.total > progress.done
      ? (elapsedMs / progress.done) * (progress.total - progress.done)
      : null;
  const tip = WAIT_TIPS[Math.floor(elapsedMs / 12000) % WAIT_TIPS.length];

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
        progress: {
          stage: "准备中",
          stageDone: 0,
          stageTotal: 0,
          percent: 0,
          done: 0,
          total: 0,
          calls: 0,
          callsEstimate: 0,
        },
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
  const limitCount = Number(limit) > 0 ? Math.min(Number(limit), questionCount) : questionCount;
  // judge 自检只在这次要跑的题里挑带人工评分的那些：自检和评测考的是同一批题，
  // 「只跑前几题」时不该再偷偷跑一遍全量自检。
  const judgeScope = datasetDetail
    ? limitCount > 0
      ? datasetDetail.questions.slice(0, limitCount)
      : datasetDetail.questions
    : [];
  const judgeCount = datasetDetail
    ? judgeScope.filter((question) => question.humanScore !== undefined).length
    : limitCount > 0
      ? 0
      : (dataset?.judgeQuestions ?? 0);
  const current = MODES.find((item) => item.id === mode);
  // 粗略估算这次要发多少次模型请求，好让用户知道大概要花多少钱。
  // 一道题 = 被测模型答一次 + judge 打一次分。
  const judgeCalls = judgeCheck && mode !== "compare" ? judgeCount : 0;
  const calls =
    mode === "single"
      ? limitCount * 3 * 2 + judgeCalls
      : mode === "ladder"
        ? limitCount * 7 * 2 + judgeCalls
        : limitCount * agentProfiles.length * 2 +
          limitCount * agentProfiles.length * Math.max(0, judgeProfiles.length - 1);

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
              {judgeCheck && mode !== "compare"
                ? `judge 自检也跟着缩到这 ${limitCount} 题里。`
                : ""}
            </span>
          </label>
          {mode === "compare" ? (
            <div className="flex items-end">
              <span className="text-[11px] text-muted-foreground">
                多模型对比本身就用两把尺子，不用另外做 judge 自检。
              </span>
            </div>
          ) : (
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
          )}
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
              {limitCount > 0 ? `${limitCount} 道题` : ""} · 大概 {calls} 次模型请求
              {judgeCalls > 0 ? ` · 含 judge 自检 ${judgeCount} 题` : ""}
            </span>
          )}
        </div>

        {job && (
          <div className="flex flex-col gap-3 rounded-lg border bg-card px-3 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant={
                  job.status === "done"
                    ? "default"
                    : job.status === "error"
                      ? "destructive"
                      : "secondary"
                }
              >
                {running ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : null}
                {job.status === "running"
                  ? "跑着呢"
                  : job.status === "done"
                    ? "跑完了"
                    : "出错了"}
              </Badge>
              <span className="font-mono text-[11px] text-muted-foreground">
                {job.id}
              </span>
              <span className="text-[11px] text-muted-foreground">
                已用 {formatDuration(elapsedMs)}
                {etaMs !== null ? ` · 预计还要 ${formatDuration(etaMs)}` : ""}
              </span>
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-xs font-medium">
                  {progress?.stage ?? "准备中"}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {progress && progress.stageTotal > 0
                    ? `第 ${progress.stageDone}/${progress.stageTotal} 题`
                    : ""}
                  {progress && progress.total > 0
                    ? ` · 全局 ${progress.done}/${progress.total}`
                    : ""}
                </span>
              </div>
              <Progress value={progress?.percent ?? 0} />
              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
                <span>
                  {progress?.percent ?? 0}% 完成
                  {progress && progress.callsEstimate > 0
                    ? ` · 已发出 ${progress.calls}/${progress.callsEstimate} 次模型请求`
                    : ""}
                </span>
                {running && <span>跑完自动出图</span>}
              </div>
            </div>

            {running && (
              <p className="rounded-md bg-secondary/60 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
                {tip}
              </p>
            )}

            {job.log.length > 0 && (
              <pre
                ref={logRef}
                className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md bg-secondary px-3 py-2 font-mono text-[11px] leading-relaxed"
              >
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
