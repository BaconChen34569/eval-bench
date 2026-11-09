/**
 * 选目录。
 *
 * 让用户逐级点进去挑一个仓库根目录，比让人手打绝对路径省事得多；
 * 手打路径的路子仍然留着——知道路径的人直接敲进去更快。
 *
 * 目录列表是本地服务给的：这个页面在浏览器里，
 * 浏览器拿不到磁盘上的绝对路径，只能由服务端去列。
 */

import { useCallback, useEffect, useState } from "react";
import { ArrowUp, Folder, FolderGit2, Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

import { api, type DirListing } from "@/src/workbench/api";

export function DirPicker({
  open,
  onOpenChange,
  initialPath,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 打开时先停在哪 */
  initialPath: string;
  /** 用户点了「用这个目录」 */
  onPick: (path: string) => void;
}) {
  const [typed, setTyped] = useState(initialPath);
  const [listing, setListing] = useState<DirListing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (path: string) => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.dirs(path);
      setListing(next);
      setTyped(next.path);
    } catch (cause) {
      setListing(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void load(initialPath);
  }, [open, initialPath, load]);

  const quickPicks = () => {
    if (!listing) return [];
    const items = [
      { label: "默认仓库", path: listing.hints.defaultRepoRoot },
      { label: "语料目录", path: listing.hints.corpusRepos },
      { label: "用户目录", path: listing.home },
      ...listing.drives.map((drive) => ({ label: drive, path: drive })),
    ];
    const seen = new Set<string>();
    return items.filter((item) => {
      if (!item.path || seen.has(item.path)) return false;
      seen.add(item.path);
      return true;
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>选择被测仓库目录</DialogTitle>
          <DialogDescription>
            选到仓库根目录那一层就行（带 .git 或 pyproject.toml 的那层）。
            也可以直接把路径粘进上面的输入框。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Input
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void load(typed);
              }}
              placeholder="D:\\qcode\\creativity_race\\corpus\\repos\\flask-3.1.3"
              className="font-mono text-xs"
            />
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void load(typed)}
            >
              打开
            </Button>
          </div>

          {quickPicks().length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">快捷位置</span>
              {quickPicks().map((item) => (
                <Button
                  key={item.path}
                  size="xs"
                  variant="outline"
                  onClick={() => void load(item.path)}
                >
                  {item.label}
                </Button>
              ))}
            </div>
          )}

          <div className="max-h-72 overflow-y-auto rounded-md border">
            {busy && (
              <p className="flex items-center gap-2 px-3 py-6 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                正在读目录…
              </p>
            )}
            {!busy && error && (
              <p className="px-3 py-6 text-xs text-destructive">{error}</p>
            )}
            {!busy && !error && listing && listing.entries.length === 0 && (
              <p className="px-3 py-6 text-xs text-muted-foreground">
                这个目录下面没有子目录。可以直接用「用这个目录」。
              </p>
            )}
            {!busy && !error && listing && listing.entries.length > 0 && (
              <ul className="flex flex-col p-1">
                {listing.entries.map((entry) => (
                  <li key={entry.path}>
                    <button
                      type="button"
                      onClick={() => void load(entry.path)}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-secondary"
                    >
                      {entry.looksLikeRepo ? (
                        <FolderGit2 className="size-4 shrink-0 text-amber-600" />
                      ) : (
                        <Folder className="size-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">
                        {entry.name}
                      </span>
                      {entry.looksLikeRepo && (
                        <Badge variant="outline" className="shrink-0">
                          像仓库
                        </Badge>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {listing && (
            <p className="truncate font-mono text-xs text-muted-foreground">
              {listing.path}
            </p>
          )}
        </div>

        <DialogFooter>
          {listing?.parent ? (
            <Button
              variant="ghost"
              size="sm"
              className="mr-auto"
              onClick={() => void load(listing.parent as string)}
            >
              <ArrowUp className="size-4" />
              上一级
            </Button>
          ) : null}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            onClick={() => {
              onPick(listing?.path ?? typed);
              onOpenChange(false);
            }}
          >
            用这个目录
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
