# 评测语料：从 PyPI 源码包还原的被测仓库。
#
# 版本已固定，重新拉取的结果完全可复现：
#
#   macOS / Linux：bash corpus/fetch.sh
#   Windows：      powershell -ExecutionPolicy Bypass -File corpus\fetch.ps1
#
# 两个脚本等价：同样的四个版本、同样的目录结构、同样的取舍（只保留 src/ 和包根目录）。
# 依赖只要 curl + tar + Node.js（Windows 版用系统自带的 tar.exe），不需要 Python。
repos/
tmp/
