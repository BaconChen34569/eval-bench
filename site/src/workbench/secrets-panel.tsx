/**
 * 模型密钥。
 *
 * 用户在这个页面填 API Key，密钥只往一个地方去：本机的 harness/.env。
 * 不进 localStorage、不进 URL、不进日志、也不会再回显给浏览器——
 * 页面这边只拿得到「配没配、缺哪个字段、接口通不通」这类状态。
 *
 * 存好之后命令行直接能用：harness 自己读 .env，
 * 不用再手改文件，也不用把密钥打到命令行上。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Plug,
  Save,
  Trash2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";

import {
  api,
  type SecretModel,
  type SecretProfile,
  type SecretStatus,
} from "@/src/workbench/api";

interface Preset {
  id: string;
  label: string;
  prefix: string;
  baseUrl: string;
  model: string;
  profileLabel: string;
}

const PRESETS: Preset[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    prefix: "LLM",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-flash",
    profileLabel: "DeepSeek",
  },
  {
    id: "qwen",
    label: "通义千问（阿里云百炼）",
    prefix: "QWEN",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    profileLabel: "通义千问",
  },
  {
    id: "glm",
    label: "智谱 GLM",
    prefix: "GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4-flash",
    profileLabel: "智谱 GLM",
  },
  {
    id: "ark",
    label: "豆包（火山方舟）",
    prefix: "ARK",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    model: "doubao-seed-1-6",
    profileLabel: "豆包",
  },
  {
    id: "moonshot",
    label: "Kimi（月之暗面）",
    prefix: "MOONSHOT",
    baseUrl: "https://api.moonshot.cn/v1",
    model: "kimi-k2-turbo-preview",
    profileLabel: "Kimi",
  },
  {
    id: "minimax",
    label: "MiniMax（海螺 AI）",
    prefix: "MINIMAX",
    baseUrl: "https://api.minimax.cn/v1",
    model: "MiniMax-M2",
    profileLabel: "MiniMax",
  },
  {
    id: "qianfan",
    label: "百度千帆（文心）",
    prefix: "QIANFAN",
    baseUrl: "https://qianfan.baidubce.com/v2",
    model: "ernie-4.5-turbo-128k",
    profileLabel: "百度千帆",
  },
  {
    id: "hunyuan",
    label: "腾讯混元",
    prefix: "HUNYUAN",
    baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
    model: "hunyuan-turbo",
    profileLabel: "腾讯混元",
  },
  {
    id: "siliconflow",
    label: "硅基流动（SiliconFlow）",
    prefix: "SILICON",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "Qwen/Qwen3-8B",
    profileLabel: "硅基流动",
  },
  {
    id: "stepfun",
    label: "阶跃星辰",
    prefix: "STEP",
    baseUrl: "https://api.stepfun.com/v1",
    model: "step-2-16k",
    profileLabel: "阶跃星辰",
  },
  {
    id: "spark",
    label: "讯飞星火",
    prefix: "SPARK",
    baseUrl: "https://spark-api-open.xf-yun.com/v1",
    model: "4.0Ultra",
    profileLabel: "讯飞星火",
  },
  {
    id: "yi",
    label: "零一万物",
    prefix: "YI",
    baseUrl: "https://api.lingyiwanwu.com/v1",
    model: "yi-lightning",
    profileLabel: "零一万物",
  },
  {
    id: "custom",
    label: "自定义（OpenAI 兼容接口）",
    prefix: "",
    baseUrl: "",
    model: "",
    profileLabel: "",
  },
];

/** 一个档案的连通测试结果，就地显示在它自己那一行。 */
interface ProfileResult {
  ok: boolean;
  latencyMs?: number;
  model?: string;
  error?: string;
}

/**
 * 模型选项上的标记。
 *
 * 只有查到「确实免费」的才标免费；查不到价格的一律按收费标 ¥——
 * 厂商新出的模型多半还没进价目表，标成不花钱会直接误导成本估算。
 */
function modelOptionLabel(model: SecretModel): string {
  if (model.paid === false) return `${model.id}（免费）`;
  return `¥ ${model.id}`;
}

/**
 * 当前选中模型的价格说明。
 *
 * 数字只写在这里，列表里用 ¥ 一个符号点出来就够。
 */
function priceHint(price: SecretModel | null): string {
  if (!price) return "";
  if (price.paid === false) return "免费";
  if (price.price) {
    return `¥ 输入 ${price.price.prompt} / 输出 ${price.price.completion} 元（每百万 token）`;
  }
  return "查不到价格，先按收费算";
}

export function SecretsPanel() {
  const [presetId, setPresetId] = useState(PRESETS[0].id);
  const [prefix, setPrefix] = useState(PRESETS[0].prefix);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(PRESETS[0].baseUrl);
  const [model, setModel] = useState(PRESETS[0].model);
  const [profileLabel, setProfileLabel] = useState(PRESETS[0].profileLabel);
  const [revealed, setRevealed] = useState(false);
  /** 手动填模型 id：下拉框里挑不到的那个模型才需要它。 */
  const [manualModel, setManualModel] = useState(false);

  const [status, setStatus] = useState<SecretStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  /** 表单这一份档案的可用模型，换服务商时按已知名单填好，不用等测连通。 */
  const [models, setModels] = useState<SecretModel[]>([]);
  /** 当前选中的模型值多少钱：手填的模型 id 也能查到价。 */
  const [modelPrice, setModelPrice] = useState<SecretModel | null>(null);
  /** 换服务商时用来挡掉过期的模型列表请求。 */
  const loadSeq = useRef(0);
  /** 每个档案各自的测试结果，按前缀存，互不干扰。 */
  const [profileResults, setProfileResults] = useState<
    Record<string, ProfileResult>
  >({});

  const refresh = async () => {
    try {
      setStatus(await api.secrets());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  useEffect(() => {
    void refresh();
    // 一进页面就把默认那家的已知名单拉出来：选模型不用等密钥。
    void loadKnownModels(PRESETS[0].baseUrl);
  }, []);

  // 模型 id 一变就查一次价：手填的模型（比如厂商没列出来的免费 flash）
  // 也能知道到底要不要花钱。
  useEffect(() => {
    const id = model.trim();
    if (!id) {
      setModelPrice(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      void api
        .secretPrice(id)
        .then((result) => {
          if (alive) setModelPrice(result);
        })
        .catch(() => {
          if (alive) setModelPrice(null);
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [model]);

  /**
   * 下拉框里的候选模型。
   *
   * 已知名单里没有当前填的模型时，把它自己补进去——
   * 厂商新出的型号本地还没收录，表单里也得能选。
   */
  const modelOptions = useMemo(() => {
    const list = [...models];
    const current = model.trim();
    if (current && !list.some((item) => item.id === current)) {
      list.push({
        id: current,
        paid: modelPrice?.paid ?? null,
        price: modelPrice?.price,
      });
    }
    return list;
  }, [models, model, modelPrice]);

  const choosePreset = (id: string) => {
    setPresetId(id);
    setModels([]);
    setManualModel(false);
    setMessage(null);
    setError(null);
    const preset = PRESETS.find((item) => item.id === id);
    if (!preset) return;
    setPrefix(preset.prefix);
    setBaseUrl(preset.baseUrl);
    setModel(preset.model);
    setProfileLabel(preset.profileLabel);
    // 换一家就把手里这把 key 清掉，免得存到别的档案里去。
    setApiKey("");
    setRevealed(false);
    void loadKnownModels(preset.baseUrl);
  };

  /**
   * 这家厂商已知的模型：不用密钥就能列出来。
   *
   * 问服务商要模型列表是要密钥的，但「这家大概有哪些模型」是公开信息，
   * 所以下拉框在填密钥之前就该能用。
   */
  const loadKnownModels = async (url: string) => {
    const seq = ++loadSeq.current;
    if (!url.trim()) {
      setModels([]);
      return;
    }
    try {
      const result = await api.secretModels(url.trim());
      if (seq !== loadSeq.current) return;
      setModels(result.models);
    } catch {
      if (seq === loadSeq.current) setModels([]);
    }
  };

  /** 用密钥向服务商要一份最新的模型列表。 */
  const refreshModels = async () => {
    setBusy("models");
    setError(null);
    setMessage(null);
    try {
      const result = await api.refreshSecretModels({
        prefix,
        testKey: apiKey.trim() || undefined,
        baseUrl: baseUrl.trim() || undefined,
      });
      if (!result.ok) {
        setError(result.error ?? "拉不到模型列表");
        return;
      }
      setModels(result.models);
      setManualModel(false);
      setMessage(`从服务商拉到了 ${result.models.length} 个可用模型。`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy("");
    }
  };

  const prefixError =
    prefix && !/^[A-Z][A-Z0-9_]{0,15}$/.test(prefix)
      ? "前缀只能用大写字母、数字和下划线"
      : "";

  const save = async () => {
    setBusy("save");
    setError(null);
    setMessage(null);
    try {
      if (!prefix) throw new Error("先填一个档案前缀");
      if (!apiKey.trim()) throw new Error("先填密钥");
      const result = await api.saveSecret({
        prefix,
        apiKey: apiKey.trim(),
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        label: profileLabel.trim(),
      });
      setStatus(result.status);
      // 密钥不留在页面里：存完就清掉输入框。
      setApiKey("");
      setRevealed(false);
      setMessage(
        `已存进 ${result.envPath}。命令行跑评测时会直接读它，不用再手改文件。`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy("");
    }
  };

  const test = async () => {
    setBusy("test");
    setError(null);
    setMessage(null);
    try {
      const result = await api.testSecret({
        prefix,
        testKey: apiKey.trim() || undefined,
        baseUrl: baseUrl.trim() || undefined,
        model: model.trim() || undefined,
      });
      if (!result.ok) {
        setError(result.error ?? "连不上");
        return;
      }
      const cost = result.price
        ? result.price.prompt > 0 || result.price.completion > 0
          ? `，单价 ¥ ${result.price.prompt} / ${result.price.completion}（每百万 token）`
          : "，免费"
        : "";
      setMessage(
        `配置可用：${result.model} 应答 ${result.latencyMs ?? 0} ms${cost}。`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy("");
    }
  };

  // 列表里的档案各自测，结果只落在它自己那一行，别串到上面的表单里。
  // 这里测的就是 .env 里存好的那个档案，所以允许用存着的密钥。
  const testProfile = async (profile: SecretProfile) => {
    setBusy(`test-${profile.prefix}`);
    try {
      const result = await api.testSecret({
        prefix: profile.prefix,
        useStoredKey: true,
      });
      setProfileResults((prev) => ({ ...prev, [profile.prefix]: result }));
    } catch (cause) {
      setProfileResults((prev) => ({
        ...prev,
        [profile.prefix]: {
          ok: false,
          error: cause instanceof Error ? cause.message : String(cause),
        },
      }));
    } finally {
      setBusy("");
    }
  };

  const clear = async (target: SecretProfile) => {
    setBusy(`clear-${target.prefix}`);
    setError(null);
    setMessage(null);
    try {
      const result = await api.clearSecret(target.prefix);
      setStatus(result.status);
      setProfileResults((prev) => {
        const next = { ...prev };
        delete next[target.prefix];
        return next;
      });
      setMessage(`已清掉 ${target.label} 的密钥，.env 里那一行现在是空的。`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">模型密钥</CardTitle>
          <CardDescription>
            填一次，密钥写进本机的 harness/.env，之后命令行跑评测直接读它。
            这一步是选填的：不填也能跑，只是只能跑检索层（不花钱、不调模型）。
            选模型不用密钥，测试连通才需要——它确认的是你现在这套配置能不能用。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              服务商
            </span>
            <NativeSelect
              value={presetId}
              onChange={(event) => choosePreset(event.target.value)}
            >
              {PRESETS.map((preset) => (
                <NativeSelectOption key={preset.id} value={preset.id}>
                  {preset.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className="text-xs font-medium text-muted-foreground">
                API Key
              </span>
              <div className="flex items-center gap-2">
                <Input
                  type={revealed ? "text" : "password"}
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder="sk-…"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono text-xs"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => setRevealed((value) => !value)}
                  title={revealed ? "藏起来" : "看一眼"}
                >
                  {revealed ? (
                    <EyeOff className="size-4" />
                  ) : (
                    <Eye className="size-4" />
                  )}
                  <span className="sr-only">
                    {revealed ? "藏起密钥" : "显示密钥"}
                  </span>
                </Button>
              </div>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">
                档案前缀
              </span>
              <Input
                value={prefix}
                onChange={(event) =>
                  setPrefix(event.target.value.toUpperCase())
                }
                placeholder="LLM"
                className="font-mono"
              />
              <span className="text-xs text-muted-foreground">
                {prefixError ||
                  "这一组配置的变量名。填 LLM，密钥就存成 .env 里的 LLM_API_KEY；换一个前缀就是另一组，互不干扰。"}
              </span>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">
                档案名
              </span>
              <Input
                value={profileLabel}
                onChange={(event) => setProfileLabel(event.target.value)}
                placeholder="DeepSeek"
              />
              <span className="text-xs text-muted-foreground">
                报告和图表上显示的名字，比如「DeepSeek」。多模型对比时靠它分清是哪一家。
              </span>
            </label>

            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className="text-xs font-medium text-muted-foreground">
                接口地址
              </span>
              <Input
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                onBlur={() => void loadKnownModels(baseUrl.trim())}
                placeholder="https://api.deepseek.com/v1"
                className="font-mono text-xs"
              />
            </label>

            <div className="flex flex-col gap-1 sm:col-span-2">
              <span className="text-xs font-medium text-muted-foreground">
                模型
              </span>
              {modelOptions.length > 0 && !manualModel ? (
                <NativeSelect
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                >
                  {modelOptions.map((item) => (
                    <NativeSelectOption key={item.id} value={item.id}>
                      {modelOptionLabel(item)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              ) : (
                <Input
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  placeholder="deepseek-flash"
                  className="font-mono text-xs"
                />
              )}
              <span className="text-xs text-muted-foreground">
                {modelOptions.length > 0
                  ? "带 ¥ 的是要花钱的，只有明确标「免费」的才不花钱"
                  : "这家厂商不在已知名单里，下面的模型 id 可以手填"}
                {" · "}
                <button
                  type="button"
                  className="underline underline-offset-2"
                  onClick={() => void refreshModels()}
                >
                  拉取最新列表
                </button>{" "}
                ·{" "}
                <button
                  type="button"
                  className="underline underline-offset-2"
                  onClick={() => setManualModel((value) => !value)}
                >
                  {manualModel ? "改回下拉框挑" : "手填模型 id"}
                </button>
              </span>
              {priceHint(modelPrice) && (
                <span
                  className={
                    modelPrice?.paid === false
                      ? "text-sm font-medium text-foreground"
                      : "text-xs text-muted-foreground"
                  }
                >
                  {priceHint(modelPrice)}
                </span>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={busy !== "" || !apiKey.trim() || !!prefixError}
              onClick={() => void save()}
            >
              {busy === "save" ? (
                <Loader2 className="mr-1 size-4 animate-spin" />
              ) : (
                <Save className="mr-1 size-4" />
              )}
              保存到 .env
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== "" || (!apiKey.trim() && !status)}
              onClick={() => void test()}
            >
              {busy === "test" ? (
                <Loader2 className="mr-1 size-4 animate-spin" />
              ) : (
                <Plug className="mr-1 size-4" />
              )}
              测试连通
            </Button>
          </div>

          <div className="rounded-lg border bg-secondary/40 px-3 py-2">
            <p className="flex items-center gap-1.5 text-xs font-medium">
              <KeyRound className="size-3.5" />
              密钥怎么处理
            </p>
            <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-5 text-xs text-muted-foreground">
              <li>只写进本机 harness/.env，这个文件在 .gitignore 里，不进版本库</li>
              <li>页面不保存也不回显：存完输入框就清空，刷新页面也没有</li>
              <li>只有点「测试连通」或「拉取最新列表」时，密钥才会被发给你填的那家服务商</li>
              <li>服务端不打印请求内容，日志里也不会出现密钥</li>
            </ul>
          </div>

          {message && (
            <p className="text-xs text-muted-foreground">{message}</p>
          )}
          {error && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">当前 .env 里的档案</CardTitle>
          <CardDescription>
            {status?.envPath ? (
              <code className="font-mono text-xs">{status.envPath}</code>
            ) : (
              "还没有 .env 文件"
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {status && status.profiles.length === 0 && (
            <p className="text-xs text-muted-foreground">
              .env 里还没有模型档案。在上面填一个保存就会出现。
            </p>
          )}
          {status?.profiles.map((profile) => {
            const result = profileResults[profile.prefix];
            return (
              <div
                key={profile.prefix}
                className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2"
              >
                <span className="text-sm font-medium">{profile.label}</span>
                <Badge variant="outline" className="font-mono">
                  {profile.prefix}_
                </Badge>
                {profile.configured ? (
                  <Badge variant="secondary">密钥已配置</Badge>
                ) : (
                  <Badge variant="outline">缺 {profile.missing.join(" / ")}</Badge>
                )}
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                  {profile.baseUrl || "还没填接口地址"}
                  {profile.model ? ` · ${profile.model}` : ""}
                </span>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy !== ""}
                  onClick={() => void testProfile(profile)}
                >
                  {busy === `test-${profile.prefix}` ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Plug className="size-3" />
                  )}
                  测试
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy !== ""}
                  onClick={() => void clear(profile)}
                >
                  {busy === `clear-${profile.prefix}` ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Trash2 className="size-3" />
                  )}
                  清除密钥
                </Button>
                {result && (
                  <span className="w-full text-xs text-muted-foreground">
                    {result.ok
                      ? `配置可用：${result.model ?? "默认模型"} 应答 ${result.latencyMs ?? 0} ms`
                      : `连不通：${result.error ?? "未知原因"}`}
                  </span>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
