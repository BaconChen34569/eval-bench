# 第三方组件与许可说明

本仓库自身的代码采用 MIT 许可（见 [LICENSE](LICENSE)）。

以下第三方组件**不随本仓库分发**，由 `corpus/fetch.sh`（macOS/Linux）或
`corpus/fetch.ps1`（Windows）在评测时从 PyPI 官方获取，各自保留原始许可：

| 组件 | 版本 | 许可 | 用途 |
|---|---|---|---|
| Flask | 3.1.3 | BSD-3-Clause | 被测语料仓库 |
| Jinja2 | 3.1.6 | BSD-3-Clause | 被测语料仓库 |
| Requests | 2.34.2 | Apache-2.0 | 被测语料仓库 |
| Werkzeug | 3.1.9 | BSD-3-Clause | 被测语料仓库 |

站点前端基于 Qoder Sites 的 vinext-starter 模板改写，出处与许可见 [site/PROVENANCE.md](site/PROVENANCE.md)；
其中 Tailwind CSS 以 MIT 许可使用，样式补丁见 [site/vendor/](site/vendor/)。

`harness/` 评测流水线不使用任何第三方运行时依赖，仅依赖 Node.js 标准库。
