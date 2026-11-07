import { createHash } from "node:crypto";
import type { ChunkingStrategy } from "./schema.ts";

export interface Chunk {
  id: string;
  /** 相对仓库根目录的路径 */
  file: string;
  startLine: number;
  endLine: number;
  text: string;
  /** 该块所属的符号名（函数级切分时有意义） */
  symbol?: string;
  /**
   * 符号类型。重排时只给函数/方法加权：类级大块的行跨度天然覆盖证据行，
   * 加权会把「覆盖假象」当成召回提升。
   */
  symbolKind?: "function" | "class" | "method";
  language: string;
}

export interface CodeFile {
  path: string;
  language: string;
  lines: string[];
}

const LANG_BY_EXT: Record<string, string> = {
  ".py": "python",
  ".js": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".java": "java",
  ".go": "go",
  ".rs": "rust",
  ".c": "c",
  ".cpp": "cpp",
  ".h": "c",
  ".rb": "ruby",
  ".php": "php",
  ".md": "markdown",
  ".json": "json",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".toml": "toml",
  ".sh": "shell",
};

export function languageOf(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "text";
  return LANG_BY_EXT[path.slice(dot).toLowerCase()] ?? "text";
}

interface SymbolBoundary {
  name: string;
  kind: "function" | "class" | "method";
  startLine: number;
  endLine: number;
  indent: number;
}

/**
 * 结构化切分依赖缩进敏感的符号识别。这里用行级扫描而非完整 AST，
 * 因为评测集覆盖的仓库语言有限，而行级扫描在跨语言时行为一致且可解释。
 */
const SYMBOL_PATTERNS: Record<
  string,
  { pattern: RegExp; kind: SymbolBoundary["kind"] }[]
> = {
  python: [
    { pattern: /^\s*class\s+([A-Za-z_]\w*)/, kind: "class" },
    { pattern: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: "function" },
  ],
  javascript: [
    { pattern: /^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
    { pattern: /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: "function" },
    { pattern: /^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/  , kind: "method" },
    { pattern: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/, kind: "function" },
  ],
  typescript: [
    { pattern: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
    { pattern: /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: "function" },
    { pattern: /^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:readonly\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*[:{]/, kind: "method" },
    { pattern: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/, kind: "function" },
  ],
  java: [
    { pattern: /^\s*(?:public|private|protected)?\s*(?:abstract\s+|final\s+)?class\s+([A-Za-z_]\w*)/, kind: "class" },
    { pattern: /^\s*(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?[\w<>\[\],.\s]+\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*\{/, kind: "method" },
  ],
  go: [
    { pattern: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: "function" },
    { pattern: /^\s*type\s+([A-Za-z_]\w*)\s+struct/, kind: "class" },
  ],
  rust: [
    { pattern: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, kind: "function" },
    { pattern: /^\s*(?:pub\s+)?struct\s+([A-Za-z_]\w*)/, kind: "class" },
  ],
};

const INDENT_RE = /^\s*/;

/** 花括号语言里，函数体结束靠大括号配对而不是缩进。 */
const BRACE_LANGUAGES = new Set(["javascript", "typescript", "java", "go", "rust", "c", "cpp"]);

function scanSymbols(file: CodeFile): SymbolBoundary[] {
  const patterns = SYMBOL_PATTERNS[file.language];
  if (!patterns) return [];

  const found: SymbolBoundary[] = [];
  file.lines.forEach((line, index) => {
    const lineNumber = index + 1;
    for (const { pattern, kind } of patterns) {
      const match = pattern.exec(line);
      if (!match) continue;
      const indent = INDENT_RE.exec(line)?.[0].length ?? 0;
      found.push({
        name: match[1],
        kind,
        startLine: lineNumber,
        endLine: lineNumber,
        indent,
      });
      break;
    }
  });

  if (BRACE_LANGUAGES.has(file.language)) {
    assignBraceEnds(file, found);
  } else {
    assignIndentEnds(file, found);
  }
  return found;
}

/** 缩进语言：符号块在遇到缩进不大于自身的非空行时结束。 */
function assignIndentEnds(file: CodeFile, symbols: SymbolBoundary[]): void {
  for (const symbol of symbols) {
    let end = symbol.startLine;
    for (let line = symbol.startLine; line < file.lines.length; line++) {
      const text = file.lines[line];
      if (text.trim() === "") continue;
      const indent = INDENT_RE.exec(text)?.[0].length ?? 0;
      if (indent <= symbol.indent && line + 1 > symbol.startLine) break;
      end = line + 1;
    }
    symbol.endLine = end;
  }
}

/** 大括号语言：从声明行的首个 { 开始配对，忽略字符串与注释里的括号。 */
function assignBraceEnds(file: CodeFile, symbols: SymbolBoundary[]): void {
  for (const symbol of symbols) {
    let depth = 0;
    let started = false;
    let end = symbol.startLine;
    for (let line = symbol.startLine; line < file.lines.length; line++) {
      const text = file.lines[line];
      let inString: string | null = null;
      for (let col = 0; col < text.length; col++) {
        const ch = text[col];
        if (inString) {
          if (ch === "\\") {
            col++;
            continue;
          }
          if (ch === inString) inString = null;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") {
          inString = ch;
          continue;
        }
        if (ch === "{") {
          depth++;
          started = true;
        } else if (ch === "}") {
          depth--;
          if (started && depth <= 0) {
            end = line + 1;
            break;
          }
        }
      }
      if (started && depth <= 0) break;
    }
    symbol.endLine = end;
  }
}

function chunkId(file: string, start: number, end: number): string {
  return createHash("sha1")
    .update(`${file}:${start}:${end}`)
    .digest("hex")
    .slice(0, 12);
}

function toChunk(
  file: CodeFile,
  startLine: number,
  endLine: number,
  symbol?: string,
  symbolKind?: SymbolBoundary["kind"],
): Chunk {
  const text = file.lines.slice(startLine - 1, endLine).join("\n");
  return {
    id: chunkId(file.path, startLine, endLine),
    file: file.path,
    startLine,
    endLine,
    text,
    symbol,
    symbolKind,
    language: file.language,
  };
}

/** 固定窗口切分：按字符数滑动，跨文件边界不合并。 */
export function chunkFixedWindow(
  file: CodeFile,
  windowSize: number,
  overlap: number,
): Chunk[] {
  const chunks: Chunk[] = [];
  const text = file.lines.join("\n");
  if (text.length === 0) return chunks;

  const step = Math.max(1, windowSize - overlap);
  let offset = 0;
  while (offset < text.length) {
    const slice = text.slice(offset, offset + windowSize);
    if (slice.trim().length === 0) break;
    const before = text.slice(0, offset);
    const startLine = before.split("\n").length;
    const linesInSlice = slice.split("\n").length;
    chunks.push(toChunk(file, startLine, startLine + linesInSlice - 1));
    if (offset + windowSize >= text.length) break;
    offset += step;
  }
  return chunks;
}

/**
 * 函数级切分：每个符号一块，过小的块并入相邻块。
 *
 * 类也成块（哪怕它跨上千行）。这是实测出来的取舍：
 * 把类拆成「头部 + 各方法」之后，召回率从 22% 掉到 8%——
 * 类块虽然大，但它同时也是问题里点名某个类时唯一命中的东西。
 */
export function chunkByFunction(
  file: CodeFile,
  minFunctionLines: number,
): Chunk[] {
  const symbols = scanSymbols(file);
  if (symbols.length === 0) return [];

  const chunks: Chunk[] = [];
  let cursor = 1;

  for (const symbol of symbols) {
    // 符号声明之前、且不属于任何符号的模块级代码单独成块
    if (symbol.startLine > cursor) {
      chunks.push(toChunk(file, cursor, symbol.startLine - 1));
    }

    const lines = symbol.endLine - symbol.startLine + 1;
    if (lines < minFunctionLines) {
      // 太小则不单独成块，留给下一个符号一起处理
      continue;
    }
    chunks.push(toChunk(file, symbol.startLine, symbol.endLine, symbol.name, symbol.kind));
    cursor = symbol.endLine + 1;
  }

  if (cursor <= file.lines.length) {
    chunks.push(toChunk(file, cursor, file.lines.length));
  }
  return chunks;
}

/** 对整个仓库应用某种切分策略。 */
export function chunkRepository(
  files: CodeFile[],
  strategy: ChunkingStrategy,
): Chunk[] {
  const chunks: Chunk[] = [];
  for (const file of files) {
    if (strategy.kind === "fixed-window") {
      chunks.push(
        ...chunkFixedWindow(
          file,
          strategy.windowSize ?? 800,
          strategy.overlap ?? 120,
        ),
      );
    } else {
      const byFunction = chunkByFunction(
        file,
        strategy.minFunctionLines ?? 3,
      );
      // 整个文件都没有函数/类定义（纯模块级代码）时，符号扫描会一无所获。
      // 这种文件不能就此丢掉——它里面照样可能有答案，
      // 否则涉及这些文件的问题永远召不回来。退化成固定窗口。
      chunks.push(
        ...(byFunction.length > 0
          ? byFunction
          : chunkFixedWindow(
              file,
              strategy.windowSize ?? 800,
              strategy.overlap ?? 120,
            )),
      );
    }
  }
  return chunks;
}
