/**
 * 多模型档案。
 *
 * 一个档案 = 一组带前缀的环境变量 = 一家 OpenAI 兼容服务商：
 * 接口地址、密钥、模型 id、单价。默认档案用 LLM_ 前缀，
 * 其余档案各自的前缀，比如 QWEN_ / GLM_。
 *
 * 有了档案，同一份语料、同一条检索链路就能换模型重跑，
 * 用来回答「这套评测台能不能区分出模型的好坏」。
 */
import { buildLlmConfig, type LlmConfig } from "./llm.ts";

export interface ModelProfile {
  /** 命令行里用的名字，--model qwen */
  id: string;
  /** 环境变量前缀，如 LLM / QWEN / GLM */
  prefix: string;
  /** 站上展示用的名字 */
  label: string;
  /** 拼好的配置。缺密钥时为 null */
  config: LlmConfig | null;
  /** 跑起来还缺哪些字段 */
  missing: string[];
  /** 接口地址，缺密钥时也能显示，方便确认填对没有 */
  baseUrl: string;
  /** 已经选定的模型 id */
  model: string;
}

/** 跑起来必须有的三个字段。 */
const REQUIRED = ["BASE_URL", "API_KEY", "MODEL"] as const;

/** 出现这些后缀的变量，说明存在一个档案。 */
const PROFILE_KEY = /_([A-Z]+)$/;

/**
 * 找出 .env 里定义了哪些档案。
 *
 * 靠变量名反推前缀，而不是在代码里写死「三家模型」——
 * 用户加第四家（比如 Kimi）只要在 .env 里多写一组带前缀的变量就能用。
 */
export function discoverProfiles(
  env: Record<string, string | undefined>,
): ModelProfile[] {
  const prefixes = new Set<string>();
  for (const key of Object.keys(env)) {
    const match = PROFILE_KEY.exec(key);
    if (!match) continue;
    const suffix = match[1];
    if (suffix === "BASE_URL" || suffix === "API_KEY" || suffix === "MODEL") {
      prefixes.add(key.slice(0, key.length - suffix.length - 1));
    }
  }

  // 默认档案排前面，其余按前缀字母序
  return [...prefixes]
    .sort((a, b) => (a === "LLM" ? -1 : b === "LLM" ? 1 : a.localeCompare(b)))
    .map((prefix) => buildProfile(env, prefix));
}

function buildProfile(
  env: Record<string, string | undefined>,
  prefix: string,
): ModelProfile {
  const value = (field: string): string =>
    (env[`${prefix}_${field}`] ?? "").trim();

  const id =
    value("PROFILE") || (prefix === "LLM" ? "default" : prefix.toLowerCase());
  const label = value("LABEL") || id;

  const missing = REQUIRED.filter((field) => !value(field)).map(
    (field) => `${prefix}_${field}`,
  );

  const hasEndpoint = Boolean(value("BASE_URL")) && Boolean(value("API_KEY"));
  const config = hasEndpoint ? buildLlmConfig(env, prefix) : null;

  return {
    id,
    prefix,
    label,
    config,
    missing,
    baseUrl: value("BASE_URL"),
    model: value("MODEL"),
  };
}

/** 配全了的档案：配置一定可用。 */
export interface ReadyProfile extends ModelProfile {
  config: LlmConfig;
}

/**
 * 取一个档案来跑。
 *
 * 没给名字就用默认档案；给了名字但没定义，或者定义了但没填密钥，
 * 都要在这里说清楚缺什么，不让错误拖到请求服务端才炸。
 */
export function resolveProfile(
  env: Record<string, string | undefined>,
  id?: string,
): ReadyProfile {
  const profiles = discoverProfiles(env);

  const pick = (profile: ModelProfile): ReadyProfile => {
    if (profile.missing.length > 0 || !profile.config) {
      throw new Error(
        `档案 ${profile.id} 没配全，缺少 ${profile.missing.join(" / ")}` +
          `（填到 harness/.env 里）`,
      );
    }
    return profile as ReadyProfile;
  };

  if (!id) {
    const fallback =
      profiles.find((profile) => profile.prefix === "LLM") ?? profiles[0];
    if (!fallback) {
      throw new Error(
        "没有找到任何模型档案。harness/.env 里至少要有一组 *_BASE_URL / *_API_KEY / *_MODEL。",
      );
    }
    return pick(fallback);
  }

  const match = profiles.find(
    (profile) => profile.id.toLowerCase() === id.toLowerCase(),
  );
  if (!match) {
    const known = profiles.map((profile) => profile.id).join(" / ") || "无";
    throw new Error(`没有名为 ${id} 的模型档案。已知的档案：${known}`);
  }
  return pick(match);
}
