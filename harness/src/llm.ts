/**
 * 评测用的 LLM 客户端。走 OpenAI 兼容协议，这样阿里云百炼、DeepSeek、
 * OpenAI 都能用同一个实现，换模型只需要改环境变量。
 */

import { priceFromEnv, type PriceSource } from "./pricing.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletion {
  content: string;
  promptTokens: number;
  completionTokens: number;
  /** 输入中命中服务商缓存的 token 数，只有部分服务商会在 usage 里报 */
  promptCacheHitTokens: number;
  /** 输入中未命中缓存的 token 数 */
  promptCacheMissTokens: number;
  latencyMs: number;
}

/** 一次调用的 token 用量。 */
export interface TokenUsage {
  prompt: number;
  completion: number;
  cacheHit: number;
  cacheMiss: number;
}

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /**
   * 单价（每百万 token），用于把 token 数折算成成本。
   * prompt 是未命中缓存的输入价，cacheHit 是命中缓存的输入价（不填则按 prompt 计）。
   */
  pricePerMillion?: { prompt: number; completion: number; cacheHit?: number };
  /** 单价从哪来：.env 填的、内置价目表查的，还是没有。 */
  priceSource?: PriceSource;
  /** 计价符号，跟随价格表用 ¥ 还是 $ */
  currency?: string;
  timeoutMs?: number;
  /**
   * 采样温度。不设则请求里不出现这个字段——
   * 推理模型（如 DeepSeek 的 reasoner 系列）不支持该参数，传了会报错。
   */
  temperature?: number;
  /** 单次输出上限。不设则由服务端按模型默认决定。 */
  maxTokens?: number;
}

export class LlmError extends Error {
  status?: number;
  /** 瞬时故障，原样重试有意义；生成超时这类结果性失败为 false */
  retryable?: boolean;

  constructor(message: string, status?: number, retryable = false) {
    super(message);
    this.name = "LlmError";
    this.status = status;
    this.retryable = retryable;
  }
}

export function estimateCost(
  usage: TokenUsage,
  price?: { prompt: number; completion: number; cacheHit?: number },
): number {
  if (!price) return 0;
  // 服务商不报缓存命中时，所有输入 token 都按未命中计
  const miss = usage.cacheMiss || usage.prompt;
  const hit = usage.cacheHit;
  return (
    (hit / 1_000_000) * (price.cacheHit ?? price.prompt) +
    (miss / 1_000_000) * price.prompt +
    (usage.completion / 1_000_000) * price.completion
  );
}

/**
 * 瞬时故障重试次数。
 *
 * 只对「网络断了 / 服务端限流 / 服务端 5xx」重试：这些是基础设施问题，
 * 不是被评测 Agent 的能力问题，把它们算成失败会污染评测结论。
 * 客户端自己触发的超时（生成太慢）不重试——那本身就是被测量的结果。
 */
const MAX_ATTEMPTS = 3;

/** 5xx 和 429 都属于可重试的服务端瞬时状态。 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export async function chat(
  config: LlmConfig,
  messages: ChatMessage[],
): Promise<ChatCompletion> {
  const started = Date.now();
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const result = await chatOnce(config, messages);
      return { ...result, latencyMs: Date.now() - started };
    } catch (error) {
      lastError = error;
      const retryable = error instanceof LlmError && error.retryable === true;
      if (attempt === MAX_ATTEMPTS || !retryable) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }

  throw lastError;
}

async function chatOnce(
  config: LlmConfig,
  messages: ChatMessage[],
): Promise<ChatCompletion> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    config.timeoutMs ?? 60_000,
  );

  try {
    const body: Record<string, unknown> = {
      model: config.model,
      messages,
    };
    if (config.temperature !== undefined) body.temperature = config.temperature;
    if (config.maxTokens !== undefined) body.max_tokens = config.maxTokens;

    const response = await fetch(
      `${config.baseUrl.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new LlmError(
        `LLM 请求失败 (${response.status}): ${body.slice(0, 300)}`,
        response.status,
        isRetryableStatus(response.status),
      );
    }

    const payload = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_cache_hit_tokens?: number;
        prompt_cache_miss_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
      };
    };

    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new LlmError("LLM 返回内容为空");

    // DeepSeek 用 prompt_cache_hit_tokens 报缓存命中，
    // 通义等走 OpenAI 通用协议的服务商用 prompt_tokens_details.cached_tokens。
    const cacheHitTokens =
      payload.usage?.prompt_cache_hit_tokens ??
      payload.usage?.prompt_tokens_details?.cached_tokens ??
      0;

    return {
      content,
      promptTokens: payload.usage?.prompt_tokens ?? 0,
      completionTokens: payload.usage?.completion_tokens ?? 0,
      promptCacheHitTokens: cacheHitTokens,
      promptCacheMissTokens: payload.usage?.prompt_cache_miss_tokens ?? 0,
      latencyMs: 0,
    };
  } catch (error) {
    if (error instanceof LlmError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new LlmError("LLM 请求超时");
    }
    // 网络层错误（连接被断、fetch failed）算瞬时故障，重试有意义
    throw new LlmError(
      `LLM 请求异常: ${error instanceof Error ? error.message : String(error)}`,
      undefined,
      true,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** 空字符串和纯空格都当作没填，避免 .env 里留空占位时被当成已配置。 */
function readEnv(
  env: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

/**
 * 按前缀拼出一份 LLM 配置。
 *
 * 前缀让同一个 .env 里能放好几家服务商：LLM_ / QWEN_ / GLM_ 各一组，
 * 各自带自己的接口地址、密钥、模型 id 和单价。
 */
export function buildLlmConfig(
  env: Record<string, string | undefined>,
  prefix: string,
): LlmConfig {
  const temperature = readEnv(env, `${prefix}_TEMPERATURE`);
  const maxTokens = readEnv(env, `${prefix}_MAX_TOKENS`);
  const model = readEnv(env, `${prefix}_MODEL`) ?? "";

  // 单价：.env 里填了以 .env 为准，没填就查内置价目表。
  const resolved = priceFromEnv(env, prefix, model);

  return {
    baseUrl: readEnv(env, `${prefix}_BASE_URL`) ?? "",
    apiKey: readEnv(env, `${prefix}_API_KEY`) ?? "",
    model,
    temperature: temperature ? Number(temperature) : undefined,
    maxTokens: maxTokens ? Number(maxTokens) : undefined,
    pricePerMillion: resolved.price
      ? {
          prompt: resolved.price.prompt,
          completion: resolved.price.completion,
          cacheHit: resolved.price.cacheHit,
        }
      : undefined,
    priceSource: resolved.source,
    currency: resolved.price?.currency,
  };
}

/** 列出账号可用的模型 id，用来确认该填哪个模型名。 */
export async function listModels(config: LlmConfig): Promise<string[]> {
  const response = await fetch(
    `${config.baseUrl.replace(/\/$/, "")}/models`,
    {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new LlmError(
      `获取模型列表失败 (${response.status}): ${body.slice(0, 300)}`,
      response.status,
    );
  }
  const payload = (await response.json()) as { data?: { id?: string }[] };
  return (payload.data ?? [])
    .map((item) => item.id)
    .filter((id): id is string => typeof id === "string");
}

/** 探一次连通的结果。 */
export interface LlmProbe {
  ok: boolean;
  /** 这次请求花了多久 */
  latencyMs: number;
  /** 成功时模型回的几个字，失败时是错误原因 */
  detail?: string;
}

/**
 * 用当前配置真的问一次模型。
 *
 * 测连通不是问「这家厂商有哪些模型」，而是问「你现在这套配置能不能用」：
 * 接口地址、密钥、模型 id 三样都要对，才算通过。
 * 消息只有两个字，输出上限 4 个 token，花的钱可以忽略。
 */
export async function probeChat(config: LlmConfig): Promise<LlmProbe> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(
      `${config.baseUrl.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 4,
        }),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new LlmError(
        `LLM 请求失败 (${response.status}): ${body.slice(0, 200)}`,
        response.status,
      );
    }
    const payload = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const reply = payload.choices?.[0]?.message?.content?.trim();
    return {
      ok: true,
      latencyMs: Date.now() - started,
      detail: reply ? reply.slice(0, 40) : "模型没有回话",
    };
  } catch (error) {
    if (error instanceof LlmError) {
      return { ok: false, latencyMs: Date.now() - started, detail: error.message };
    }
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, latencyMs: Date.now() - started, detail: "请求超时" };
    }
    return {
      ok: false,
      latencyMs: Date.now() - started,
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}
