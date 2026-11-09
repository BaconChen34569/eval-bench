/**
 * 出题模板。
 *
 * 录题最花时间的是想清楚「这个问题在代码里对应哪几行」，
 * 所以这里给出两份东西：一份能直接下载的 JSON 骨架，
 * 一份能让模型照着产出这套 JSON 的提示词。
 */

export interface QuestionTemplate {
  id: string;
  repo: string;
  language: string;
  createdAt: string;
  questions: Array<{
    id: string;
    question: string;
    category: string;
    difficulty: string;
    reference: {
      answer: string;
      evidence: Array<{
        file: string;
        startLine: number;
        endLine: number;
        symbol: string;
      }>;
      mustMention: string[];
    };
  }>;
}

/** 空骨架：字段齐全、内容待填，下载下来照着改就能用。 */
export const QUESTION_TEMPLATE: QuestionTemplate = {
  id: "my-dataset",
  repo: "Flask 3.1.3",
  language: "python",
  createdAt: "2026-01-01",
  questions: [
    {
      id: "q01",
      question: "应用工厂 create_app 在哪里定义？它怎么把配置传给各个扩展？",
      category: "code-location",
      difficulty: "medium",
      reference: {
        answer:
          "create_app 定义在 src/flask/app.py 里，它先建一个 Flask 实例，"
          + "再用 from_object 读配置，最后把扩展挂到 app 上。",
        evidence: [
          {
            file: "src/flask/app.py",
            startLine: 221,
            endLine: 260,
            symbol: "create_app",
          },
        ],
        mustMention: [
          "创建一个 Flask 实例",
          "用 from_object 读配置",
          "把扩展挂到 app 上",
        ],
      },
    },
    {
      id: "q02",
      question: "请求上下文是怎么压栈和弹栈的？",
      category: "architecture",
      difficulty: "hard",
      reference: {
        answer:
          "每次请求进来时 _push_request 把 RequestContext 压进 _request_ctx_stack，"
          + "处理完在 finally 里 _pop_request 弹出。",
        evidence: [
          {
            file: "src/flask/ctx.py",
            startLine: 40,
            endLine: 60,
            symbol: "_push_request",
          },
          {
            file: "src/flask/ctx.py",
            startLine: 150,
            endLine: 175,
            symbol: "_pop_request",
          },
        ],
        mustMention: ["压栈 _request_ctx_stack", "finally 里弹栈"],
      },
    },
  ],
};

/** 模板里的字段说明，下载的 JSON 旁边也带着一份，省得回头查文档。 */
export const TEMPLATE_FIELDS: Array<{ field: string; note: string }> = [
  { field: "id", note: "题号，全套题集里唯一，命令行按它关联结果" },
  { field: "question", note: "问题正文，一句话说清要找什么" },
  {
    field: "category",
    note: "architecture / code-location / debugging / convention 四选一",
  },
  { field: "difficulty", note: "easy / medium / hard 三选一" },
  {
    field: "reference.answer",
    note: "标准答案，给 judge 当参考答案看",
  },
  {
    field: "reference.evidence",
    note: "证据位置：相对仓库根目录的路径 + 行号区间，行号必须真实存在",
  },
  {
    field: "reference.mustMention",
    note: "必须覆盖的语义要点，judge 按语义判定，不要求原样出现",
  },
];

/**
 * 给模型的出题提示词。
 *
 * 粘给任意一个能读代码的模型，它就会按同样的结构吐出 JSON，
 * 用户再拿回工作台审一遍行号对不对。
 */
export function buildPrompt(repoName: string, count: number): string {
  return [
    `你是一个代码检索评测集的出题人。请阅读仓库 ${repoName} 的源码，产出 ${count} 道问题。`,
    "",
    "要求：",
    "1. 每道题都要能在仓库里找到确定答案，不问需要运行程序才能回答的问题。",
    "2. reference.evidence 里的 file / startLine / endLine 必须真实存在，",
    "   行号要指向真正实现该功能的代码，不要指向注释或空行。",
    "3. question 用中文，一句话说清要找什么，不要出现「你觉得」这类开放问题。",
    "4. reference.answer 是给 judge 看的参考答案，写清实现要点，不要复制大段代码。",
    "5. reference.mustMention 写 2-4 个必须覆盖的语义要点。",
    "6. category 只能是 architecture / code-location / debugging / convention。",
    "7. difficulty 只能是 easy / medium / hard。",
    "",
    "只输出 JSON，不要任何解释文字，格式严格如下：",
    JSON.stringify(QUESTION_TEMPLATE, null, 2),
  ].join("\n");
}
