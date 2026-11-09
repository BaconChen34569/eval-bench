import { useState } from "react";
import { Copy, Plus, Trash2 } from "lucide-react";

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
import type { WorkDataset, WorkQuestion } from "@/src/workbench/api";

const CATEGORIES: QuestionCategory[] = [
  "architecture",
  "code-location",
  "debugging",
  "convention",
];

const DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard"];

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
    setOpen((value) => [...value, next.id]);
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
    setOpen((value) => [...value, copy.id]);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          共 {dataset.questions.length} 道题。证据行号必须真实存在，
          跑评测前先校验一遍。
        </p>
        <Button size="sm" variant="outline" onClick={addQuestion}>
          <Plus className="mr-1 size-4" />
          加一道题
        </Button>
      </div>

      {dataset.questions.length === 0 && (
        <p className="rounded-lg border bg-card px-4 py-6 text-sm text-muted-foreground">
          还没有题目。先加一道：写清问题、标准答案和证据位置。
        </p>
      )}

      <Accordion
        type="multiple"
        value={open}
        onValueChange={(value: string[]) => setOpen(value)}
        className="rounded-lg border bg-card px-4"
      >
        {dataset.questions.map((item, index) => (
          <AccordionItem key={`${item.id}-${index}`} value={`${item.id}-${index}`}>
            <AccordionTrigger>
              <span className="flex min-w-0 flex-col gap-1">
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
        ))}
      </Accordion>
    </div>
  );
}
