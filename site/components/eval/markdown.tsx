import { Fragment, type ReactNode, useMemo } from "react";

// 只渲染回答里真正出现过的语法子集，并自研解析以免给静态站点再背一份 markdown 依赖。

type Segment =
  | { kind: "text"; text: string }
  | { kind: "code"; lang: string; code: string };

type ListItem = { indent: number; segments: Segment[]; ordered: boolean };
type ListNode = { segments: Segment[]; ordered: boolean; children: ListNode[] };

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "code"; lang: string; code: string }
  | { kind: "list"; nodes: ListNode[] }
  | { kind: "quote"; lines: string[] }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "hr" }
  | { kind: "paragraph"; text: string };

const CITATION = /^[\w./-]+\.[A-Za-z]+:\d+(-\d+)?$/;
const CJK = /[　-鿿＀-￯]/;

/** Markdown 的软换行等于一个空格，但中文之间不该多出空格。 */
function joinLines(lines: string[]): string {
  return lines.reduce((acc, line) => {
    if (!acc) return line;
    const previous = acc[acc.length - 1];
    return CJK.test(previous) || CJK.test(line[0] ?? "")
      ? acc + line
      : `${acc} ${line}`;
  }, "");
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function buildListTree(items: ListItem[]): ListNode[] {
  const roots: ListNode[] = [];
  const stack: { indent: number; node: ListNode }[] = [];
  for (const item of items) {
    const node: ListNode = {
      segments: item.segments,
      ordered: item.ordered,
      children: [],
    };
    while (stack.length && stack[stack.length - 1].indent >= item.indent) {
      stack.pop();
    }
    if (stack.length) stack[stack.length - 1].node.children.push(node);
    else roots.push(node);
    stack.push({ indent: item.indent, node });
  }
  return roots;
}

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;

  const blank = (line: string) => line.trim() === "";
  const isListLine = (line: string) => /^\s*([-*+]|\d+\.)\s+/.test(line);
  const isBlockStart = (line: string) =>
    /^\s*```/.test(line) ||
    /^#{1,6}\s+/.test(line) ||
    /^\s*>\s?/.test(line) ||
    isListLine(line) ||
    /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line);

  while (index < lines.length) {
    const line = lines[index];
    if (blank(line)) {
      index += 1;
      continue;
    }

    const fence = line.match(/^\s*```(\S*)\s*$/);
    if (fence) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1;
      blocks.push({ kind: "code", lang: fence[1], code: body.join("\n") });
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ kind: "hr" });
      index += 1;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: heading[1].length,
        text: heading[2].trim(),
      });
      index += 1;
      continue;
    }

    // 表格：当前行是 | 开头，下一行是 |---|---| 这种分隔行
    if (
      line.trim().startsWith("|") &&
      index + 1 < lines.length &&
      /^\s*\|?[\s:|-]*-[\s:|-]*\|/.test(lines[index + 1])
    ) {
      const head = splitRow(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].trim().startsWith("|")) {
        rows.push(splitRow(lines[index]));
        index += 1;
      }
      blocks.push({ kind: "table", head, rows });
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const body: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        body.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      blocks.push({ kind: "quote", lines: body });
      continue;
    }

    if (isListLine(line)) {
      const items: ListItem[] = [];
      while (index < lines.length) {
        if (!isListLine(lines[index])) {
          // 条目之间可以隔空行：下一个非空行还是列表项就还是同一个列表，
          // 否则每个条目都会被拆成独立列表，序号全部从 1 开始。
          let probe = index;
          while (probe < lines.length && blank(lines[probe])) probe += 1;
          if (probe < lines.length && isListLine(lines[probe])) {
            index = probe;
            continue;
          }
          break;
        }
        const matched = lines[index].match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/)!;
        const indent = Math.floor(matched[1].replace(/\t/g, "  ").length / 2);
        const segments: Segment[] = [{ kind: "text", text: matched[3] }];
        const appendText = (value: string) => {
          const last = segments[segments.length - 1];
          if (last.kind === "text") last.text += value;
          else segments.push({ kind: "text", text: value });
        };
        items.push({ indent, segments, ordered: /\d/.test(matched[2]) });
        index += 1;
        // 缩进的续行并入上一项
        while (
          index < lines.length &&
          !blank(lines[index]) &&
          !isListLine(lines[index])
        ) {
          // 条目里的代码围栏要原样保留，不能被压成一行行内代码
          const inner = lines[index].match(/^\s*```(\S*)\s*$/);
          if (inner) {
            const body: string[] = [];
            index += 1;
            while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
              body.push(lines[index].trim());
              index += 1;
            }
            index += 1;
            segments.push({
              kind: "code",
              lang: inner[1],
              code: body.join("\n"),
            });
            continue;
          }
          if (!/^\s{2,}/.test(lines[index])) break;
          appendText(`\n${lines[index].trim()}`);
          index += 1;
        }
      }
      blocks.push({ kind: "list", nodes: buildListTree(items) });
      continue;
    }

    const paragraph: string[] = [];
    while (
      index < lines.length &&
      !blank(lines[index]) &&
      !isBlockStart(lines[index])
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    if (paragraph.length) {
      blocks.push({ kind: "paragraph", text: joinLines(paragraph) });
    }
  }

  return blocks;
}

const INLINE =
  /(`+)([^`]+?)\1|\*\*([\s\S]+?)\*\*|~~([\s\S]+?)~~|(?<![*\w])\*([^*\n]+)\*(?!\*)|(?<![_\w])_([^_\n]+)_(?![_\w])|\[([^\]\n]+)\]\(([^)\s]+)\)|\[([^\]\n]+)\]/g;

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = new RegExp(INLINE.source, "g");
  let cursor = 0;
  let key = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const [full, , code, bold, strike, italic, italicUnderscore, linkText, linkUrl, bracket] =
      match;
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));

    if (code !== undefined) {
      nodes.push(
        <code
          key={key++}
          className="rounded bg-secondary px-1 py-px font-mono text-[0.9em] text-foreground/90"
        >
          {code.trim()}
        </code>,
      );
    } else if (bold !== undefined) {
      nodes.push(
        <strong key={key++} className="font-semibold text-foreground">
          {renderInline(bold)}
        </strong>,
      );
    } else if (strike !== undefined) {
      nodes.push(
        <del key={key++} className="text-muted-foreground line-through">
          {renderInline(strike)}
        </del>,
      );
    } else if (italic !== undefined || italicUnderscore !== undefined) {
      nodes.push(
        <em key={key++} className="italic">
          {renderInline((italic ?? italicUnderscore)!)}
        </em>,
      );
    } else if (linkText !== undefined) {
      // 模型偶尔会写出 Python 下标写法 environ["x"](y)，只有真 http 链接才算链接。
      if (/^https?:\/\//i.test(linkUrl)) {
        nodes.push(
          <a
            key={key++}
            href={linkUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="text-chart-1 underline underline-offset-2"
          >
            {renderInline(linkText)}
          </a>,
        );
      } else {
        nodes.push(full);
      }
    } else if (bracket !== undefined) {
      if (CITATION.test(bracket)) {
        nodes.push(
          <span
            key={key++}
            className="rounded border border-chart-1/30 bg-chart-1/10 px-1 py-px font-mono text-[0.85em] text-chart-1"
          >
            {bracket}
          </span>,
        );
      } else {
        nodes.push(full);
      }
    }
    cursor = match.index + full.length;
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  return (
    <div className="my-2 overflow-hidden rounded-md border border-border/70 bg-secondary/50">
      {lang && (
        <div className="border-b border-border/60 px-3 py-1 font-mono text-[10px] tracking-wide text-muted-foreground uppercase">
          {lang}
        </div>
      )}
      <pre className="overflow-x-auto px-3 py-2 font-mono text-[11px] leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function renderSegments(segments: Segment[]): ReactNode[] {
  return segments.map((segment, index) =>
    segment.kind === "code" ? (
      <CodeBlock key={index} lang={segment.lang} code={segment.code} />
    ) : (
      <Fragment key={index}>{renderInline(segment.text)}</Fragment>
    ),
  );
}

function renderNodes(nodes: ListNode[]): ReactNode {
  // 同一层里混着有序和无序条目时按连续段拆开渲染，各自有各的标记。
  const groups: { ordered: boolean; items: ListNode[] }[] = [];
  for (const node of nodes) {
    const last = groups[groups.length - 1];
    if (last && last.ordered === node.ordered) last.items.push(node);
    else groups.push({ ordered: node.ordered, items: [node] });
  }

  return (
    <>
      {groups.map((group, groupIndex) => {
        const Tag = group.ordered ? "ol" : "ul";
        return (
          <Tag
            key={groupIndex}
            className={
              group.ordered
                ? "my-1.5 list-decimal space-y-1 pl-5 marker:text-muted-foreground"
                : "my-1.5 list-disc space-y-1 pl-5 marker:text-muted-foreground"
            }
          >
            {group.items.map((node, index) => (
              <li key={index} className="leading-7">
                {renderSegments(node.segments)}
                {node.children.length > 0 && (
                  <div className="mt-1 border-l border-border pl-3">
                    {renderNodes(node.children)}
                  </div>
                )}
              </li>
            ))}
          </Tag>
        );
      })}
    </>
  );
}

function renderBlock(block: Block, index: number): ReactNode {
  switch (block.kind) {
    case "heading": {
      if (block.level <= 1) {
        return (
          <h4 key={index} className="mt-4 mb-1.5 text-base font-semibold tracking-tight">
            {renderInline(block.text)}
          </h4>
        );
      }
      if (block.level === 2) {
        return (
          <h4
            key={index}
            className="mt-4 mb-1.5 flex items-center gap-2 text-sm font-semibold tracking-tight"
          >
            <span className="h-3.5 w-0.5 rounded-full bg-chart-1" />
            {renderInline(block.text)}
          </h4>
        );
      }
      return (
        <h5
          key={index}
          className="mt-3 mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
        >
          {renderInline(block.text)}
        </h5>
      );
    }
    case "code":
      return <CodeBlock key={index} lang={block.lang} code={block.code} />;
    case "list":
      return <Fragment key={index}>{renderNodes(block.nodes)}</Fragment>;
    case "quote":
      return (
        <blockquote
          key={index}
          className="my-2 border-l-2 border-chart-1/60 pl-3 text-muted-foreground"
        >
          {block.lines.map((line, lineIndex) => (
            <p key={lineIndex} className="leading-7">
              {renderInline(line)}
            </p>
          ))}
        </blockquote>
      );
    case "table":
      return (
        <div
          key={index}
          className="my-2 overflow-x-auto rounded-md border border-border/70"
        >
          <table className="w-full text-xs">
            <thead className="bg-secondary/50">
              <tr className="border-b border-border/70">
                {block.head.map((cell, cellIndex) => (
                  <th
                    key={cellIndex}
                    className="px-2.5 py-1.5 text-left font-semibold text-muted-foreground"
                  >
                    {renderInline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr
                  key={rowIndex}
                  className="border-b border-border/40 last:border-0"
                >
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} className="px-2.5 py-1.5 align-top leading-6">
                      {renderInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "hr":
      return <hr key={index} className="my-3 border-border" />;
    default:
      return (
        <p key={index} className="my-1.5 leading-7">
          {renderInline(block.text)}
        </p>
      );
  }
}

export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return (
    <div className="text-sm">
      {blocks.map((block, index) => renderBlock(block, index))}
    </div>
  );
}
