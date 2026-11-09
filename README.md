# 课设 Copilot 评测台

给「课设 Copilot」用的评测流水线。别人交「我做了个 agent」，这里交的是
**「我能量化我的 agent，并且展示它在哪失败」**。

在线版：https://copilot-eval-bench-fzlro45ljfz.qoder.zone

代码仓库：https://github.com/BaconChen34569/eval-bench

## 这个东西在做什么

课设 Copilot 的意思是：让 AI 按你的要求写一份课设。但「写得好不好」一直是句空话。
这个仓库把「好不好」变成一组能被重新算出来的数字：

| 层 | 需要大模型吗 | 产出 | 作用 |
| --- | --- | --- | --- |
| 检索层 | 不需要 | recall@1/3/6、MRR、上下文体积 | 只改变量：切分策略。完全离线可复现 |
| 生成层 | 需要 | 成功率、平均 judge 分、延迟、成本 | 检索质量如何传导到最终回答 |
| judge 自检 | 需要 | judge 与人工打分的一致率 | 验证打分器本身可不可信 |

## 目录

```
harness/          评测流水线（TypeScript，零第三方依赖）
  datasets/       人工标注的题集，证据精确到行号
  src/            检索、切分、生成、judge、归因、阶梯
  scripts/        离线探针与报告摘要
corpus/           被测仓库的拉取脚本（版本固定）
site/             评测台站点（React + Vite + Tailwind）
docs/             设计分析、天池投稿
```

## 跑起来

Windows（cmd / PowerShell）和 macOS / Linux 的命令不一样，分开给。
完整步骤（每条都能单独复制）见线上站的「怎么复现」一节。

### Windows

```cmd
git clone https://github.com/BaconChen34569/eval-bench.git
cd eval-bench
powershell -ExecutionPolicy Bypass -File corpus\fetch.ps1
cd harness
node --experimental-strip-types src/cli.ts experiment datasets/flask.json ../corpus/repos/flask-3.1.3 --out out/report.json
```

### macOS / Linux

```bash
git clone https://github.com/BaconChen34569/eval-bench.git
cd eval-bench
bash corpus/fetch.sh
cd harness
node --experimental-strip-types src/cli.ts experiment \
  datasets/flask.json ../corpus/repos/flask-3.1.3 --out out/report.json
```

没装 git 就用仓库页的 Code → Download ZIP，解压后进到 `eval-bench` 目录，
后面的命令都在这个目录或它的子目录下执行。语料脚本在根目录，评测命令在 `harness` 里。

两个拉取脚本产出的语料逐字节一致，系统差异见
[harness/README.md](harness/README.md#在-windows-上跑)。

**不需要密钥**：这时只跑检索层，报告里不会出现生成层数字。

### 配密钥（选填）

只在 harness 目录里做一次：

| 系统 | 命令 |
| --- | --- |
| Windows | `copy .env.example .env` |
| macOS / Linux | `cp .env.example .env` |

cmd 里没有 `cp`，照抄 Linux 命令会报「不是内部或外部命令」。

填任意一家服务商的 `*_API_KEY` 就行（DeepSeek、阿里云百炼、智谱、Kimi、本地 vLLM，
只要是 OpenAI 兼容接口）。**单模型跑评测只要一组配全就够，不必是 DeepSeek**；
多模型对比要两家及以上各配一组密钥。

不想碰命令行文件的话，先起本地工作台，在「模型密钥」这一页填进去保存，
它会写回同一个 `harness/.env`，命令行和工作台共用一份配置。

单价不用手填：内置价目表会兜底，`.env` 里写了 `*_PRICE_*` 才覆盖它。
想看当前生效的单价和它来自哪里：

```bash
node --experimental-strip-types src/cli.ts pricing
```

要跑多模型对比（同一套题换几个模型各跑一轮，看评测台能不能区分出模型好坏），
一条命令把「换模型 + 换尺子重打分 + 算一致率」全做完：

```bash
node --experimental-strip-types src/cli.ts compare \
  datasets/flask.json ../corpus/repos/flask-3.1.3 \
  --report out/report.json --report-out out/report.json
```

写法见 [harness/README.md](harness/README.md)。

### 多次跑会不会覆盖

不会丢。`out/report.json` 是当前这一版，但每次写报告都会在 `out/history/`
留一份带时间戳的副本（`report-2026-11-09T10-01-33.json` 这样的名字），
终端上也会打印副本路径。想翻旧结果就从 `out/history/` 里挑。

站点：

```bash
cd site && npm ci && npm run dev
```

## 换成自己的课设仓库

改两处即可：题集放 `harness/datasets/`，被测仓库换个路径。
评测逻辑一行都不用动。题集怎么写见 [harness/README.md](harness/README.md)。

## 用站点看自己的数据

站点的数据层和视图层是分开的：`site/src/App.tsx` 只读 `site/data/report.json`，
这份文件就是 harness 的 `out/report.json`。

```bash
cd harness && node --experimental-strip-types src/cli.ts experiment \
  datasets/flask.json ../corpus/repos/flask-3.1.3 --out out/report.json
cp out/report.json ../site/data/report.json
cd ../site && npm run dev
```

Windows 上第 2 行换成 `copy out\report.json ..\site\data\report.json`（cmd 没有 `cp`）。

站点展示的官方数字只有一份来源，就是仓库里的这份 `report.json`。
线上站点不提供上传入口——页面上每个数字必须能指向唯一一份报告，
这样任何人都能用同一套题、同一个模型把数字重算一遍。

站点上的「优化前后」一节对比的是上一版评测台的结果。
它不是手写的数字，而是把上一版报告原样带进新报告：

```bash
node --experimental-strip-types src/cli.ts ladder \
  datasets/flask.json ../corpus/repos/flask-3.1.3 --out out/report.json \
  --reuse out/report.json --baseline out/report-previous.json
```

## 本地工作台：填数据出图，不用先读介绍

线上站是给评委看的叙事页；本地工作台是给你自己用的工具页，
打开就能粘数据看结果，或者直接录一套题跑检索评测。

```bash
cd site && npm ci && npm run build:local   # 构建工作台页面（只做一次）
cd ../harness && node --experimental-strip-types src/cli.ts serve
```

然后打开 http://127.0.0.1:8787/ ：

- **填数据出图**：把 `report.json` 粘进去（或选文件），下面的表格和图表立刻换成这份数据；
- **录题集跑评测**：选一套题集或新建一套，校验证据行号，然后跑检索评测，
  结果直接进到同一套图表里；
- **模型密钥**：在页面上填服务商密钥，存进本地 `harness/.env`，
  顺手点「测试连通」验证能不能调通，不用手改文件。

前两个模块的结果各归各的：贴进来的报告和跑出来的评测不混在一起，
「录题集跑评测」还没跑过时，那一栏是空的，不会拿别人的结果充数。

密钥页测连通之后，「模型」会变成这家厂商的可用模型下拉框，
要花钱的模型前面标一个 ¥（价格取自 harness 的内置价目表，查不到就不标）。

被测仓库的路径不用手打绝对路径，点「选择目录」可以逐级点进去挑，
带 `.git` 或 `pyproject.toml` 的目录会标成「像仓库」。

工作台只有两个地址：`/` 是工具页，`/story` 是叙事版（和线上站一样）。
服务只监听 127.0.0.1，不对外暴露；密钥只落在本地 `.env` 里（不入库），
服务端接口不回显密钥内容，页面也不保存副本。

页面上的图表和线上站是同一套组件，数字来自同一份报告；
评测跑的是 harness 里真正的检索代码，不是在浏览器里抄一份算法，
所以这里看到的召回率和命令行跑出来的一致。

## 许可

本仓库代码采用 MIT 许可，见 [LICENSE](LICENSE)。被测仓库各自的许可保留在语料目录内，
第三方组件清单见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
