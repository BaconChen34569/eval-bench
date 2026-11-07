# 课设 Copilot 评测台

给「课设 Copilot」用的评测流水线。别人交「我做了个 agent」，这里交的是
**「我能量化我的 agent，并且展示它在哪失败」**。

在线版：https://copilot-eval-bench-fzlro45ljfz.qoder.zone

不想装环境也可以直接下载打包好的源码（免注册、免密钥）：
https://copilot-eval-bench-fzlro45ljfz.qoder.zone/eval-bench-source.zip

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
bash corpus/fetch.sh                      # 拉被测仓库，约 3 MB
cd harness
node --experimental-strip-types src/cli.ts experiment \
  datasets/flask.json ../corpus/repos/flask-3.1.3 --out out/report.json
```

不需要密钥：这时只跑检索层。配置密钥的方法见 [harness/README.md](harness/README.md)。

站点：

```bash
cd site && npm ci && npm run dev
```

## 换成自己的课设仓库

改两处即可：题集放 `harness/datasets/`，被测仓库换个路径。
评测逻辑一行都不用动。题集怎么写见 [harness/README.md](harness/README.md)。

## 许可

本仓库代码见 [LICENSE](LICENSE)。被测仓库各自的许可保留在语料目录内。
