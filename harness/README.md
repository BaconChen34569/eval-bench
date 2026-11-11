# harness · 课设 Copilot 评测台

这是「课设 Copilot」背后的评测流水线。它不是站点本身，而是**给站点供数的东西**：
站点的每一个数字都来自这里跑出来的 `out/report.json`。

## 两层评测

| 层 | 需要大模型吗 | 产出 | 作用 |
| --- | --- | --- | --- |
| 检索层 | 不需要 | recall@1/3/6、MRR、上下文体积 | 只改变量：切分策略。完全离线可复现 |
| 生成层 | 需要 | 成功率、平均 judge 分、延迟、成本 | 检索质量如何传导到最终回答 |

另外还有一层**judge 自检**：让 judge 去给人工写的参考答案打分，再和人工给同一份参考答案
打的分比较。如果 judge 连人写的标准答案都打不出人工给的水平，它给 Agent 打的分就没有理由被相信。

## 目录

```
datasets/flask.json      22 道人工标注的代码问答题，证据精确到行号
src/schema.ts            数据契约，站点和流水线共用这一份
src/cli.ts               命令行入口
src/chunk.ts             切分：固定窗口 / 函数级
src/repository.ts        仓库加载
src/retrieval.ts         BM25 检索 + 符号名加权重排
src/retrieval-eval.ts    检索层评测
src/ladder.ts            工具迭代阶梯：逐轮只改一个变量
src/runner.ts            单次运行：检索 → 生成 → judge → 归因
src/judge-validation.ts  judge 自检
src/judge.ts             LLM-as-judge
src/agent.ts             被评测的 agent：检索 + 一次 LLM 调用
src/failure.ts           失败归因：按 ground truth 判定失败类型
src/validate.ts          评测集证据校验器
scripts/probe-rerank.mts 离线比较不同重排方式的检索指标
scripts/summarize-report.mts 从报告里抽出写文章要用的数字
scripts/reclassify.ts    用新规则重算已有报告的失败归因，不重新调用模型
scripts/mock-llm.mjs     测试夹具：一个假的 OpenAI 兼容服务
```

`scripts/mock-llm.mjs` **不是用来造数据的**，它是测试夹具：在没有密钥的环境里
验证整条流水线（judge 解析、报告合并、站点渲染）能跑通。站点上展示的数字一律来自真实调用。

## 工具迭代阶梯

排行榜只能说「这个版本比那个版本好」。阶梯能说「收益来自哪一层」：
每轮继承上一轮，**只改一个变量**，然后用同一套协议重跑——同样 22 道题、同一个模型、
同一套 judge、同样 ≥4 分的成功线。

| 轮次 | 改了什么 | 变量 |
| --- | --- | --- |
| v1 | 起点：固定窗口 800 字符 + 纯 BM25 top-6 + 基准提示词 | — |
| v2 | 换切分方式 | 切分 |
| v3 | 换排序方式 | 重排 |
| v4 | 换 agent 提示词 | 提示词 |
| v5 | 放宽检索预算 | 预算 |

每一轮都会顺带算一遍检索层的证据召回率，这一层不调用模型，所以**完全免费且可复现**。
阶梯的说服力来自「检索层涨了 → 生成层跟着涨」这条因果链能对上。

### 复用旧结果之前，先看代码版本

`src/schema.ts` 里的 `CODE_VERSION` 是这套结果的身份证：切分或检索的实现一旦改动，
同一份配置跑出来的结果就不再相同，运行记录会带上当时的版本号。
复用旧记录前先比对版本号和题数，避免把「改代码之前的结果」当成「改之后的结果」写进阶梯。

改动 `chunk.ts` / `retrieval.ts` 的算法时，`CODE_VERSION` 必须手动 +1。

## 失败归因怎么判的

不采信 judge 的自由文本描述，按 ground truth 分三档：

| 类型 | 判定条件 | 该改什么 |
| --- | --- | --- |
| `hallucination` | 答案引用了仓库里不存在的文件，或行号超出文件长度 | 模型，得加约束或校验 |
| `wrong-location` | 检索一条人工标注的证据都没命中 | 检索策略 |
| `missing-detail` | 位置找到了但答案漏了要点 | 提示词和模型 |

定位错误和漏要点要修的地方完全不同：前者换检索方式，后者才轮到改提示词。
所以分类顺序是先判编造，再判定位，最后才归为漏要点。

## 命令

下面的命令按 bash 写成（用 `\` 续行）。**必须先 `cd harness`**：`.env` 和默认输出路径
`out/report.json` 都按当前工作目录算，在仓库根目录跑会读不到密钥，报告也会落到别处。

Windows 上把每条写成一行（不用 `\` 续行），路径里的 `/` 换成 `\` 或照抄都行——
Node 两种都吃。下面给的是 Windows 一份。

```bash
# 校验评测集：每条证据的行号必须真实存在
node --experimental-strip-types src/validate.ts datasets/flask.json ../corpus/repos/flask-3.1.3

# 检索层评测（不需要密钥）
node --experimental-strip-types src/cli.ts experiment \
  datasets/flask.json ../corpus/repos/flask-3.1.3 --out out/report.json

# 工具迭代阶梯：逐轮只改一个变量，同一套协议重跑
node --experimental-strip-types src/cli.ts ladder \
  datasets/flask.json ../corpus/repos/flask-3.1.3 --out out/report.json --reuse out/report.json

# 把上一版报告作为对照基线带进新报告，站点据此展示优化前后
node --experimental-strip-types src/cli.ts ladder \
  datasets/flask.json ../corpus/repos/flask-3.1.3 --out out/report.json \
  --reuse out/report.json --baseline out/report-previous.json

# 列出账号可用的模型 id，确认该填哪个模型名
node --experimental-strip-types src/cli.ts models

# 看当前生效的单价和它来自哪里（内置价目表还是 .env）
node --experimental-strip-types src/cli.ts pricing

# 换一个被测模型跑一轮（语料、检索链路、judge 全部不变）
node --experimental-strip-types src/cli.ts run \
  datasets/flask.json ../corpus/repos/flask-3.1.3 function-level --model qwen

# 几道题同时问：整体更快。不给 --concurrency 就是 1 路，和以前一样
node --experimental-strip-types src/cli.ts run \
  datasets/flask.json ../corpus/repos/flask-3.1.3 function-level --concurrency 4

# 改了失败归因规则后，重算已有报告的归因（不重新调用模型）
node --experimental-strip-types scripts/reclassify.ts \
  out/report.json ../corpus/repos/flask-3.1.3

# 起本地工作台：打开就是填数据和看结果，不用先读一遍介绍
node --experimental-strip-types src/cli.ts serve --port 8787
```

### Windows 一份（cmd / PowerShell 都能用）

```cmd
cd harness
node --experimental-strip-types src/validate.ts datasets/flask.json ../corpus/repos/flask-3.1.3
node --experimental-strip-types src/cli.ts experiment datasets/flask.json ../corpus/repos/flask-3.1.3 --out out/report.json
node --experimental-strip-types src/cli.ts models
node --experimental-strip-types src/cli.ts pricing
node --experimental-strip-types src/cli.ts serve --port 8787
```

### 多次跑会不会覆盖

不会丢。`out/report.json` 是当前这一版，但每次写报告都会在 `out/history/`
留一份带时间戳的副本，终端上也会打印副本路径：

```
报告已写入 out\report.json
历史副本：out\history\report-2026-11-09T10-01-33-123Z.json
```

想翻旧结果就从 `out/history/` 里挑。

`serve` 需要先把页面构建出来（只做一次）：

```bash
cd site && npm ci && npm run build
```

服务只监听 `127.0.0.1`。两个地址：`/` 是工作台（填数据、录题集、跑评测），
`/story` 是叙事版（和线上站同一份构建产物）。

## 本地工作台的接口

工作台页面本身不含评测逻辑，它调的是这几个接口，接口背后就是命令行走的那套代码：

| 接口 | 作用 |
| --- | --- |
| `GET /api/health` | 代码版本、默认仓库路径、可用题集列表 |
| `GET /api/dataset?id=...` | 取一套题集（按 id 或文件名都能找到） |
| `GET /api/reports` | 列出 `out/` 里的评测产物（含 `history/` 里的历史副本），标出哪些能直接载入出图 |
| `GET /api/report?file=...` | 读一份评测产物 |
| `POST /api/validate` | 校验证据行号，回传问题和提示 |
| `POST /api/evaluate` | 跑检索层评测，回传三种切分策略的指标 |
| `GET /api/gen/options` | 可用的模型档案和阶梯轮次，页面用它填生成层的表单 |
| `POST /api/gen/start` | 起一个生成层任务（单模型 / 迭代阶梯 / 多模型对比），回传 jobId |
| `GET /api/gen/job?id=...` | 查生成层任务的进度、日志和最终报告 |
| `GET /api/gen/running` | 查当前正在跑的任务（没有就是 null），页面刷新后靠它接上进度 |
| `POST /api/save-dataset` | 把页面上的题集存回 `datasets/`（带 `file` 字段时写回指定文件） |
| `GET /api/dirs?path=...` | 列目录（只给目录项），标出哪些像代码仓库 |
| `GET /api/secrets` | 看 `.env` 里有哪些模型档案、哪些字段缺了 |
| `POST /api/secrets` | 写入密钥/接口地址/模型名到 `.env` |
| `DELETE /api/secrets` | 清掉某个档案的密钥 |
| `POST /api/secrets/test` | 用当前配置（档案 + 临时密钥/接口地址/模型）真的问一次模型，看这套配置能不能用；`useStoredKey: true` 时改用 `.env` 里存着的密钥 |
| `GET /api/secrets/models?baseUrl=...` | 这家厂商已知的模型列表，不需要密钥 |
| `POST /api/secrets/models` | 用密钥向服务商要一份最新的模型列表 |
| `GET /api/secrets/price?model=...` | 查一个模型 id 的单价，用来看手填的模型要不要花钱 |

`/api/evaluate` 走的是 `runRetrievalEval`，和 `experiment` 命令同一条代码路径，
所以工作台上的召回率和命令行跑出来的数字必然一致。
写题集这一步故意留在页面上：证据要精确到行号，对着源码改比对着 JSON 改快。
`/api/reports` 和 `/api/report` 只读 `out/` 目录以内的文件，路径越界会被拒绝。

生成层要真的调模型，一轮就是几分钟，HTTP 请求等不起，
所以走「起一个任务 + 轮询状态」：`POST /api/gen/start` 起任务，
`GET /api/gen/job` 拿进度和最终报告。任务背后是 `runEvaluation`、
`runLadder`、`runComparison`——和命令行的 `experiment` / `ladder` / `compare`
是同一套代码，出来的数字可以直接和站上已发布的数字对照。
一次只允许一个任务在跑（每跑一次都是真花钱）。
结果会额外存一份带时间戳的副本到 `out/`，不覆盖命令行跑出来的 `report.json`。

服务的进度不只是日志行。每种跑法都先列一份阶段计划（哪一阶段、多少题、
每题几次模型请求），跑起来之后按题累加成百分比，所以页面能给出
「跑到第几题、还剩多少、已经花了多少次模型请求」。
`GET /api/gen/running` 让刷新后的页面接上还在跑的任务，进度不丢。

### 慢在哪儿：并发与自检复用

生成层的时间几乎全花在等模型解码上：一道题 19 秒，其中被测模型答一次 13 秒、
judge 再打一次 5.7 秒，而输入大小几乎不影响耗时。两处改动能把等待压下去：

**并发跑题。** 页面上的「同时问几道题」（命令行是 `--concurrency N`）让几道题
一起问，整体时间就从「所有题加起来」变成「最慢的那道题」。命令行的默认仍然是
1（一题一题来），所以命令行输出和以前一模一样；页面默认 4 路。
并发只影响什么时候拿到结果，报告里的题目顺序和分数不受影响。
服务商限流（429）时客户端会多等几秒再试，实在过不去就把并发调低一档。

**judge 自检复用。** 自检的结论只跟三件事有关：哪把尺子、考的哪批题、哪一版代码。
这三样都没变的话，上次跑出来的结果就是这次的结果——所以工作台会把它记在
`out/.judge-checks.json` 里，下次直接用，不再花模型请求，日志里会写明
「复用 … 的结果」。换了尺子、换了题或者改了打分口径，指纹就变，自检照跑。

模型列表和测连通是两件事：选模型用的是内置的厂商型号表（`src/vendors.ts`），
不用密钥也能列；「测试连通」才是拿当前配置真去问一次模型，
接口地址、密钥、模型 id 三样都要对才算通过。

表单里的「测试连通」只认这一次填的密钥，不会拿 `.env` 里存着的旧密钥去问：
前缀撞上已存在的档案时，没填密钥就是「还没填密钥」，不会替用户借一把旧的来答。
要测 `.env` 里存好的那个档案，用档案列表那一行的「测试」
（接口上传 `useStoredKey: true`）。「拉取最新列表」不花钱，所以它允许借用存着的密钥，
借用了会在返回里带 `usedStoredKey: true`，页面据此说明用的是 `.env` 里那把。

密钥相关的接口不回显密钥内容：状态接口只给「配没配 / 缺哪个字段」，
写完之后密钥只留在 `.env` 里（文件权限 600，已被 `.gitignore` 忽略）。
`/api/secrets/test` 和 `POST /api/secrets/models` 允许临时传一个密钥、接口地址和模型，
但不会把它们写进文件——第一次配一家新服务商时，页面上的接口地址就是靠这条路送到服务端的。
所有接口都要求 Host 是 `127.0.0.1`/`localhost`，并且拒绝来自其他页面的跨站请求。

## 配置模型

复制 `.env.example` 为 `.env` 后填写。`.env` 已被 `.gitignore` 忽略，
**密钥不要提交，也不要贴进任何对话或命令行**。

| 系统 | 命令（在 `harness` 目录里执行） |
| --- | --- |
| Windows | `copy .env.example .env` |
| macOS / Linux | `cp .env.example .env` |

cmd 里没有 `cp`，照抄 Linux 命令会报「不是内部或外部命令」。

一个**档案**就是一组带前缀的环境变量 = 一家 OpenAI 兼容服务商：

```bash
# 默认档案（前缀 LLM_）
LLM_PROFILE=deepseek          # 命令行里用的名字
LLM_LABEL=DeepSeek            # 站上展示用的名字
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_API_KEY=sk-...
LLM_MODEL=deepseek-flash
LLM_TEMPERATURE=0             # 推理模型请留空，它不支持这个参数
LLM_PRICE_CURRENCY=¥

# 第二家（前缀随便起，比如 QWEN_）
QWEN_PROFILE=qwen
QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
QWEN_API_KEY=sk-...
QWEN_MODEL=qwen-plus
```

前缀决定档案归谁管，代码里没有写死是哪几家——想加第四家（比如 Kimi），
在 `.env` 里照抄一段改个前缀就行，评测逻辑一行都不用动。
跑 `cli.ts models` 可以看到 `.env` 里到底有哪些档案、各自接口上有哪些模型 id。
服务商的 `/models` 有些免费模型不列（智谱就是），命令会把 `src/vendors.ts` 里
已知的那些补上，所以免费型号不会凭空消失。

任何 OpenAI 兼容接口都可以用：DeepSeek、阿里云百炼、智谱、Kimi、本地 vLLM。

**单模型跑评测只要一组配全就够，不必是 DeepSeek。** 命令行不给 `--model` 时，
挑的是 `.env` 里第一组配置完整的档案（默认档案 `LLM_` 优先）。
只有多模型对比才要求两家及以上——不足两家时 `compare` 会直接报错并告诉你缺哪一组。

## 多模型对比：证明这把尺子有区分度

一套评测台如果给强模型和弱模型打出同样的分，那它测的其实不是模型。
所以同一份语料、同一套检索链路、同一份配置，换几个模型各跑一轮，
就能看出这套评测台到底能不能分辨出模型的好坏——以及不同模型的失败长什么样。

`compare` 命令把这件事一次做完：

```bash
node --experimental-strip-types src/cli.ts compare \
  datasets/flask.json ../corpus/repos/flask-3.1.3 \
  --report out/report-r3.json --report-out out/report-r4.json \
  --out out/comparison.json
```

它做三件事：

1. **所有被测模型跑同一份配置**（默认取阶梯的最后一轮，和站上已发布的数字同配置）。
2. **主尺子量所有模型**。`--judges` 的第一个是主尺子，其余尺子对**同一批答案**重新打分——
   答案一个字都不动，只有打分的人换人。这样两个尺子的分差就是尺子的误差。
3. **算出一致率与自评偏袒**：两把尺子差 1 分以内的比例、达标判定被翻转的题数，
   以及每把尺子给本家模型打的分比给别家高多少。

`--agents` / `--judges` 用逗号分隔档案 id，不给就用 `.env` 里全部配置完整的档案：

```bash
node --experimental-strip-types src/cli.ts compare \
  datasets/flask.json ../corpus/repos/flask-3.1.3 \
  --agents deepseek,qwen,glm --judges deepseek,glm
```

结果里的 `modelComparison` 会写进 `--report-out` 指定的报告文件，站点从那里读。

两点要注意：

- **复用旧记录时必须同模型。** 换模型就是换被测对象，上一个模型的运行记录不会被复用，
  否则等于什么都没测。judge 同理：换了打分模型，分数不在同一把尺子上，也不能复用。
  `compare` 会自动复用配置、模型、尺子、代码版本都一致的旧记录（比如阶梯的最后一轮）。
- **judge 可以单独指定。** 默认 judge 就是被测模型自己打分，这在小样本上问题不大，
  但多模型对比时会变成显眼靶子。用 `--judge-model` 换成别家模型来打分，
  被测模型的 token 按它的单价算，judge 的 token 按 judge 的单价算：

  ```bash
  node --experimental-strip-types src/cli.ts run \
    datasets/flask.json ../corpus/repos/flask-3.1.3 function-level \
    --model qwen --judge-model glm --out out/run-qwen-judged-by-glm.json
  ```


## 在 Windows 上跑

harness 本身是跨平台的（零第三方依赖，Node 22.13+ 即可），但有几个系统差异会绊人：

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `cp` 不是内部或外部命令 | `cp` 是 Linux/macOS 的命令，cmd 和 Windows 都没有 | 改用 `copy`：`copy .env.example .env`、`copy out\report.json ..\site\data\report.json` |
| 中文输出乱码 | Windows PowerShell 5.1 控制台默认 GBK，Node 打印的是 UTF-8 | 先执行 `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8`，或改用 PowerShell 7 / Windows Terminal |
| 红色 `NativeCommandError` | `node --experimental-strip-types` 往 stderr 写一行 ExperimentalWarning，PowerShell 5.1 把它渲染成错误记录 | 假警报，看后面的输出判断成败 |
| 命令续行 | PowerShell 用反引号、cmd 用 `^`、bash 用 `\` | 写成一行最省事；用反引号续行时反引号后面不能有空格 |
| 拉语料 | bash 版脚本在 Windows 上要么没 bash、要么 Git Bash 的 tar 行为不一致 | 用 `corpus\fetch.ps1`（PowerShell 版，输出与 bash 版逐字节一致） |

`copy` 在 cmd 和 PowerShell 里都能用（PowerShell 里它是 `Copy-Item` 的别名），
只是 cmd 在目标文件已存在时会问一次要不要覆盖，按 Y 即可。

`corpus\fetch.ps1` 要存成**带 BOM 的 UTF-8**：PowerShell 5.1 按 ANSI（GBK）读没有 BOM 的
`.ps1`，文件里的中文注释会直接报 ParserError。

## 成本是怎么算的

**单价不用手填。** 内置了一张价目表（DeepSeek、智谱 GLM、通义千问的官方价目，
含智谱那几个明确免费的 flash 模型），`.env` 里没写 `*_PRICE_*` 时就按内置价目算；
写了则以 `.env` 为准。
`node --experimental-strip-types src/cli.ts pricing` 会列出每个档案当前生效的单价
和它的来源（内置表 / `.env` / 没有）。

价目表的数字来自各家官方价目页（`harness/src/pricing.ts` 里写了出处和核对日期），
单位是元 / 百万 token。查不到的模型 id 按「没有单价」处理——
宁可让用户在 `.env` 里补一个真的数字，也不给一个错的。

单价按**每百万 token** 填，三个价目：

| 变量 | 含义 |
| --- | --- |
| `LLM_PRICE_PROMPT` | 输入未命中缓存的价格 |
| `LLM_PRICE_PROMPT_CACHE_HIT` | 输入命中缓存的价格（留空则按未命中算） |
| `LLM_PRICE_COMPLETION` | 输出价格 |

DeepSeek 的 `usage` 会返回 `prompt_cache_hit_tokens` 和 `prompt_cache_miss_tokens`，
所以缓存部分按真实命中量折算，不是一刀切。

一题的成本 = **agent 回答一次 + judge 打分一次**，两次调用都计入。
judge 自检那一轮的花费不计入单题成本，但会体现在总调用量上。

DeepSeek 高峰时段（北京时间周一至周五 9:00-12:00、14:00-18:00）单价为闲时的两倍，
`.env` 里填的是闲时价，所以跑在高峰时段时实际账单会更高。

