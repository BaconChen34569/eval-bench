# 站点设计：与竞品的差异与可优化点

> 调研对象：LangSmith、Braintrust、Langfuse、Phoenix（2026-11 检索）。
> 结论只针对**页面设计与信息组织**，不涉及功能优劣。

## 一、根本差异：我们是「一份报告」，他们是「一套工具」

竞品的页面范式是**多视图工具**：

- LangSmith：`Datasets → Experiments → 对比 → 单例详情`，左边是对象树，右边是详情面板
- Braintrust：评测为中心，实验对比视图 + 内置 scorer + CI gate
- Langfuse：`Trace → Observation → Generation/Span`，带 prompt 版本管理和自定义看板
- Phoenix：开源、OTel 生态、可视化 trace 图

它们的用户是**要反复回来的工程师**：跑一次实验 → 对比 → 调参 → 再跑。所以导航是按「对象」组织的（数据集/实验/trace），页面是可切换的视图。

我们是**单页叙事报告**：导航是按「论证顺序」组织的（为什么→实验→生成层→逐题→失败→信任→复现），一屏接一屏讲一个结论。

**这个差异不一定要改。** 评委只有几分钟，不可能先去建数据集再跑实验。叙事报告对"被讲清楚"更友好。真正要抄的是它们**在工具里沉淀下来的细节**（下面第三、四节），而不是它们的导航结构。

## 二、我们比竞品强的（不要在改造中弄丢）

竞品没有、我们有：

1. **judge 自检**——judge 给人工参考答案打分再对比人工分（一致率 100%，并主动暴露 judge 偏宽松：5.00 vs 4.40）。竞品的 scorer 是给分的，没人验证打分器本身准不准。
2. **按 ground truth 归因失败**——不采信模型自述，用"引用位置是否存在 + 检索是否命中"判定失败类型。竞品的失败标签基本来自 evaluator 的自由文本或规则。
3. **成本/延迟与精度的取舍叙事**——把 token 花费和延迟摆到和成功率同一张卡上。竞品的成本视图是独立的 dashboard，不参与结论。
4. **离线确定性层**——检索层不调模型，可复现，能干净隔离"切分策略"这一个变量。

## 三、我们缺、竞品有的（本轮已补的）

| 竞品特征 | 我们的状态 | 本轮处理 |
|---|---|---|
| 运行元信息（model / dataset / 时间戳 / 版本） | 完全没有，数字不知道在什么条件下跑出来的 | ✅ 新增「运行元信息」卡片：模型、题集、代码库规模、3 次运行的起止时间与成本明细表 |
| 单例的模型原始输出 + evaluator 反馈 | 只有检索结果，看不到模型到底答了什么 | ✅ 逐题生成层面板：judge 判语 + 原始回答 + 分数/召回/延迟/花费 |
| 实验间 diff（同一题在不同实验下的差异） | 只能整表对比，看不出"这题谁赢了" | ✅ 逐题新增三种策略并排对比表 |
| 实验对比矩阵（22×3 热力网格） | 完全没有 | ✅ 新增「胜负矩阵」：每行一题、每列一策略，格子是 judge 打分，横向看一行即知差异 |
| 图表的表格等价物（可访问性） | 只有 SVG/Canvas 柱状图，屏幕阅读器读不到数字 | ✅ 每张图下加可展开的「看数据表」 |
| 数据可导出/可复制 | 无 | ✅ 「数据」视图 + 「怎么复现」里的导出卡：逐题 CSV、策略总览 CSV、原始 report.json |

## 四、第二轮补齐的五项

第二轮把下面五项全部做掉，但**没有动叙事主线**——叙事视图仍然是默认首页，工具性的内容收进第二个视图里。

| 项 | 做法 | 位置 |
|---|---|---|
| 1. 多视图切换 | 导航右侧加「叙事 / 数据」双态切换。叙事是原来的长页面，数据是密集表格（策略总览 / 运行记录 / 胜负矩阵 / 逐题明细，带关键词筛选） | `site/components/eval/data-view.tsx` |
| 2. 成本核算的交互式说明 | 「成本怎么算的？」popover：按策略列出缓存命中输入 / 未命中输入 / 输出 token 与总成本，并说明 agent 与 judge 两次调用都计入 | `site/components/eval/cost-breakdown.tsx` |
| 3. 移动端导航折叠 | 窄屏把 7 个章节标签折成一个下拉（用短标签「为什么 / 切分对比 / 生成层 / 逐题 / 失败 / 信任 / 复现」），桌面仍保留横向标签 | `site/src/App.tsx` |
| 4. 深色模式 | 三态切换「自动 / 浅 / 深」，写入 localStorage；`index.html` 首帧前落好 `<html class="dark">` 避免刷新闪白；深色下品牌橙提亮一档保证图表可读 | `site/components/theme-toggle.tsx`、`site/src/globals.css` |
| 5. 数据导出 | 三个下载：逐题结果 CSV（22 题 × 3 策略 = 66 行）、策略总览 CSV、原始 report.json | `site/components/eval/export-buttons.tsx` |

同时按用户要求**移除了站内 logo 图形**（原 hero 与导航处的「指针 + 尺子」SVG），只保留浏览器标签图标——页面里不再重复出现品牌符号。

### 成本拆解的数据怎么来的

judge 那次调用的缓存命中 token 数报告里没有单独记，但可以反推：agent 侧成本由 token 数直接算出，judge 侧成本 = 总成本 − agent 成本；再解 `命中×0.02 + 未命中×1 = judge 输入成本`、`命中 + 未命中 = judge 输入 token`，
得到 66 条记录全部是落在 `judgePrompt` 区间内的非负整数（最大误差 0.0000），说明这个反推是精确的而不是近似拟合。

## 五、不建议做的

- **不要加登录、数据库、多租户**——那是给"要反复用的工程团队"准备的，评委只需要读懂结论，加了反而稀释重点。
- **不要为了像竞品而做实时 trace 视图**——我们的评测是离线跑完出报告的，没有 live trace 可看。做假的反而降低可信度。
- **不要引入第二个 UI 库**——现有 shadcn + Tailwind 的 token 体系已经够用。

## 六、改动清单

### 第一轮（竞品对标）

- `site/public/favicon.svg` + `favicon-32.png` + `apple-touch-icon.png`（浏览器标签图标，橙色卡尺几何）
- `site/index.html`：三处 icon link + theme-color
- `site/src/App.tsx`：新增「运行元信息」卡片（模型/题集/规模/运行时间表）
- `site/src/App.tsx`：新增「胜负矩阵」卡片（22 题 × 3 策略 judge 打分网格）
- `site/components/eval/outcome-matrix.tsx`（新增）：胜负矩阵组件
- `site/components/eval/strategy-charts.tsx`：两张图各加可展开数据表
- `site/components/eval/question-explorer.tsx`：逐题新增三种策略并排对比表
- `site/src/App.tsx`：导航高亮改为按滚动位置计算，修掉跳段与滚到底时高亮不更新
- `site/scripts/shot.mjs`：新增可选的截图前 JS 表达式参数，用于拍展开态

### 第二轮（补齐剩余五项）

- `site/components/theme-toggle.tsx`（新增）：三态主题 hook 与切换控件
- `site/src/globals.css`：`@custom-variant dark` + `.dark` 类驱动的深色 token
- `site/index.html`：首帧前的主题脚本，防刷新闪白
- `site/data/report.ts`：新增 `RunCase.tokens`、`PRICE`、`breakdownCost()`、`summarizeRun()`
- `site/components/eval/cost-breakdown.tsx`（新增）：成本口径 popover
- `site/components/eval/export-buttons.tsx`（新增）：CSV / JSON 导出
- `site/components/eval/data-view.tsx`（新增）：数据视图（策略总览 / 运行记录 / 胜负矩阵 / 逐题明细）
- `site/src/App.tsx`：视图切换、主题切换、移动端导航折叠、接入成本 popover 与导出卡、移除站内 logo 图形

