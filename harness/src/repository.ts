import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { languageOf, type CodeFile } from "./chunk.ts";

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".venv",
  "venv",
  "dist",
  "build",
  ".tox",
  "htmlcov",
  ".idea",
  ".vscode",
]);

/**
 * 变更日志和许可证里有大量英文词，会明显抬高 BM25 召回却答不出任何实现细节。
 * 评测集针对的是实现代码，这些文件按名字排除。
 */
const IGNORED_FILES = /^(changes|history|changelog|license|licence|copying|authors|contributors)/i;

const TEXT_EXTENSIONS = new Set([
  ".py",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".java",
  ".go",
  ".rs",
  ".c",
  ".cpp",
  ".h",
  ".rb",
  ".php",
  ".md",
  ".rst",
  ".txt",
  ".json",
  ".yml",
  ".yaml",
  ".toml",
  ".cfg",
  ".ini",
  ".sh",
]);

/**
 * 加载仓库。跳过测试目录是刻意的：评测集针对的是实现代码，
 * 而测试文件里的同名字符串会显著抬高 BM25 召回，让对比实验失去意义。
 */
export async function loadRepository(
  root: string,
  options: { includeTests?: boolean } = {},
): Promise<CodeFile[]> {
  const files: CodeFile[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        if (!options.includeTests && /(^|[._-])tests?([._-]|$)/.test(entry.name)) {
          continue;
        }
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;

      const rel = relative(root, full).split(sep).join("/");
      const dot = rel.lastIndexOf(".");
      const ext = dot < 0 ? "" : rel.slice(dot).toLowerCase();
      if (!TEXT_EXTENSIONS.has(ext)) continue;
      if (IGNORED_FILES.test(entry.name)) continue;

      const size = await stat(full).then((s) => s.size).catch(() => 0);
      if (size > 512 * 1024) continue;

      const content = await readFile(full, "utf8").catch(() => null);
      if (content === null) continue;
      if (content.includes("\u0000")) continue;

      files.push({
        path: rel,
        language: languageOf(rel),
        lines: content.split("\n"),
      });
    }
  }

  await walk(root);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}
