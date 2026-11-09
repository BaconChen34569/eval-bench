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

```bash
git clone https://github.com/BaconChen34569/eval-bench.git
cd eval-bench

bash corpus/fetch.sh                      # 拉被测仓库，约 3 MB
cd harness
node --experimental-strip-types src/cli.ts experiment \
  datasets/flask.json ../corpus/repos/flask-3.1.3 --out out/report.json
```

Windows（PowerShell）把第 3 行换成 `powershell -ExecutionPolicy Bypass -File corpus\fetch.ps1`，
后面的命令写成一行（不用 `\` 续行）。两个拉取脚本产出的语料逐字节一致，
系统差异见 [harness/README.md](harness/README.md#在-windows-上跑)。

不需要密钥：这时只跑检索层。配置密钥的方法见 [harness/README.md](harness/README.md)。

要跑多模型对比（同一套题换几个模型各跑一轮，看评测台能不能区分出模型好坏）：
`harness/.env` 里按前缀配好几组服务商，`cp harness/.env.example harness/.env` 之后照着填，
然后一条命令把「换模型 + 换尺子重打分 + 算一致率」全做完：

```bash
node --experimental-strip-types src/cli.ts compare \
  datasets/flask.json ../corpus/repos/flask-3.1.3 \
  --report out/report.json --report-out out/report.json
```

写法见 [harness/README.md](harness/README.md)。

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

## 许可

本仓库代码采用 MIT 许可，见 [LICENSE](LICENSE)。被测仓库各自的许可保留在语料目录内，
第三方组件清单见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
