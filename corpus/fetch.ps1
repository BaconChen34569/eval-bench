# 拉取评测用的被测仓库（Windows 版）。
#
# 与 fetch.sh 等价，给没有 bash 的 Windows 机器用：
# 只要 PowerShell 5.1 以上 + Node.js，不需要 Python，也不需要装 Git。
#
# 用法（在仓库根目录）：
#   powershell -ExecutionPolicy Bypass -File corpus\fetch.ps1

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

$Packages = @(
  @{ Name = "flask";    Version = "3.1.3" },
  @{ Name = "jinja2";  Version = "3.1.6" },
  @{ Name = "requests"; Version = "2.34.2" },
  @{ Name = "werkzeug"; Version = "3.1.9" }
)

# tar 是 Windows 10 1803 起自带的 bsdtar，路径写死以免撞上 Git 自带的 GNU tar。
$Tar = Join-Path $env:SystemRoot "System32\tar.exe"
if (-not (Test-Path $Tar)) {
  Write-Error "找不到 tar：$Tar。Windows 10 1803 以上自带，请更新系统。"
}

New-Item -ItemType Directory -Force -Path "repos", "tmp" | Out-Null

foreach ($pkg in $Packages) {
  $name = $pkg.Name
  $version = $pkg.Version
  $target = "repos/$name-$version"

  if (Test-Path $target) {
    Write-Host "跳过 $name-$version（已存在）"
    continue
  }

  Write-Host "下载 $name==$version 源码包…"
  Get-ChildItem "tmp" -Force | Remove-Item -Recurse -Force

  $meta = Invoke-RestMethod "https://pypi.org/pypi/$name/$version/json"
  $sdist = $meta.urls | Where-Object { $_.packagetype -eq "sdist" } | Select-Object -First 1
  if (-not $sdist) {
    Write-Error "$name==$version 没有源码包"
  }

  Invoke-WebRequest -Uri $sdist.url -OutFile "tmp/pkg.tar.gz"
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  & $Tar -xzf "tmp/pkg.tar.gz" -C $target --strip-components=1
  if ($LASTEXITCODE -ne 0) {
    Write-Error "解包失败：$name-$version"
  }

  # 语料只保留源码树（src/）和包根目录下的文件。
  # 文档、测试、示例目录里有大量英文散文和测试用的同名字符串，
  # 进语料会明显抬高 BM25 召回，让对比实验失去意义——
  # 评测针对的是实现代码，不是 README。
  Get-ChildItem $target -Directory |
    Where-Object { $_.Name -ne "src" } |
    ForEach-Object { Remove-Item $_.FullName -Recurse -Force }

  Write-Host "  → $target"
}

Remove-Item "tmp" -Recurse -Force
Write-Host ""
Write-Host "完成。当前语料："
Get-ChildItem "repos" | ForEach-Object { Write-Host "  $($_.Name)" }
