#!/usr/bin/env bash
# 拉取评测用的被测仓库。
#
# 用的是 PyPI 上的源码发行包（sdist），不是 wheel——评测要看的是源码本身。
# 每个版本都固定住，保证别人拿到的语料和你评测时完全一致。
#
# 只依赖 bash + curl + tar，不需要 Python：
# 从 PyPI 的 JSON 接口查出 sdist 的下载地址，直接拉源码包解开。
set -euo pipefail

cd "$(dirname "$0")"

PACKAGES=(
  "flask==3.1.3"
  "jinja2==3.1.6"
  "requests==2.34.2"
  "werkzeug==3.1.9"
)

if ! command -v curl >/dev/null 2>&1; then
  echo "需要 curl：https://curl.se" >&2
  exit 1
fi
if ! command -v tar >/dev/null 2>&1; then
  echo "需要 tar（Windows 10 自带 bsdtar）" >&2
  exit 1
fi

mkdir -p repos tmp

for spec in "${PACKAGES[@]}"; do
  name="${spec%%==*}"
  version="${spec##*==}"

  if [ -d "repos/${name}-${version}" ]; then
    echo "跳过 ${name}-${version}（已存在）"
    continue
  fi

  echo "下载 ${name}==${version} 源码包…"
  rm -rf tmp/*
  curl -fsSL "https://pypi.org/pypi/${name}/${version}/json" -o tmp/meta.json

  # JSON 里 urls 数组中 packagetype 为 sdist 的那条就是源码包。
  url=$(node -e '
    const meta = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const sdist = (meta.urls || []).find((item) => item.packagetype === "sdist");
    if (!sdist) process.exit(1);
    process.stdout.write(sdist.url);
  ' tmp/meta.json)

  if [ -z "$url" ]; then
    echo "  ${name}==${version} 没有源码包" >&2
    exit 1
  fi

  curl -fsSL "$url" -o tmp/pkg.tar.gz

  # 直接解到目标目录（剥掉 sdist 的顶层目录），
  # 不走「先解到别处再 mv」——Windows 上 mv 目录常因文件句柄残留而失败。
  mkdir -p "repos/${name}-${version}"
  tar -xzf tmp/pkg.tar.gz -C "repos/${name}-${version}" --strip-components=1

  # 语料只保留源码树（src/）和包根目录下的文件。
  # 文档、测试、示例目录里有大量英文散文和测试用的同名字符串，
  # 进语料会明显抬高 BM25 召回，让对比实验失去意义——
  # 评测针对的是实现代码，不是 README。
  find "repos/${name}-${version}" -maxdepth 1 -mindepth 1 -type d ! -name src -exec rm -rf {} +

  echo "  → repos/${name}-${version}"
done

rm -rf tmp
echo
echo "完成。当前语料："
ls repos
