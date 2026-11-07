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

# 换一个被测模型跑一轮（语料、检索链路、judge 全部不变）
node --experimental-strip-types src/cli.ts run \
  datasets/flask.json ../corpus/repos/flask-3.1.3 function-level --model qwen

# 改了失败归因规则后，重算已有报告的归因（不重新调用模型）
node --experimental-strip-types scripts/reclassify.ts \
  out/report.json ../corpus/repos/flask-3.1.3
```

## 配置模型

复制 `.env.example` 为 `.env` 后填写。`.env` 已被 `.gitignore` 忽略，
**密钥不要提交，也不要贴进任何对话或命令行**。

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

任何 OpenAI 兼容接口都可以用：DeepSeek、阿里云百炼、智谱、Kimi、本地 vLLM。

## 多模型对比：证明这把尺子有区分度

一套评测台如果给强模型和弱模型打出同样的分，那它测的其实不是模型。
所以同一份语料、同一套检索链路、同一把尺子，换几个模型各跑一轮，
就能看出这套评测台到底能不能分辨出模型的好坏——以及不同模型的失败长什么样。

```bash
# 每个模型各跑一轮，最终配置（函数级切分 + 结构感知重排 + 术语桥）
node --experimental-strip-types src/cli.ts run \
  datasets/flask.json ../corpus/repos/flask-3.1.3 function-level --model deepseek --out out/run-deepseek.json
node --experimental-strip-types src/cli.ts run \
  datasets/flask.json ../corpus/repos/flask-3.1.3 function-level --model qwen --out out/run-qwen.json
node --experimental-strip-types src/cli.ts run \
  datasets/flask.json ../corpus/repos/flask-3.1.3 function-level --model glm --out out/run-glm.json

# 合并成一份汇总
node --experimental-strip-types src/cli.ts report \
  out/run-deepseek.json out/run-qwen.json out/run-glm.json --out out/report-multi.json
```

汇总出来的 `runs` 里同一个切分方式会有多条（每个模型一条），而站点的策略矩阵是按切分方式取列的，
所以这份汇总**不能直接替换** `out/report.json`——站上多模型那一段要单独从汇总里取数据。

两点要注意：

- **复用旧记录时必须同模型。** 换模型就是换被测对象，上一个模型的运行记录不会被复用，
  否则等于什么都没测。judge 同理：换了打分模型，分数不在同一把尺子上，也不能复用。
- **judge 可以单独指定。** 默认 judge 就是被测模型自己打分，这在小样本上问题不大，
  但多模型对比时会变成显眼靶子。用 `--judge-model` 换成别家模型来打分，
  被测模型的 token 按它的单价算，judge 的 token 按 judge 的单价算：

  ```bash
  node --experimental-strip-types src/cli.ts run \
    datasets/flask.json ../corpus/repos/flask-3.1.3 function-level \
    --model qwen --judge-model glm --out out/run-qwen-judged-by-glm.json
  ```


## 成本是怎么算的

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

