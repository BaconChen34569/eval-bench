import { useRef, useState } from "react";
import { Copy, Download, FileUp, Plus, Sparkles, Trash2 } from "lucide-react";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import {
  CATEGORY_LABEL,
  DIFFICULTY_LABEL,
  type Difficulty,
  type QuestionCategory,
} from "@/data/report";
import { copyText, downloadText } from "@/src/workbench/clipboard";
import { mergeQuestions, parseQuestionsFile } from "@/src/workbench/question-import";
import {
  QUESTION_TEMPLATE,
  TEMPLATE_FIELDS,
  buildPrompt,
} from "@/src/workbench/question-template";
import type { WorkDataset, WorkQuestion } from "@/src/workbench/api";

const CATEGORIES: QuestionCategory[] = [
  "architecture",
  "code-location",
  "debugging",
  "convention",
];

const DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard"];

/** 一页放几道题。 */
const PAGE_SIZE = 10;

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-muted-foreground">{hint}</span>}
    </label>
  );
}

function emptyQuestion(index: number): WorkQuestion {
  return {
    id: `q${String(index).padStart(2, "0")}`,
    question: "",
    category: "code-location",
    difficulty: "medium",
    reference: { answer: "", evidence: [], mustMention: [] },
  };
}

/**
 * 题集编辑器。
 *
 * 字段和 harness/src/schema.ts 一一对应：
 * 保存下来的 JSON 可以直接喂给 validate.ts 和 cli.ts。
 */
export function QuestionEditor({
  dataset,
  onChange,
}: {
  dataset: WorkDataset;
  onChange: (next: WorkDataset) => void;
}) {
  const [open, setOpen] = useState<string[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [page, setPage] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  const total = dataset.questions.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // 删题之后当前页可能越界，显示时按实际范围夹一下。
  const currentPage = Math.min(page, pageCount - 1);
  const pageStart = currentPage * PAGE_SIZE;
  const pageQuestions = dataset.questions.slice(
    pageStart,
    pageStart + PAGE_SIZE,
  );

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const parsed = parseQuestionsFile(await file.text());
      const questions = mergeQuestions(dataset, parsed.questions);
      onChange({
        ...dataset,
        id: dataset.id.trim() ? dataset.id : parsed.meta.id ?? dataset.id,
        repo: dataset.repo.trim() ? dataset.repo : parsed.meta.repo ?? dataset.repo,
        language: dataset.language.trim()
          ? dataset.language
          : parsed.meta.language ?? dataset.language,
        questions,
      });
      setNote(
        `从 ${file.name} 导入了 ${parsed.questions.length} 道题，现在共 ${questions.length} 道。`,
      );
    } catch (cause) {
      setNote(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const downloadTemplate = () => {
    // 说明也放进 JSON 里（顶层 _说明 字段），
    // 这样下载下来的文件直接就是合法 JSON，导入时这个字段会被忽略。
    const payload = JSON.stringify(
      {
        ...QUESTION_TEMPLATE,
        _说明: Object.fromEntries(
          TEMPLATE_FIELDS.map((item) => [item.field, item.note]),
        ),
      },
      null,
      2,
    );
    downloadText("questions-template.json", payload);
    setNote("模板已下载。填好证据行号后，用「导入题目」读回来。");
  };

  const copyPrompt = async () => {
    const prompt = buildPrompt(dataset.repo || "（仓库名）", 20);
    const ok = await copyText(prompt);
    setCopied(ok);
    setNote(
      ok
        ? "出题提示词已复制。粘给能读代码的模型，它会按同一套 JSON 结构吐题。"
        : "复制失败，浏览器没给剪贴板权限，手动选中提示词复制吧。",
    );
    if (ok) setTimeout(() => setCopied(false), 2000);
  };

  const updateQuestion = (index: number, patch: Partial<WorkQuestion>) => {
    const questions = dataset.questions.map((item, position) =>
      position === index ? { ...item, ...patch } : item,
    );
    onChange({ ...dataset, questions });
  };

  const updateReference = (
    index: number,
    patch: Partial<WorkQuestion["reference"]>,
  ) => {
    const current = dataset.questions[index];
    if (!current) return;
    updateQuestion(index, { reference: { ...current.reference, ...patch } });
  };

  const addQuestion = () => {
    const next = emptyQuestion(dataset.questions.length + 1);
    onChange({ ...dataset, questions: [...dataset.questions, next] });
    // 新题加在最后，页面跳到它所在的那一页。
    setPage(Math.floor(dataset.questions.length / PAGE_SIZE));
    setOpen((value) => [...value, `${next.id}-${dataset.questions.length}`]);
  };

  const removeQuestion = (index: number) => {
    onChange({
      ...dataset,
      questions: dataset.questions.filter((_, position) => position !== index),
    });
  };

  const duplicateQuestion = (index: number) => {
    const source = dataset.questions[index];
    if (!source) return;
    const copy: WorkQuestion = {
      ...source,
      id: `${source.id}-copy`,
      reference: {
        ...source.reference,
        evidence: source.reference.evidence.map((item) => ({ ...item })),
        mustMention: [...source.reference.mustMention],
      },
    };
    const questions = [...dataset.questions];
    questions.splice(index + 1, 0, copy);
    onChange({ ...dataset, questions });
    setOpen((value) => [...value, `${copy.id}-${index + 1}`]);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          共 {dataset.questions.length} 道题。证据行号必须真实存在，
          跑评测前先校验一遍。
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={downloadTemplate}>
            <Download className="mr-1 size-4" />
            下载模板
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void copyPrompt()}
          >
            <Sparkles className="mr-1 size-4" />
            {copied ? "已复制" : "复制出题提示词"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => fileRef.current?.click()}
          >
            <FileUp className="mr-1 size-4" />
            导入题目
          </Button>
          <Button size="sm" onClick={addQuestion}>
            <Plus className="mr-1 size-4" />
            加一道题
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(event) => void importFile(event.target.files?.[0])}
          />
        </div>
      </div>

      {note && <p className="text-xs text-muted-foreground">{note}</p>}

      <details className="rounded-lg border bg-card px-3 py-2">
        <summary className="cursor-pointer text-xs text-muted-foreground">
          模板里每个字段是干什么的
        </summary>
        <dl className="mt-2 grid gap-1 text-xs sm:grid-cols-[10rem_1fr]">
          {TEMPLATE_FIELDS.map((item) => (
            <div key={item.field} className="contents">
              <dt className="font-mono text-muted-foreground">{item.field}</dt>
              <dd>{item.note}</dd>
            </div>
          ))}
        </dl>
      </details>

      {dataset.questions.length === 0 && (
        <p className="rounded-lg border bg-card px-4 py-6 text-sm text-muted-foreground">
          还没有题目。三条路都行：先「下载模板」照着写；把出题提示词丢给模型
          生成，再用「导入题目」读回来；或者直接「加一道题」手写。
          写完记得填证据位置——行号必须真实存在。
        </p>
      )}

      <Accordion
        type="multiple"
        value={open}
        onValueChange={(value: string[]) => setOpen(value)}
        className="rounded-lg border bg-card px-4"
      >
        {pageQuestions.map((item, local) => {
          // 展开状态用全局题号做 key，翻页后还能保持展开。
          const index = pageStart + local;
          return (
          <AccordionItem key={`${item.id}-${index}`} value={`${item.id}-${index}`}>
            <AccordionTrigger>
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-muted-foreground">
                    {item.id}
                  </span>
                  <Badge variant="secondary">
                    {CATEGORY_LABEL[item.category]}
                  </Badge>
                  <Badge variant="outline">
                    {DIFFICULTY_LABEL[item.difficulty]}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {item.reference.evidence.length} 条证据
                  </span>
                </span>
                <span className="truncate text-sm">
                  {item.question || "（还没写问题）"}
                </span>
              </span>
            </AccordionTrigger>
            <AccordionContent>
              <div className="flex flex-col gap-3">
                <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
                  <Field label="题号">
                    <Input
                      value={item.id}
                      onChange={(event) =>
                        updateQuestion(index, { id: event.target.value })
                      }
                      className="font-mono"
                    />
                  </Field>
                  <Field label="问题">
                    <Textarea
                      value={item.question}
                      onChange={(event) =>
                        updateQuestion(index, { question: event.target.value })
                      }
                      className="min-h-16"
                    />
                  </Field>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="类别">
                    <NativeSelect
                      value={item.category}
                      onChange={(event) =>
                        updateQuestion(index, {
                          category: event.target.value as QuestionCategory,
                        })
                      }
                    >
                      {CATEGORIES.map((value) => (
                        <NativeSelectOption key={value} value={value}>
                          {CATEGORY_LABEL[value]}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </Field>
                  <Field label="难度">
                    <NativeSelect
                      value={item.difficulty}
                      onChange={(event) =>
                        updateQuestion(index, {
                          difficulty: event.target.value as Difficulty,
                        })
                      }
                    >
                      {DIFFICULTIES.map((value) => (
                        <NativeSelectOption key={value} value={value}>
                          {DIFFICULTY_LABEL[value]}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </Field>
                </div>

                <Field
                  label="标准答案"
                  hint="生成层评测时给模型看，judge 拿它当参考答案"
                >
                  <Textarea
                    value={item.reference.answer}
                    onChange={(event) =>
                      updateReference(index, { answer: event.target.value })
                    }
                    className="min-h-24"
                  />
                </Field>

                <Field
                  label="必须提到的要点"
                  hint="一行一个，judge 按语义覆盖判定，不要求原样出现"
                >
                  <div className="flex flex-col gap-2">
                    {item.reference.mustMention.map((point, pointIndex) => (
                      <div key={pointIndex} className="flex gap-2">
                        <Input
                          value={point}
                          onChange={(event) => {
                            const mustMention = [...item.reference.mustMention];
                            mustMention[pointIndex] = event.target.value;
                            updateReference(index, { mustMention });
                          }}
                        />
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label="删除要点"
                          onClick={() =>
                            updateReference(index, {
                              mustMention: item.reference.mustMention.filter(
                                (_, position) => position !== pointIndex,
                              ),
                            })
                          }
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    ))}
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-fit"
                      onClick={() =>
                        updateReference(index, {
                          mustMention: [...item.reference.mustMention, ""],
                        })
                      }
                    >
                      <Plus className="mr-1 size-4" />
                      加一条要点
                    </Button>
                  </div>
                </Field>

                <Field
                  label="证据位置"
                  hint="相对仓库根目录的路径和行号区间，行号必须真实存在"
                >
                  <div className="flex flex-col gap-2">
                    {item.reference.evidence.map((evidence, evidenceIndex) => (
                      <div
                        key={evidenceIndex}
                        className="grid gap-2 sm:grid-cols-[minmax(0,2fr)_5rem_5rem_minmax(0,1.4fr)_2rem]"
                      >
                        <Input
                          value={evidence.file}
                          placeholder="src/flask/app.py"
                          onChange={(event) => {
                            const evidenceList = item.reference.evidence.map(
                              (entry) =>
                                entry === evidence
                                  ? { ...entry, file: event.target.value }
                                  : entry,
                            );
                            updateReference(index, { evidence: evidenceList });
                          }}
                          className="font-mono text-xs"
                        />
                        <Input
                          type="number"
                          min={1}
                          value={evidence.startLine}
                          onChange={(event) => {
                            const evidenceList = item.reference.evidence.map(
                              (entry) =>
                                entry === evidence
                                  ? {
                                      ...entry,
                                      startLine: Number(event.target.value) || 1,
                                    }
                                  : entry,
                            );
                            updateReference(index, { evidence: evidenceList });
                          }}
                          className="font-mono text-xs"
                        />
                        <Input
                          type="number"
                          min={1}
                          value={evidence.endLine}
                          onChange={(event) => {
                            const evidenceList = item.reference.evidence.map(
                              (entry) =>
                                entry === evidence
                                  ? {
                                      ...entry,
                                      endLine: Number(event.target.value) || 1,
                                    }
                                  : entry,
                            );
                            updateReference(index, { evidence: evidenceList });
                          }}
                          className="font-mono text-xs"
                        />
                        <Input
                          value={evidence.symbol ?? ""}
                          placeholder="函数名（可空）"
                          onChange={(event) => {
                            const evidenceList = item.reference.evidence.map(
                              (entry) =>
                                entry === evidence
                                  ? { ...entry, symbol: event.target.value }
                                  : entry,
                            );
                            updateReference(index, { evidence: evidenceList });
                          }}
                          className="font-mono text-xs"
                        />
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label="删除证据"
                          onClick={() =>
                            updateReference(index, {
                              evidence: item.reference.evidence.filter(
                                (_, position) => position !== evidenceIndex,
                              ),
                            })
                          }
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    ))}
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-fit"
                      onClick={() =>
                        updateReference(index, {
                          evidence: [
                            ...item.reference.evidence,
                            { file: "", startLine: 1, endLine: 1 },
                          ],
                        })
                      }
                    >
                      <Plus className="mr-1 size-4" />
                      加一条证据
                    </Button>
                  </div>
                </Field>

                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => duplicateQuestion(index)}
                  >
                    <Copy className="mr-1 size-4" />
                    复制这道题
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => removeQuestion(index)}
                  >
                    <Trash2 className="mr-1 size-4" />
                    删掉这道题
                  </Button>
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>
          );
        })}
      </Accordion>

      {total > PAGE_SIZE && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2">
          <span className="text-xs text-muted-foreground">
            第 {currentPage + 1} / {pageCount} 页（第{" "}
            {pageStart + 1}-{Math.min(pageStart + PAGE_SIZE, total)} 题，共{" "}
            {total} 道）
          </span>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
            >
              上一页
            </Button>
            <NativeSelect
              value={String(currentPage)}
              onChange={(event) => setPage(Number(event.target.value))}
              className="w-28"
            >
              {Array.from({ length: pageCount }, (_, position) => (
                <NativeSelectOption
                  key={position}
                  value={String(position)}
                >
                  第 {position + 1} 页
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <Button
              size="sm"
              variant="outline"
              disabled={currentPage >= pageCount - 1}
              onClick={() => setPage(currentPage + 1)}
            >
              下一页
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
