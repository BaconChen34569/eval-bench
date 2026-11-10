/**
 * 生成层评测任务。
 *
 * 生成层要真的调模型：一份题集 × 几种策略，一轮就是几百次请求，
 * HTTP 请求等不起。所以这里做成「起一个任务，页面轮询状态」：
 * 任务在后台跑，日志实时回传，跑完把完整报告交出去。
 *
 * 跑的是命令行那套代码（runEvaluation / runLadder / runComparison），
 * 所以工作台里跑出来的数字和命令行跑出来的完全一致。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runEvaluation } from "./runner.ts";
import { runRetrievalEval } from "./retrieval-eval.ts";
import { validateJudge } from "./judge-validation.ts";
import { LADDER, runLadder } from "./ladder.ts";
import { runComparison } from "./compare.ts";
import { readyProfiles, resolveProfile, type ReadyProfile } from "./profiles.ts";
import { DEFAULT_RETRIEVAL, STRATEGY_LIST } from "./strategies.ts";
import { CODE_VERSION, type EvalDataset, type EvalRun, type ExperimentReport, type JudgeValidation } from "./schema.ts";

export type GenMode = "single" | "ladder" | "compare";

export interface GenJobOptions {
  mode: GenMode;
  dataset: EvalDataset;
  repoRoot: string;
  /** 被测模型档案 id，不给就用 .env 里第一个配全的 */
  agentProfile?: string;
  /** 打分模型档案 id，不给就用被测模型自己打分 */
  judgeProfile?: string;
  /** 多模型对比的被测档案，至少两个 */
  agentProfiles?: string[];
  /** 多把尺子，第一个是主尺子 */
  judgeProfiles?: string[];
  /** 只跑前 N 题 */
  limit?: number;
  /** 顺便做 judge 自检 */
  judgeCheck?: boolean;
  /** 多模型对比用阶梯的哪一轮配置 */
  stepId?: string;
}

export interface GenJob {
  id: string;
  mode: GenMode;
  status: "running" | "done" | "error";
  /** 进度日志，页面直接显示 */
  log: string[];
  /** 结构化进度，页面画进度条用 */
  progress: GenProgress;
  report?: ExperimentReport;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

/**
 * 任务的进度。
 *
 * 页面要回答三个问题：现在跑到哪儿了、还要多久、跑完是什么结果。
 * 所以这里给的不只是日志行，还有能算百分比的细账。
 */
export interface GenProgress {
  /** 当前在做什么，比如「生成层评测 · 固定窗口 800 字符」 */
  stage: string;
  /** 当前阶段已经做完几题 */
  stageDone: number;
  /** 当前阶段一共几题 */
  stageTotal: number;
  /** 全局完成百分比 0-100 */
  percent: number;
  /** 全局已完成的工作量（按题算） */
  done: number;
  /** 全局总工作量（按题算） */
  total: number;
  /** 已经发出的模型请求数（估算） */
  calls: number;
  /** 预计一共要发多少模型请求 */
  callsEstimate: number;
}

const jobs = new Map<string, GenJob>();

/** 空 judge 自检：没跑的时候也要有个说得清的说明。 */
const NO_JUDGE_CHECK: JudgeValidation = {
  sampled: 0,
  agreement: 0,
  meanJudgeScore: 0,
  meanHumanScore: 0,
  exactAgreement: 0,
  note: "这次没有做 judge 自检",
};

/** 正在跑的任务，用来挡住重复提交——每跑一次都是真花钱。 */
export function runningJob(): GenJob | undefined {
  for (const job of jobs.values()) {
    if (job.status === "running") return job;
  }
  return undefined;
}

export function getJob(id: string): GenJob | undefined {
  return jobs.get(id);
}

/**
 * 一次跑动的阶段计划。
 *
 * 每个阶段说清楚：这一段做多少题、每题大概发几次模型请求。
 * 有了计划才能算出百分比——只知道「跑着」是没法让人安心的。
 */
interface StagePlan {
  key: string;
  label: string;
  /** 这一阶段一共多少题 */
  total: number;
  /** 每题要发几次模型请求（作答一次、judge 一次，就是 2） */
  callsPerQuestion: number;
}

/**
 * 进度账。
 *
 * 把各阶段的完成情况合成一个百分比，再带上当前阶段的细账，
 * 页面就能显示「跑到第几步、第几题、还剩多少」。
 */
class ProgressTracker {
  private readonly plan: StagePlan[];
  private index = 0;
  private done = 0;
  private calls = 0;

  constructor(plan: StagePlan[]) {
    this.plan = plan;
  }

  /** 切到某个阶段。 */
  enter(key: string, label?: string): void {
    const found = this.plan.findIndex((item) => item.key === key);
    if (found < 0) return;
    if (found === this.index) {
      if (label) this.plan[found].label = label;
      return;
    }
    this.index = found;
    this.done = 0;
    if (label) this.plan[found].label = label;
  }

  /** 当前阶段完成了 absDone 题（绝对值，不是增量）。 */
  advanceTo(absDone: number, callsPerQuestion: number): void {
    const stage = this.plan[this.index];
    if (!stage) return;
    const delta = Math.max(0, absDone - this.done);
    this.done = Math.min(stage.total, absDone);
    this.calls += delta * callsPerQuestion;
  }

  snapshot(): GenProgress {
    const stage = this.plan[this.index];
    const total = this.plan.reduce((sum, item) => sum + item.total, 0);
    let completed = 0;
    for (let i = 0; i < this.index; i += 1) completed += this.plan[i].total;
    completed += this.done;
    const callsEstimate = this.plan.reduce(
      (sum, item) => sum + item.total * item.callsPerQuestion,
      0,
    );
    return {
      stage: stage?.label ?? "收尾",
      stageDone: this.done,
      stageTotal: stage?.total ?? 0,
      percent:
        total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0,
      done: completed,
      total,
      calls: this.calls,
      callsEstimate,
    };
  }
}

function pickProfiles(
  env: Record<string, string | undefined>,
  ids: string[],
): ReadyProfile[] {
  return ids.map((id) => resolveProfile(env, id));
}

/** 这次实际要跑多少题：只跑前 N 题时就是 N。 */
function questionCount(options: GenJobOptions): number {
  const all = options.dataset.questions.length;
  if (!options.limit || options.limit <= 0) return all;
  return Math.min(options.limit, all);
}

/** judge 自检会抽多少题：只有带人工评分的题才参与。 */
function judgeCount(options: GenJobOptions): number {
  return options.dataset.questions.filter(
    (question) => question.humanScore !== undefined,
  ).length;
}

/** 读产物目录里的 report.json，拿它已有的运行记录去复用。 */
async function reusableRuns(outDir: string): Promise<EvalRun[]> {
  try {
    const report = JSON.parse(
      await readFile(join(outDir, "report.json"), "utf8"),
    ) as ExperimentReport;
    return [...(report.runs ?? []), ...(report.ladderRuns ?? [])];
  } catch {
    // 没有旧报告就没得复用，不是错误
    return [];
  }
}

/**
 * 把生成层的数字回填到检索层指标里。
 *
 * 检索层只算召回，成功率得从生成层的运行记录里来；
 * 不回填的话站点上的策略总览就只剩召回，成功率那一列是空的。
 */
function fillGeneration(
  metrics: Awaited<ReturnType<typeof runRetrievalEval>>,
  runs: EvalRun[],
): void {
  for (const run of runs) {
    const found = metrics.find((item) => item.strategy.id === run.chunking.id);
    if (!found) continue;
    found.successRate = run.summary.successRate;
    found.avgJudgeScore = run.summary.avgJudgeScore;
    found.avgLatencyMs = run.summary.avgLatencyMs;
    found.p95LatencyMs = run.summary.p95LatencyMs;
    found.avgCost = run.summary.avgCost;
    found.totalCost = run.summary.totalCost;
    found.totalTokens = run.summary.totalTokens;
  }
}

async function runSingle(
  job: GenJob,
  options: GenJobOptions,
  env: Record<string, string | undefined>,
): Promise<ExperimentReport> {
  const agent = resolveProfile(env, options.agentProfile);
  const judge = options.judgeProfile
    ? resolveProfile(env, options.judgeProfile)
    : agent;
  const questions = questionCount(options);
  const judged = judgeCount(options);

  const tracker = new ProgressTracker([
    { key: "retrieval", label: "检索层评测", total: 1, callsPerQuestion: 0 },
    ...(options.judgeCheck
      ? [
          {
            key: "judge",
            label: "judge 自检（先验尺子）",
            total: judged,
            callsPerQuestion: 1,
          },
        ]
      : []),
    ...STRATEGY_LIST.map((strategy) => ({
      key: `strategy:${strategy.id}`,
      label: `生成层评测 · ${strategy.label}`,
      total: questions,
      callsPerQuestion: 2,
    })),
  ]);
  const sync = () => {
    job.progress = tracker.snapshot();
  };

  job.log.push(
    `被测模型 ${agent.label}（${agent.config.model}），打分模型 ${judge.label}（${judge.config.model}）`,
  );

  tracker.enter("retrieval");
  sync();
  job.log.push("检索层评测（不调模型，不花钱）…");
  const metrics = await runRetrievalEval({
    dataset: options.dataset,
    repoRoot: options.repoRoot,
    strategies: STRATEGY_LIST,
    retrieval: DEFAULT_RETRIEVAL,
  });
  for (const item of metrics) {
    job.log.push(
      `  ${item.strategy.id.padEnd(15)} recall@6 ${(item.recallAt6 * 100).toFixed(1)}%`,
    );
  }
  tracker.advanceTo(1, 0);
  sync();

  let judgeValidation = NO_JUDGE_CHECK;
  if (options.judgeCheck) {
    tracker.enter("judge");
    sync();
    job.log.push("judge 自检：让 judge 给人工参考答案打分…");
    const validation = await validateJudge(options.dataset, judge.config, {
      onProgress: (done, total) => {
        tracker.advanceTo(done, 1);
        sync();
        job.log.push(`  judge 自检 (${done}/${total})`);
      },
    });
    judgeValidation = validation.summary;
    job.log.push(
      `  一致率 ${(judgeValidation.agreement * 100).toFixed(1)}%（${judgeValidation.sampled} 题）`,
    );
  }

  const runs: EvalRun[] = [];
  for (const strategy of STRATEGY_LIST) {
    tracker.enter(`strategy:${strategy.id}`);
    sync();
    job.log.push(`生成层评测：${strategy.label}…`);
    const run = await runEvaluation({
      dataset: options.dataset,
      repoRoot: options.repoRoot,
      chunking: strategy,
      retrieval: DEFAULT_RETRIEVAL,
      llm: agent.config,
      judgeLlm: judge.config,
      successThreshold: 4,
      runId: `${strategy.id}-${Date.now()}`,
      limit: options.limit,
      profile: agent.id,
      profileLabel: agent.label,
      onProgress: (done, total, message) => {
        tracker.advanceTo(done, 2);
        sync();
        job.log.push(`  (${done}/${total}) ${message}`);
      },
    });
    run.origin = "strategy-compare";
    runs.push(run);
    job.log.push(
      `  ${strategy.label} 成功率 ${(run.summary.successRate * 100).toFixed(1)}%`,
    );
  }
  fillGeneration(metrics, runs);

  return {
    datasetId: options.dataset.id,
    repo: options.dataset.repo,
    costCurrency: agent.config.currency ?? "¥",
    judgeValidation,
    strategies: metrics,
    runs,
    ladderRuns: [],
    ladder: [],
  };
}

async function runLadderJob(
  job: GenJob,
  options: GenJobOptions,
  env: Record<string, string | undefined>,
  outDir: string,
): Promise<ExperimentReport> {
  const agent = resolveProfile(env, options.agentProfile);
  const judge = options.judgeProfile
    ? resolveProfile(env, options.judgeProfile)
    : agent;
  const questions = questionCount(options);
  const judged = judgeCount(options);

  const tracker = new ProgressTracker([
    ...(options.judgeCheck
      ? [
          {
            key: "judge",
            label: "judge 自检（先验尺子）",
            total: judged,
            callsPerQuestion: 1,
          },
        ]
      : []),
    ...LADDER.map((step) => ({
      key: `step:${step.id}`,
      label: `迭代阶梯 · ${step.id} ${step.title}`,
      total: questions,
      callsPerQuestion: 2,
    })),
    { key: "retrieval", label: "检索层评测", total: 1, callsPerQuestion: 0 },
  ]);
  const sync = () => {
    job.progress = tracker.snapshot();
  };

  job.log.push(
    `被测模型 ${agent.label}（${agent.config.model}），打分模型 ${judge.label}（${judge.config.model}）`,
  );

  let judgeValidation = NO_JUDGE_CHECK;
  if (options.judgeCheck) {
    tracker.enter("judge");
    sync();
    job.log.push("judge 自检：让 judge 给人工参考答案打分…");
    const validation = await validateJudge(options.dataset, judge.config, {
      onProgress: (done, total) => {
        tracker.advanceTo(done, 1);
        sync();
        job.log.push(`  judge 自检 (${done}/${total})`);
      },
    });
    judgeValidation = validation.summary;
  }

  // 一上手就报出第一轮的名字，别让用户对着「准备中」干等。
  tracker.enter(`step:${LADDER[0].id}`);
  sync();

  const reuse = await reusableRuns(outDir);
  if (reuse.length) {
    job.log.push(`复用 ${reuse.length} 条已有运行记录（配置一致的轮次不再重跑）`);
  }

  job.log.push(`迭代阶梯：${options.dataset.questions.length} 题 × ${LADDER.length} 轮`);
  const { steps, runs } = await runLadder({
    dataset: options.dataset,
    repoRoot: options.repoRoot,
    llm: agent.config,
    judgeLlm: judge.config,
    successThreshold: 4,
    reuseRuns: reuse,
    limit: options.limit,
    onProgress: (step, done, total, message) =>
      job.log.push(`  ${step.id} (${done}/${total}) ${message}`),
    onQuestionProgress: (progress) => {
      tracker.enter(
        `step:${progress.step.id}`,
        `迭代阶梯 · ${progress.step.id} ${progress.step.title}`,
      );
      tracker.advanceTo(progress.done, progress.reused ? 0 : 2);
      sync();
    },
  });
  for (const step of steps) {
    job.log.push(
      `  ${step.id} 成功率 ${(step.summary.successRate * 100).toFixed(1)}%  成本 ¥${step.summary.totalCost.toFixed(4)}`,
    );
  }

  tracker.enter("retrieval");
  sync();
  job.log.push("检索层评测（不调模型，不花钱）…");
  const metrics = await runRetrievalEval({
    dataset: options.dataset,
    repoRoot: options.repoRoot,
    strategies: STRATEGY_LIST,
    retrieval: DEFAULT_RETRIEVAL,
  });
  tracker.advanceTo(1, 0);
  sync();

  return {
    datasetId: options.dataset.id,
    repo: options.dataset.repo,
    costCurrency: agent.config.currency ?? "¥",
    judgeValidation,
    strategies: metrics,
    runs: [],
    ladderRuns: runs,
    ladder: steps,
  };
}

async function runCompareJob(
  job: GenJob,
  options: GenJobOptions,
  env: Record<string, string | undefined>,
  outDir: string,
): Promise<ExperimentReport> {
  const agentIds = options.agentProfiles ?? [];
  const judgeIds = options.judgeProfiles ?? [];
  if (agentIds.length < 2) {
    throw new Error("多模型对比至少要选两个被测模型");
  }
  if (judgeIds.length < 1) {
    throw new Error("至少要选一把尺子");
  }

  const agents = pickProfiles(env, agentIds);
  const judges = pickProfiles(env, judgeIds);
  const step =
    LADDER.find((item) => item.id === options.stepId) ?? LADDER[LADDER.length - 1];
  const questions = questionCount(options);

  const tracker = new ProgressTracker([
    ...agents.flatMap((agent) => [
      {
        key: `agent:${agent.id}`,
        label: `生成层评测 · ${agent.label}`,
        total: questions,
        callsPerQuestion: 2,
      },
      ...judges.slice(1).map((judge) => ({
        key: `agent:${agent.id}:judge:${judge.id}`,
        label: `换尺子重打 · ${agent.label} × ${judge.label}`,
        total: questions,
        callsPerQuestion: 1,
      })),
    ]),
    { key: "retrieval", label: "检索层评测", total: 1, callsPerQuestion: 0 },
  ]);
  const sync = () => {
    job.progress = tracker.snapshot();
  };
  sync();

  job.log.push(
    `配置：${step.chunking.label}，top-${step.retrieval.topK}，提示词 ${step.promptVersion}`,
  );
  job.log.push(
    `被测 ${agents.map((item) => item.label).join(" / ")}，尺子 ${judges.map((item) => item.label).join(" / ")}`,
  );

  const reuse = await reusableRuns(outDir);
  const comparison = await runComparison({
    dataset: options.dataset,
    repoRoot: options.repoRoot,
    agents,
    judges,
    chunking: step.chunking,
    retrieval: step.retrieval,
    promptVersion: step.promptVersion,
    successThreshold: 4,
    reuseRuns: reuse,
    limit: options.limit,
    onProgress: (message) => job.log.push(`  ${message}`),
    onQuestionProgress: (info) => {
      tracker.enter(
        info.judge
          ? `agent:${info.agent.id}:judge:${info.judge.id}`
          : `agent:${info.agent.id}`,
      );
      tracker.advanceTo(info.done, info.reused ? 0 : info.judge ? 1 : 2);
      sync();
    },
  });

  tracker.enter("retrieval");
  sync();
  job.log.push("检索层评测（不调模型，不花钱）…");
  const metrics = await runRetrievalEval({
    dataset: options.dataset,
    repoRoot: options.repoRoot,
    strategies: STRATEGY_LIST,
    retrieval: DEFAULT_RETRIEVAL,
  });

  return {
    datasetId: options.dataset.id,
    repo: options.dataset.repo,
    costCurrency: agents[0].config.currency ?? "¥",
    judgeValidation: NO_JUDGE_CHECK,
    strategies: metrics,
    runs: [],
    ladderRuns: [],
    ladder: [],
    modelComparison: comparison,
  };
}

/**
 * 起一个生成层任务。
 *
 * 任务在后台跑，页面轮询 /api/gen/job 看进度。
 * 结果会写到产物目录里一份带时间戳的副本，不覆盖命令行跑出来的 report.json。
 */
export function startGenJob(
  options: GenJobOptions,
  env: Record<string, string | undefined>,
  outDir: string,
): GenJob {
  const existing = runningJob();
  if (existing) {
    throw new Error("还有一个生成层任务在跑，等它跑完再开始下一个");
  }

  const job: GenJob = {
    id: `gen-${Date.now()}`,
    mode: options.mode,
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
    startedAt: new Date().toISOString(),
  };
  jobs.set(job.id, job);

  const runner = async (): Promise<void> => {
    try {
      const report =
        options.mode === "ladder"
          ? await runLadderJob(job, options, env, outDir)
          : options.mode === "compare"
            ? await runCompareJob(job, options, env, outDir)
            : await runSingle(job, options, env);

      job.report = report;
      job.status = "done";
      job.progress = { ...job.progress, percent: 100, stage: "已完成" };
      job.log.push("跑完了。");

      // 存一份带时间戳的副本：命令行那份 report.json 不动。
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const file = join(outDir, `workbench-${options.mode}-${stamp}.json`);
      await mkdir(outDir, { recursive: true });
      await writeFile(file, JSON.stringify(report, null, 2), "utf8");
      job.log.push(`结果已保存到 ${file}`);
    } catch (error) {
      job.status = "error";
      job.error = error instanceof Error ? error.message : String(error);
      job.progress = { ...job.progress, stage: "出错了" };
      job.log.push(`出错：${job.error}`);
    } finally {
      job.finishedAt = new Date().toISOString();
    }
  };

  void runner();
  return job;
}

/** 页面上要显示的可选档案和阶梯轮次。 */
export function genOptions(env: Record<string, string | undefined>) {
  const ready = readyProfiles(env);
  const all = [...ready];
  return {
    profiles: all.map((profile) => ({
      id: profile.id,
      label: profile.label,
      model: profile.model,
      price: profile.price,
      priceSource: profile.priceSource,
    })),
    ladder: LADDER.map((step) => ({
      id: step.id,
      title: step.title,
      chunking: step.chunking.label,
      topK: step.retrieval.topK,
      promptVersion: step.promptVersion,
    })),
    codeVersion: CODE_VERSION,
  };
}
