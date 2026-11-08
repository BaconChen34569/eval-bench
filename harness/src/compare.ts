import { runEvaluation } from "./runner.ts";
import { rejudgeRun } from "./rejudge.ts";
import { estimateCost, type LlmConfig } from "./llm.ts";
import {
  CODE_VERSION,
  type ChunkingStrategy,
  type EvalDataset,
  type EvalRun,
  type JudgeAgreement,
  type JudgePairAgreement,
  type ModelComparison,
  type ModelComparisonRow,
  type ModelJudgeCell,
  type PromptVersion,
  type RetrievalConfig,
  type SelfPreference,
} from "./schema.ts";
import type { ReadyProfile } from "./profiles.ts";

/**
 * 多模型对比：同一份配置，换被测模型，再用好几把尺子各量一遍。
 *
 * 回答两个问题：
 * 1. 这套评测台能不能区分出模型的好坏——同一批题、同一套检索、同一把尺子，
 *    排名才有意义。
 * 2. 换一把尺子会不会翻盘——尺子本身也是模型，它也可能偏。
 *    所以每个答案都被所有尺子量一遍，一致率和自评偏袒都能算出来。
 *
 * 主尺子（judges[0]）量所有被测模型；其余尺子对同一批答案重新打分，
 * 答案一个字都不动，只有打分的人换人。
 */

export interface CompareOptions {
  dataset: EvalDataset;
  repoRoot: string;
  /** 被测模型档案 */
  agents: ReadyProfile[];
  /** 打分模型档案，第一个是主尺子 */
  judges: ReadyProfile[];
  chunking: ChunkingStrategy;
  retrieval: RetrievalConfig;
  promptVersion: PromptVersion;
  successThreshold: number;
  /** 可复用的运行记录，比如阶梯最后一轮 */
  reuseRuns?: EvalRun[];
  limit?: number;
  onProgress?: (message: string) => void;
}

/**
 * 一条旧记录能不能当这一格的底。
 *
 * 配置、被测模型、打分模型都得对上，代码版本也得一样：
 * 切分或检索实现改过之后，同一个配置跑出来的已经是另一份结果了。
 */
function reusable(
  run: EvalRun,
  agent: ReadyProfile,
  judge: ReadyProfile,
  expectedCases: number,
  chunking: ChunkingStrategy,
  retrieval: RetrievalConfig,
  promptVersion: PromptVersion,
): boolean {
  return (
    run.codeVersion === CODE_VERSION &&
    run.cases.length === expectedCases &&
    run.chunking.id === chunking.id &&
    run.retrieval.topK === retrieval.topK &&
    (run.retrieval.rerankMode ?? "none") ===
      (retrieval.rerankMode ?? "none") &&
    (run.retrieval.queryExpansion ?? false) ===
      (retrieval.queryExpansion ?? false) &&
    (run.promptVersion ?? "base") === promptVersion &&
    run.model === agent.config.model &&
    (run.judgeModel ?? run.model) === judge.config.model
  );
}

/** agent 那一次生成花了多少：按被测模型自己的单价算。 */
function agentCostOf(run: EvalRun, config: LlmConfig): number {
  return run.cases.reduce(
    (sum, item) =>
      sum +
      estimateCost(
        {
          prompt: item.tokens.prompt,
          completion: item.tokens.completion,
          cacheHit: item.tokens.cacheHit,
          cacheMiss: item.tokens.cacheMiss,
        },
        config.pricePerMillion,
      ),
    0,
  );
}

/** 这一轮打分花了多少：按这把尺子自己的单价算。 */
function judgeCostOf(run: EvalRun, config: LlmConfig): number {
  return run.cases.reduce(
    (sum, item) =>
      sum +
      estimateCost(
        {
          prompt: item.tokens.judgePrompt,
          completion: item.tokens.judgeCompletion,
          cacheHit: 0,
          cacheMiss: 0,
        },
        config.pricePerMillion,
      ),
    0,
  );
}

function tokenTotal(run: EvalRun, part: "agent" | "judge"): number {
  return run.cases.reduce((sum, item) => {
    if (part === "agent") {
      return sum + item.tokens.prompt + item.tokens.completion;
    }
    return sum + item.tokens.judgePrompt + item.tokens.judgeCompletion;
  }, 0);
}

/**
 * 两把尺子在同一批答案上差多少。
 *
 * 差 1 分以内算「一致」——judge 打分本身就有主观性，
 * 拿完全同分当一致会苛刻到没有意义。
 */
function compareJudges(
  rows: ModelComparisonRow[],
  judgeA: string,
  judgeB: string,
  threshold: number,
): {
  sampled: number;
  agreement: number;
  exactAgreement: number;
  flips: number;
  judgeASuccessRate: number;
  judgeBSuccessRate: number;
} {
  let sampled = 0;
  let agree = 0;
  let exact = 0;
  let flips = 0;
  let successA = 0;
  let successB = 0;

  for (const row of rows) {
    for (const item of row.caseScores) {
      const a = item.scores[judgeA];
      const b = item.scores[judgeB];
      if (a === undefined || b === undefined) continue;
      sampled += 1;
      if (Math.abs(a - b) <= 1) agree += 1;
      if (a === b) exact += 1;
      const success = a >= threshold;
      const other = b >= threshold;
      if (success !== other) flips += 1;
      if (success) successA += 1;
      if (other) successB += 1;
    }
  }

  const total = sampled || 1;
  return {
    sampled,
    agreement: agree / total,
    exactAgreement: exact / total,
    flips,
    judgeASuccessRate: successA / total,
    judgeBSuccessRate: successB / total,
  };
}

export async function runComparison(
  options: CompareOptions,
): Promise<ModelComparison> {
  const {
    dataset,
    repoRoot,
    agents,
    judges,
    chunking,
    retrieval,
    promptVersion,
    successThreshold,
  } = options;

  if (judges.length === 0) throw new Error("至少要有一把尺子");
  const primary = judges[0];
  const expectedCases = options.limit ?? dataset.questions.length;
  const rows: ModelComparisonRow[] = [];

  for (const agent of agents) {
    options.onProgress?.(`【${agent.label}】开始`);

    const reused = options.reuseRuns?.find((run) =>
      reusable(
        run,
        agent,
        primary,
        expectedCases,
        chunking,
        retrieval,
        promptVersion,
      ),
    );

    let baseRun: EvalRun;
    if (reused) {
      baseRun = reused;
      options.onProgress?.(
        `【${agent.label}】复用已有运行 ${baseRun.runId}（主尺子 ${primary.config.model}）`,
      );
    } else {
      baseRun = await runEvaluation({
        dataset,
        repoRoot,
        chunking,
        retrieval,
        llm: agent.config,
        judgeLlm: primary.config,
        successThreshold,
        runId: `compare-${agent.id}-${Date.now()}`,
        promptVersion,
        limit: options.limit,
        profile: agent.id,
        profileLabel: agent.label,
        onProgress: (done, total, message) =>
          options.onProgress?.(`【${agent.label}】(${done}/${total}) ${message}`),
      });
    }

    // 其余尺子对同一批答案重新打分：答案不动，只有打分的人换人。
    const judgeRuns = new Map<string, EvalRun>();
    judgeRuns.set(primary.id, baseRun);
    for (const judge of judges.slice(1)) {
      const rejudged = await rejudgeRun({
        run: baseRun,
        dataset,
        repoRoot,
        agentLlm: agent.config,
        judgeLlm: judge.config,
        successThreshold,
        onProgress: (done, total, message) =>
          options.onProgress?.(
            `【${agent.label} × ${judge.label}】(${done}/${total}) ${message}`,
          ),
      });
      judgeRuns.set(judge.id, rejudged);
    }

    const cells: ModelJudgeCell[] = [];
    let judgeCost = 0;
    let judgeTokens = 0;
    for (const judge of judges) {
      const run = judgeRuns.get(judge.id)!;
      const cost = judgeCostOf(run, judge.config);
      judgeCost += cost;
      judgeTokens += tokenTotal(run, "judge");
      cells.push({
        judgeModel: judge.config.model,
        judgeProfile: judge.id,
        judgeProfileLabel: judge.label,
        successRate: run.summary.successRate,
        avgJudgeScore: run.summary.avgJudgeScore,
        totalCost: cost,
      });
    }

    const caseScores = baseRun.cases.map((item) => {
      const scores: Record<string, number> = {};
      for (const judge of judges) {
        const run = judgeRuns.get(judge.id)!;
        const found = run.cases.find(
          (entry) => entry.questionId === item.questionId,
        );
        scores[judge.config.model] = found?.judgeScore ?? item.judgeScore;
      }
      return { questionId: item.questionId, scores };
    });

    const failureKinds: Record<string, number> = {};
    for (const item of baseRun.cases) {
      if (!item.failureKind) continue;
      failureKinds[item.failureKind] =
        (failureKinds[item.failureKind] ?? 0) + 1;
    }

    const agentCost = agentCostOf(baseRun, agent.config);

    rows.push({
      agentModel: agent.config.model,
      agentProfile: agent.id,
      agentProfileLabel: agent.label,
      runId: baseRun.runId,
      reused: Boolean(reused),
      cells,
      avgSuccessRate:
        cells.reduce((sum, cell) => sum + cell.successRate, 0) /
        (cells.length || 1),
      avgJudgeScore:
        cells.reduce((sum, cell) => sum + cell.avgJudgeScore, 0) /
        (cells.length || 1),
      avgEvidenceRecall: baseRun.summary.avgEvidenceRecall,
      avgLatencyMs: baseRun.summary.avgLatencyMs,
      p95LatencyMs: baseRun.summary.p95LatencyMs,
      agentCost,
      judgeCost,
      totalCost: agentCost + judgeCost,
      totalTokens: tokenTotal(baseRun, "agent") + judgeTokens,
      failureKinds,
      caseScores,
    });
  }

  // 每个被测模型：主尺子与其余尺子两两一致。
  const agreements: JudgeAgreement[] = [];
  for (const row of rows) {
    for (const [index, judgeA] of judges.entries()) {
      for (const judgeB of judges.slice(index + 1)) {
        const stats = compareJudges(
          [row],
          judgeA.config.model,
          judgeB.config.model,
          successThreshold,
        );
        agreements.push({
          agentModel: row.agentModel,
          judgeA: judgeA.config.model,
          judgeB: judgeB.config.model,
          ...stats,
        });
      }
    }
  }

  // 全部答案汇总起来，两把尺子整体有多一致。
  const agreementMatrix: JudgePairAgreement[] = [];
  for (const [index, judgeA] of judges.entries()) {
    for (const judgeB of judges.slice(index + 1)) {
      const stats = compareJudges(
        rows,
        judgeA.config.model,
        judgeB.config.model,
        successThreshold,
      );
      agreementMatrix.push({
        judgeA: judgeA.config.model,
        judgeB: judgeB.config.model,
        sampled: stats.sampled,
        agreement: stats.agreement,
        exactAgreement: stats.exactAgreement,
        flips: stats.flips,
        judgeASuccessRate: stats.judgeASuccessRate,
        judgeBSuccessRate: stats.judgeBSuccessRate,
      });
    }
  }

  // 自评偏袒：一把尺子给本家模型打的分，比给别家的平均高多少。
  const selfPreference: SelfPreference[] = [];
  for (const judge of judges) {
    const own = rows.find((row) => row.agentProfile === judge.id);
    if (!own) continue;
    const ownCell = own.cells.find(
      (cell) => cell.judgeProfile === judge.id,
    );
    const ownScore = ownCell?.avgJudgeScore ?? 0;
    const others = rows
      .filter((row) => row !== own)
      .map(
        (row) =>
          row.cells.find((cell) => cell.judgeProfile === judge.id)
            ?.avgJudgeScore ?? 0,
      );
    const otherAvg =
      others.reduce((sum, score) => sum + score, 0) / (others.length || 1);
    const allScores = rows.map(
      (row) =>
        row.cells.find((cell) => cell.judgeProfile === judge.id)
          ?.avgJudgeScore ?? 0,
    );
    selfPreference.push({
      judgeModel: judge.config.model,
      judgeProfile: judge.id,
      judgeProfileLabel: judge.label,
      ownModel: own.agentModel,
      ownAvgScore: ownScore,
      otherAvgScore: otherAvg,
      gap: ownScore - otherAvg,
      ownRank:
        1 + allScores.filter((score) => score > ownScore).length,
    });
  }

  return {
    chunking,
    retrieval,
    promptVersion,
    successThreshold,
    judges: judges.map((judge) => ({
      model: judge.config.model,
      profile: judge.id,
      label: judge.label,
    })),
    primaryJudge: primary.config.model,
    rows,
    agreements,
    agreementMatrix,
    selfPreference,
    note:
      `所有被测模型跑同一份配置（${chunking.label}，top-${retrieval.topK}，` +
      `${retrieval.rerankMode ?? "none"}${retrieval.queryExpansion ? "，中英术语扩展" : ""}，` +
      `提示词 ${promptVersion}），主尺子 ${primary.label}（${primary.config.model}）量所有模型；` +
      `其余尺子对同一批答案重新打分，答案未改动。`,
  };
}
