import { useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/**
 * 可单条复制的命令块。
 *
 * 一整段命令贴到终端里最容易踩坑的是「前一条做完了，后面忘了改目录」，
 * 所以这里把命令拆成一步一块，每块一个复制按钮，复制的就是这一块。
 */

export interface CommandStep {
  id: string;
  title: string;
  /** 要复制的命令，一行一条 */
  lines: string[];
  /** 这步是选填的（比如配密钥） */
  optional?: boolean;
  /** 这步在哪个目录下执行 */
  cwd?: string;
  note?: ReactNode;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 剪贴板不可用时退回老办法：临时 textarea + execCommand
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  }
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="shrink-0"
      onClick={async () => {
        const ok = await copyText(text);
        if (!ok) return;
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      aria-label={copied ? "已复制" : "复制这段命令"}
    >
      {copied ? (
        <Check className="size-3.5" aria-hidden="true" />
      ) : (
        <Copy className="size-3.5" aria-hidden="true" />
      )}
      {copied ? "已复制" : "复制"}
    </Button>
  );
}

export function CommandSteps({ steps }: { steps: CommandStep[] }) {
  return (
    <div className="flex flex-col gap-3">
      {steps.map((step) => (
        <div
          key={step.id}
          className="rounded-lg border bg-secondary/40 px-3 py-3"
        >
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-medium">{step.title}</h4>
            {step.optional && (
              <Badge variant="outline" className="text-[11px]">
                选填
              </Badge>
            )}
            {step.cwd && (
              <span className="font-mono text-[11px] text-muted-foreground">
                {step.cwd}
              </span>
            )}
            <div className="ml-auto">
              <CopyButton text={step.lines.join("\n")} />
            </div>
          </div>
          <pre className="table-scroll overflow-x-auto rounded-md bg-background/60 p-3 font-mono text-xs leading-relaxed">
            <code>{step.lines.join("\n")}</code>
          </pre>
          {step.note && (
            <p className="mt-2 text-xs text-muted-foreground">{step.note}</p>
          )}
        </div>
      ))}
    </div>
  );
}
