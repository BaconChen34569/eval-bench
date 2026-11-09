/**
 * 价目表。
 *
 * 每个模型填一遍单价很烦，模型一多就容易漏、也容易填错。
 * 这里按模型 id 存了一份常见模型的公开价（每百万 token），
 * .env 里填了就以 .env 为准，没填就查这张表。
 *
 * 表里的价格会过期——正式报告建议在 .env 里显式写死，
 * 这样数字能对得上某个具体时间点的官方价目表。
 */

/** 一份单价。prompt 是未命中缓存的输入价，cacheHit 是命中缓存的输入价。 */
export interface UnitPrice {
  prompt: number;
  completion: number;
  cacheHit?: number;
  currency: string;
}

/** 单价的来源，报告和命令输出里都要标出来。 */
export type PriceSource = "env" | "builtin" | "none";

export interface ResolvedPrice {
  price?: UnitPrice;
  source: PriceSource;
}

/**
 * 内置的常见模型价目表，单位：元 / 百万 token。
 *
 * 数字来自各家官方价目页，核对日期写在下面：
 *   智谱 GLM   docs.bigmodel.cn/cn/guide/start/pricing
 *   智谱免费模型 docs.bigmodel.cn/cn/guide/start/model-overview
 *   DeepSeek   api-docs.deepseek.com/quick_start/pricing（取夜间低峰价）
 *   通义千问   help.aliyun.com/zh/model-studio/billing-for-model-studio
 *
 * 拿不准的一律不收——宁可让用户自己填，也不要给一个错的数字。
 * 厂商新出的模型大多还没进这张表，页面上会标成「查不到价格，按收费算」。
 */
export const BUILTIN_PRICES: Record<string, UnitPrice> = {
  // DeepSeek
  "deepseek-flash": { prompt: 1, completion: 4, cacheHit: 0.02, currency: "¥" },
  "deepseek-v4-pro": {
    prompt: 4.5,
    completion: 13.5,
    cacheHit: 0.15,
    currency: "¥",
  },
  "deepseek-chat": { prompt: 2, completion: 8, cacheHit: 0.2, currency: "¥" },
  "deepseek-reasoner": {
    prompt: 4,
    completion: 16,
    cacheHit: 1,
    currency: "¥",
  },

  // 智谱 GLM：长上下文档位按最低一档记
  "glm-5.3": { prompt: 8, completion: 28, cacheHit: 2, currency: "¥" },
  "glm-5.3-flash": {
    prompt: 0.8,
    completion: 2.8,
    cacheHit: 0.23,
    currency: "¥",
  },
  "glm-5.3-flashx": {
    prompt: 2,
    completion: 7,
    cacheHit: 0.57,
    currency: "¥",
  },
  "glm-5.3-flashx-legal": {
    prompt: 2,
    completion: 7,
    cacheHit: 0.57,
    currency: "¥",
  },
  "glm-5.2": { prompt: 8, completion: 28, cacheHit: 2, currency: "¥" },
  "glm-5.1": { prompt: 6, completion: 24, currency: "¥" },
  "glm-5-turbo": { prompt: 5, completion: 22, currency: "¥" },
  "glm-5": { prompt: 4, completion: 18, currency: "¥" },
  "glm-4.7": { prompt: 2, completion: 8, currency: "¥" },
  "glm-4.5": { prompt: 2, completion: 6, cacheHit: 0.4, currency: "¥" },
  "glm-4.5-air": {
    prompt: 0.8,
    completion: 2,
    cacheHit: 0.16,
    currency: "¥",
  },

  // 智谱明确免费的模型：官方写的是输入、输出、缓存全免
  "glm-4.7-flash": { prompt: 0, completion: 0, currency: "¥" },
  "glm-4.5-flash": { prompt: 0, completion: 0, currency: "¥" },
  "glm-4-flash": { prompt: 0, completion: 0, currency: "¥" },
  "glm-4-flash-250414": { prompt: 0, completion: 0, currency: "¥" },
  "glm-4.6v-flash": { prompt: 0, completion: 0, currency: "¥" },
  "glm-4.1v-thinking-flash": { prompt: 0, completion: 0, currency: "¥" },
  "glm-4v-flash": { prompt: 0, completion: 0, currency: "¥" },

  // 通义千问（阿里云百炼）
  "qwen3.8-max": { prompt: 12, completion: 36, currency: "¥" },
  "qwen3.7-max": { prompt: 12, completion: 36, currency: "¥" },
  "qwen3.7-plus": { prompt: 2, completion: 8, currency: "¥" },
  "qwen3.6-plus": { prompt: 2, completion: 12, currency: "¥" },
  "qwen3.5-plus": { prompt: 0.8, completion: 4.8, currency: "¥" },
  "qwen-plus": { prompt: 0.8, completion: 2, cacheHit: 0.08, currency: "¥" },
  "qwen-max": { prompt: 2.4, completion: 9.6, currency: "¥" },
  "qwen-turbo": { prompt: 0.3, completion: 1.2, cacheHit: 0.03, currency: "¥" },
};

/**
 * 每家厂商域名对应的免费模型。
 *
 * 有些厂商的模型列表接口不把免费模型列出来（智谱就是：
 * /models 只给 12 个付费模型，免费那几个要手动填 id 才用得上）。
 * 不补上的话，下拉框里永远看不到「免费」的那几个。
 */
export const VENDOR_FREE_MODELS: Record<string, string[]> = {
  "open.bigmodel.cn": [
    "glm-4.7-flash",
    "glm-4.5-flash",
    "glm-4-flash",
    "glm-4-flash-250414",
    "glm-4.6v-flash",
    "glm-4.1v-thinking-flash",
    "glm-4v-flash",
  ],
};

/**
 * 查内置价目表。
 *
 * 先精确匹配，再按前缀匹配：deepseek-chat-0324 这种带日期后缀的算同一个模型。
 * 前缀只在分隔符边界上续接——glm-5 吃不掉 glm-5.1 和 glm-5.3-flash，
 * 它们是不同价钱的模型。
 */
export function lookupBuiltinPrice(modelId: string): UnitPrice | undefined {
  const id = modelId.trim().toLowerCase();
  if (!id) return undefined;
  const exact = BUILTIN_PRICES[id];
  if (exact) return exact;
  const matched = Object.keys(BUILTIN_PRICES)
    .filter((key) => id.startsWith(`${key}-`) || id.startsWith(`${key}_`))
    .sort((a, b) => b.length - a.length)[0];
  return matched ? BUILTIN_PRICES[matched] : undefined;
}

/**
 * 定一份单价出来。
 *
 * .env 里填的优先；没填就查内置表；两边都没有就说明没有单价，
 * 成本只能记成 0——这种情况要在输出里说清楚，不能让人以为模型免费。
 */
export function resolvePrice(
  modelId: string,
  envPrice?: { prompt: number; completion: number; cacheHit?: number },
  envCurrency?: string,
): ResolvedPrice {
  if (envPrice && Number.isFinite(envPrice.prompt)) {
    return {
      price: {
        prompt: envPrice.prompt,
        completion: envPrice.completion,
        cacheHit: envPrice.cacheHit,
        currency: envCurrency?.trim() || "¥",
      },
      source: "env",
    };
  }
  const builtin = lookupBuiltinPrice(modelId);
  if (builtin) return { price: builtin, source: "builtin" };
  return { source: "none" };
}

/**
 * 从 .env 的一组前缀变量里读单价。
 *
 * 三个 *_PRICE_* 变量只要填了输入价就算「显式配置」，
 * 输出价没填按 0 算，缓存命中价没填按输入价算。
 */
export function priceFromEnv(
  env: Record<string, string | undefined>,
  prefix: string,
  modelId: string,
): ResolvedPrice {
  const read = (field: string): string | undefined =>
    env[`${prefix}_${field}`]?.trim() || undefined;

  const prompt = read("PRICE_PROMPT");
  const completion = read("PRICE_COMPLETION");
  const cacheHit = read("PRICE_PROMPT_CACHE_HIT");

  return resolvePrice(
    modelId,
    prompt
      ? {
          prompt: Number(prompt),
          completion: Number(completion ?? "0"),
          cacheHit: cacheHit ? Number(cacheHit) : undefined,
        }
      : undefined,
    read("PRICE_CURRENCY"),
  );
}

/** 把单价说成人话，给命令输出和文档用。 */
export function describePrice(
  price: UnitPrice | undefined,
  source: PriceSource,
): string {
  if (!price || source === "none") return "未配置单价（成本记为 0）";
  if (price.prompt === 0 && price.completion === 0) {
    return source === "builtin" ? "免费（来自内置价目表）" : "免费";
  }
  const hit =
    price.cacheHit === undefined
      ? "缓存命中同未命中价"
      : `缓存命中 ${price.cacheHit}`;
  const from = source === "builtin" ? "内置价目表" : ".env";
  return `输入未命中 ${price.prompt} / ${hit} / 输出 ${price.completion}（每百万 token，${price.currency}，来自 ${from}）`;
}
