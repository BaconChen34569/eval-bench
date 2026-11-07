import { chat, type ChatMessage, type LlmConfig, type TokenUsage } from "./llm.ts";
import type { Chunk } from "./chunk.ts";
import type { Citation, PromptVersion } from "./schema.ts";

/**
 * 被评测的 agent：给定检索到的代码片段，回答问题并给出引用。
 *
 * 这里刻意保持简单——它就是「检索 + 一次 LLM 调用」。评测要回答的问题是
 * 「切分策略换了之后，检索质量变了没有」，如果 agent 本身每一轮都在变，
 * 这个对比就不成立。所以 agent 的提示词和调用方式在整个实验里保持不变。
 */

const AGENT_SYSTEM = `你是一个代码仓库问答助手。你会拿到若干来自仓库的代码片段。
请只依据这些片段回答问题，并指出你依据的是哪个文件。

要求：
1. 回答要具体到代码行为，能引用函数名、参数、返回值
2. 如果片段不足以回答，直接说明缺少哪些信息，不要编造
3. 回答末尾用 [文件名:起始行-结束行] 的格式列出你引用的位置`;

/**
 * cite-first：先列依据、再作答。
 *
 * 基准提示词里，模型常常先写一段流畅的解释，位置却引错；
 * 逼它先把「打算用哪几段」写出来，再据此作答，可以把定位和作答拆成两步。
 */
const AGENT_SYSTEM_CITE_FIRST = `你是一个代码仓库问答助手。你会拿到若干来自仓库的代码片段。
请只依据这些片段回答问题。

回答必须分成两节，缺一不可：

## 依据
逐条列出你打算使用的代码片段，每行一条，格式为 [文件名:起始行-结束行] 后面跟一句话说明这段代码在做什么。

## 回答
基于上面列出的位置作答，具体到函数名、参数、返回值。

要求：
- 片段不足以回答时，在「依据」里写明缺哪个文件或哪个函数，不要编造
- 不要引用没有出现在片段里的位置`;
const PROMPTS = {
  base: AGENT_SYSTEM,
  "cite-first": AGENT_SYSTEM_CITE_FIRST,
} as const;

export function agentSystemPrompt(version: PromptVersion = "base"): string {
  return PROMPTS[version] ?? PROMPTS.base;
}


export interface AgentAnswer {
  answer: string;
  citations: Citation[];
  tokens: TokenUsage;
  latencyMs: number;
}

/** 从答案正文里解析引用标记，缺省时回退到检索结果。 */
export function parseCitations(
  answer: string,
  fallback: Citation[],
): Citation[] {
  const pattern = /\[([^\]:]+):(\d+)-(\d+)\]/g;
  const found: Citation[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(answer)) !== null) {
    const [, file, start, end] = match;
    found.push({
      file: file.trim(),
      startLine: Number(start),
      endLine: Number(end),
      score: 0,
    });
  }
  if (found.length > 0) {
    // 回填检索打分，便于在看板上展示「引用了哪一块、这块排第几」
    return found.map((citation) => {
      const source = fallback.find(
        (item) =>
          item.file === citation.file &&
          item.startLine <= citation.endLine &&
          item.endLine >= citation.startLine,
      );
      return source ? { ...citation, score: source.score } : citation;
    });
  }
  return fallback;
}

/**
 * 只解析答案正文里模型自己写出来的引用位置，不用检索结果兜底。
 * 失败归因要靠它判断模型是不是编了位置，所以必须区分「模型引用的」和「检索兜底的」。
 */
export function parseAnswerCitations(answer: string): Citation[] {
  const pattern = /\[([^\]:]+):(\d+)-(\d+)\]/g;
  const found: Citation[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(answer)) !== null) {
    const [, file, start, end] = match;
    found.push({
      file: file.trim(),
      startLine: Number(start),
      endLine: Number(end),
      score: 0,
    });
  }
  return found;
}

export function formatContext(chunks: Chunk[]): string {
  return chunks
    .map(
      (chunk) =>
        `### ${chunk.file}:${chunk.startLine}-${chunk.endLine}${chunk.symbol ? ` (${chunk.symbol})` : ""}\n${chunk.text}`,
    )
    .join("\n\n");
}

export async function answerQuestion(
  config: LlmConfig,
  question: string,
  chunks: Chunk[],
  fallbackCitations: Citation[],
  promptVersion: PromptVersion = "base",
): Promise<AgentAnswer> {
  const messages: ChatMessage[] = [
    { role: "system", content: agentSystemPrompt(promptVersion) },
    {
      role: "user",
      content: `## 代码片段\n${formatContext(chunks)}\n\n## 问题\n${question}`,
    },
  ];

  const completion = await chat(config, messages);
  return {
    answer: completion.content,
    citations: parseCitations(completion.content, fallbackCitations),
    tokens: {
      prompt: completion.promptTokens,
      completion: completion.completionTokens,
      cacheHit: completion.promptCacheHitTokens,
      cacheMiss: completion.promptCacheMissTokens,
    },
    latencyMs: completion.latencyMs,
  };
}
