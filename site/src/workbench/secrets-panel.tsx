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

import { useEffect, useState } from "react";
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

import { api, type SecretProfile, type SecretStatus } from "@/src/workbench/api";

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
    id: "custom",
    label: "自定义（OpenAI 兼容接口）",
    prefix: "",
    baseUrl: "",
    model: "",
    profileLabel: "",
  },
];

export function SecretsPanel() {
  const [presetId, setPresetId] = useState(PRESETS[0].id);
  const [prefix, setPrefix] = useState(PRESETS[0].prefix);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(PRESETS[0].baseUrl);
  const [model, setModel] = useState(PRESETS[0].model);
  const [profileLabel, setProfileLabel] = useState(PRESETS[0].profileLabel);
  const [revealed, setRevealed] = useState(false);

  const [status, setStatus] = useState<SecretStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [models, setModels] = useState<string[]>([]);

  const refresh = async () => {
    try {
      setStatus(await api.secrets());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const choosePreset = (id: string) => {
    setPresetId(id);
    setModels([]);
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

  const test = async (target?: SecretProfile) => {
    setBusy(target ? `test-${target.prefix}` : "test");
    setError(null);
    setMessage(null);
    setModels([]);
    try {
      const result = await api.testSecret({
        prefix: target ? target.prefix : prefix,
        testKey: target ? undefined : apiKey.trim() || undefined,
      });
      if (result.ok) {
        setModels(result.models);
        setMessage(
          target
            ? `${target.label} 的密钥可用，接口上有 ${result.models.length} 个模型。`
            : "密钥可用。",
        );
      } else {
        setError(result.error ?? "连不上");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
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
                {prefixError || "存进 .env 时是 PREFIX_API_KEY 这样的变量名"}
              </span>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">
                档案名（报告里显示用）
              </span>
              <Input
                value={profileLabel}
                onChange={(event) => setProfileLabel(event.target.value)}
                placeholder="DeepSeek"
              />
            </label>

            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className="text-xs font-medium text-muted-foreground">
                接口地址
              </span>
              <Input
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="https://api.deepseek.com/v1"
                className="font-mono text-xs"
              />
            </label>

            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className="text-xs font-medium text-muted-foreground">
                模型 id
              </span>
              <Input
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="deepseek-flash"
                className="font-mono text-xs"
              />
            </label>
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
            {models.length > 0 && (
              <span className="font-mono text-xs text-muted-foreground">
                接口上的模型：{models.join(" / ")}
              </span>
            )}
          </div>

          <div className="rounded-lg border bg-secondary/40 px-3 py-2">
            <p className="flex items-center gap-1.5 text-xs font-medium">
              <KeyRound className="size-3.5" />
              密钥怎么处理
            </p>
            <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-5 text-xs text-muted-foreground">
              <li>只写进本机 harness/.env，这个文件在 .gitignore 里，不进版本库</li>
              <li>页面不保存也不回显：存完输入框就清空，刷新页面也没有</li>
              <li>只有点「测试连通」时，密钥才会被发给你填的那家服务商</li>
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
          {status?.profiles.map((profile) => (
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
                onClick={() => void test(profile)}
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
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
