/**
 * 评测用的 LLM 客户端。走 OpenAI 兼容协议，这样阿里云百炼、DeepSeek、
 * OpenAI 都能用同一个实现，换模型只需要改环境变量。
 */

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
      };
    };

    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new LlmError("LLM 返回内容为空");

    return {
      content,
      promptTokens: payload.usage?.prompt_tokens ?? 0,
      completionTokens: payload.usage?.completion_tokens ?? 0,
      promptCacheHitTokens: payload.usage?.prompt_cache_hit_tokens ?? 0,
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

/** 环境里没有配置时返回 null，让离线评测流程能继续跑。 */
export function tryConfigFromEnv(
  env: Record<string, string | undefined>,
): LlmConfig | null {
  const baseUrl = env.LLM_BASE_URL;
  const apiKey = env.LLM_API_KEY;
  const model = env.LLM_MODEL;
  if (!baseUrl || !apiKey || !model) return null;
  return buildConfig(env, baseUrl, apiKey, model);
}

/** 从环境变量读取配置，缺失时给出明确提示而不是静默失败。 */
export function configFromEnv(env: Record<string, string | undefined>): LlmConfig {
  const baseUrl = env.LLM_BASE_URL;
  const apiKey = env.LLM_API_KEY;
  const model = env.LLM_MODEL;
  if (!baseUrl || !apiKey || !model) {
    throw new Error(
      "缺少 LLM 配置，需要 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL 三个环境变量",
    );
  }
  return buildConfig(env, baseUrl, apiKey, model);
}

function buildConfig(
  env: Record<string, string | undefined>,
  baseUrl: string,
  apiKey: string,
  model: string,
): LlmConfig {
  const temperature = env.LLM_TEMPERATURE?.trim();
  const maxTokens = env.LLM_MAX_TOKENS?.trim();
  return {
    baseUrl,
    apiKey,
    model,
    temperature: temperature ? Number(temperature) : undefined,
    maxTokens: maxTokens ? Number(maxTokens) : undefined,
    pricePerMillion: env.LLM_PRICE_PROMPT
      ? {
          prompt: Number(env.LLM_PRICE_PROMPT),
          completion: Number(env.LLM_PRICE_COMPLETION ?? "0"),
          cacheHit: env.LLM_PRICE_PROMPT_CACHE_HIT
            ? Number(env.LLM_PRICE_PROMPT_CACHE_HIT)
            : undefined,
        }
      : undefined,
    currency: env.LLM_PRICE_CURRENCY?.trim() || undefined,
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
