import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chunkRepository } from "./chunk.ts";
import { loadRepository } from "./repository.ts";
import { buildIndex, search, toCitations, evidenceRecall } from "./retrieval.ts";
import { answerQuestion, parseAnswerCitations } from "./agent.ts";
import { classifyFailure, fileLineCounts } from "./failure.ts";
import { judgeAnswer } from "./judge.ts";
import { estimateCost, type LlmConfig } from "./llm.ts";
import {
  CODE_VERSION,
  type CaseResult,
  type ChunkingStrategy,
  type EvalDataset,
  type EvalRun,
  type ExperimentReport,
  type PromptVersion,
  type RetrievalConfig,
  type RunSummary,
} from "./schema.ts";

export interface RunOptions {
  dataset: EvalDataset;
  repoRoot: string;
  chunking: ChunkingStrategy;
  retrieval: RetrievalConfig;
  llm: LlmConfig;
  successThreshold: number;
  runId: string;
  /** agent 提示词版本，横切分策略对比时固定为 base */
  promptVersion?: PromptVersion;
  /** 只跑前 N 题，用于快速验证链路 */
  limit?: number;
  onProgress?: (done: number, total: number, message: string) => void;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index];
}

export async function runEvaluation(options: RunOptions): Promise<EvalRun> {
  const {
    dataset,
    repoRoot,
    chunking,
    retrieval,
    llm,
    successThreshold,
    runId,
  } = options;
  const promptVersion: PromptVersion = options.promptVersion ?? "base";

  const startedAt = new Date().toISOString();
  const files = await loadRepository(repoRoot);
  const lineCounts = fileLineCounts(files);
  const chunks = chunkRepository(files, chunking);
  const index = buildIndex(chunks);

  const questions = options.limit
    ? dataset.questions.slice(0, options.limit)
    : dataset.questions;

  const cases: CaseResult[] = [];

  for (const [position, question] of questions.entries()) {
    const hits = search(index, question.question, retrieval.topK, {
      rerankMode: retrieval.rerankMode,
      queryExpansion: retrieval.queryExpansion,
    });
    const chunksForPrompt = hits.map((hit) => hit.chunk);
    const fallbackCitations = toCitations(hits);

    let caseResult: CaseResult;
    try {
      const answer = await answerQuestion(
        llm,
        question.question,
        chunksForPrompt,
        fallbackCitations,
        promptVersion,
      );
      const judged = await judgeAnswer(
        llm,
        question,
        answer.answer,
        chunksForPrompt
          .map(
            (chunk) =>
              `### ${chunk.file}:${chunk.startLine}-${chunk.endLine}\n${chunk.text}`,
          )
          .join("\n\n"),
      );

      const recall = evidenceRecall(
        answer.citations,
        question.reference.evidence,
      );

      caseResult = {
        questionId: question.id,
        category: question.category,
        answer: answer.answer,
        citations: answer.citations,
        judgeScore: judged.score,
        judgeReason: judged.reason,
        evidenceRecall: recall,
        latencyMs: answer.latencyMs,
        tokens: {
          prompt: answer.tokens.prompt,
          completion: answer.tokens.completion,
          cacheHit: answer.tokens.cacheHit,
          cacheMiss: answer.tokens.cacheMiss,
          judgePrompt: judged.tokens.prompt,
          judgeCompletion: judged.tokens.completion,
        },
        // agent 和 judge 都要花钱，两次调用一起算
        cost:
          estimateCost(answer.tokens, llm.pricePerMillion) +
          estimateCost(judged.tokens, llm.pricePerMillion),
        failureKind: classifyFailure(
          {
            answerCitations: parseAnswerCitations(answer.answer),
            evidenceRecall: recall,
            judgeScore: judged.score,
            successThreshold,
          },
          lineCounts,
        ),
      };
    } catch (error) {
      caseResult = {
        questionId: question.id,
        category: question.category,
        answer: "",
        citations: fallbackCitations,
        judgeScore: 1,
        judgeReason: error instanceof Error ? error.message : String(error),
        evidenceRecall: 0,
        latencyMs: 0,
        tokens: {
          prompt: 0,
          completion: 0,
          cacheHit: 0,
          cacheMiss: 0,
          judgePrompt: 0,
          judgeCompletion: 0,
        },
        cost: 0,
        failureKind: "timeout",
      };
    }

    cases.push(caseResult);
    options.onProgress?.(
      position + 1,
      questions.length,
      `[${chunking.id}] ${question.id} → judge ${caseResult.judgeScore}/5`,
    );
  }

  const summary = summarize(cases, successThreshold);
  const run: EvalRun = {
    runId,
    datasetId: dataset.id,
    repo: dataset.repo,
    chunking,
    retrieval,
    promptVersion,
    codeVersion: CODE_VERSION,
    model: llm.model,
    startedAt,
    finishedAt: new Date().toISOString(),
    summary,
    cases,
  };
  return run;
}

export function summarize(cases: CaseResult[], successThreshold: number): RunSummary {
  const total = cases.length || 1;
  const success = cases.filter((c) => c.judgeScore >= successThreshold).length;
  const latencies = cases.map((c) => c.latencyMs);

  const byCategory: RunSummary["byCategory"] = {};
  for (const item of cases) {
    const bucket = (byCategory[item.category] ??= { total: 0, success: 0 });
    bucket.total++;
    if (item.judgeScore >= successThreshold) bucket.success++;
  }

  return {
    successThreshold,
    successRate: success / total,
    avgJudgeScore:
      cases.reduce((sum, c) => sum + c.judgeScore, 0) / total,
    avgEvidenceRecall:
      cases.reduce((sum, c) => sum + c.evidenceRecall, 0) / total,
    avgLatencyMs:
      cases.reduce((sum, c) => sum + c.latencyMs, 0) / total,
    p95LatencyMs: percentile(latencies, 95),
    avgCost: cases.reduce((sum, c) => sum + c.cost, 0) / total,
    totalCost: cases.reduce((sum, c) => sum + c.cost, 0),
    totalTokens: cases.reduce(
      (sum, c) =>
        sum +
        c.tokens.prompt +
        c.tokens.completion +
        c.tokens.judgePrompt +
        c.tokens.judgeCompletion,
      0,
    ),
    byCategory,
  };
}

export async function writeReport(
  report: ExperimentReport,
  outputPath: string,
): Promise<void> {
  await mkdir(join(outputPath, ".."), { recursive: true });
  await writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");
}
