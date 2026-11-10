/**
 * 各家服务商的已知模型。
 *
 * 按接口地址的域名索引：页面换一家服务商，下拉框里立刻就有模型可选，
 * 不用先填密钥去问服务商——问模型列表是要密钥的，
 * 但「这家厂商大概有哪些模型」是公开信息，写在这里就行。
 *
 * 型号 id 只写官方文档里能查到的。厂商临时上新的话，
 * 页面上另有「拉取最新列表」，用密钥真去问一遍。
 */

/** 域名 → 这家厂商的模型 id。 */
export const VENDOR_MODELS: Record<string, string[]> = {
  "api.deepseek.com": [
    "deepseek-flash",
    "deepseek-chat",
    "deepseek-reasoner",
    "deepseek-v4-pro",
  ],
  "dashscope.aliyuncs.com": [
    "qwen-plus",
    "qwen-turbo",
    "qwen-max",
    "qwen3.5-plus",
    "qwen3.6-plus",
    "qwen3.7-plus",
    "qwen3.7-max",
    "qwen3.8-max",
    "qwen3.7-flash",
    "qwen3.8-flash",
    "qwen3.8-27b",
  ],
  // 智谱的 /models 不列免费模型，免费那几个一并写进来。
  "open.bigmodel.cn": [
    "glm-4.5",
    "glm-4.5-air",
    "glm-4.6",
    "glm-4.7",
    "glm-4.7-flash",
    "glm-4.5-flash",
    "glm-4-flash",
    "glm-4-flash-250414",
    "glm-4.6v-flash",
    "glm-4.1v-thinking-flash",
    "glm-4v-flash",
    "glm-5",
    "glm-5-turbo",
    "glm-5.1",
    "glm-5.2",
    "glm-5.3",
    "glm-5.3-flash",
    "glm-5.3-flashx",
    "glm-5.3-flashx-legal",
  ],
  "ark.cn-beijing.volces.com": [
    "doubao-seed-1-6",
    "doubao-1-5-pro-32k-250115",
    "doubao-1-5-lite-32k-250115",
  ],
  "api.moonshot.cn": [
    "kimi-k2-turbo-preview",
    "kimi-k2-0905-preview",
    "moonshot-v1-8k",
    "moonshot-v1-32k",
  ],
  "api.minimax.cn": ["MiniMax-M2", "MiniMax-M1"],
  "qianfan.baidubce.com": [
    "ernie-4.5-turbo-128k",
    "ernie-4.0-turbo-8k",
    "ernie-speed-8k",
  ],
  "api.hunyuan.cloud.tencent.com": [
    "hunyuan-turbo",
    "hunyuan-large",
    "hunyuan-standard",
    "hunyuan-lite",
  ],
  "api.siliconflow.cn": [
    "Qwen/Qwen3-8B",
    "Qwen/Qwen2.5-72B-Instruct",
    "deepseek-ai/DeepSeek-V3",
    "THUDM/glm-4-9b-chat",
  ],
  "api.stepfun.com": ["step-2-16k", "step-2-32k", "step-1-32k"],
  "spark-api-open.xf-yun.com": ["4.0Ultra", "max", "pro", "lite"],
  "api.lingyiwanwu.com": ["yi-lightning", "yi-large", "yi-medium"],
};

/** 取接口地址里的域名，填的不是合法地址就返回空串。 */
export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl.trim()).host.toLowerCase();
  } catch {
    return "";
  }
}

/** 这家接口地址背后是已知厂商吗？ */
export function isKnownVendor(baseUrl: string): boolean {
  return hostOf(baseUrl) in VENDOR_MODELS;
}

/**
 * 这家厂商已知的模型 id。
 *
 * 认不出来的域名返回空数组——这时候只能手填模型 id，
 * 或者用密钥去问服务商。
 */
export function knownModelsFor(baseUrl: string): string[] {
  return VENDOR_MODELS[hostOf(baseUrl)] ?? [];
}
