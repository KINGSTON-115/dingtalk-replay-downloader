$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$repoRootPath = (Resolve-Path -LiteralPath $repoRoot).Path
$manifestPath = Join-Path $repoRootPath "manifest.json"
$manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestPath | ConvertFrom-Json
$version = $manifest.version

if (-not $version) {
  throw "manifest.json 中没有找到版本号。"
}

$npm = Get-Command npm.cmd -ErrorAction Stop
Push-Location $repoRootPath
try {
  & $npm.Source run build
  if ($LASTEXITCODE -ne 0) {
    throw "扩展构建失败，退出码：$LASTEXITCODE"
  }
} finally {
  Pop-Location
}

$distDir = Join-Path $repoRootPath "dist"
$packageName = "网页视频下载器-v$version"
$packageRoot = Join-Path $distDir $packageName
$zipPath = Join-Path $distDir "web-video-downloader-v$version.zip"

if (-not (Test-Path -LiteralPath $distDir)) {
  New-Item -ItemType Directory -Path $distDir | Out-Null
}

$distPath = (Resolve-Path -LiteralPath $distDir).Path
if (-not $distPath.StartsWith($repoRootPath, [StringComparison]::OrdinalIgnoreCase)) {
  throw "发布目录不在项目目录内，已停止。"
}

if (Test-Path -LiteralPath $packageRoot) {
  $packagePath = (Resolve-Path -LiteralPath $packageRoot).Path
  if (-not $packagePath.StartsWith($distPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw "待清理目录不在 dist 目录内，已停止。"
  }
  Remove-Item -LiteralPath $packageRoot -Recurse -Force
}

New-Item -ItemType Directory -Path $packageRoot | Out-Null

$items = @(
  "manifest.json",
  "downloader.html",
  "styles.css",
  "使用说明.html",
  "README.md",
  "LICENSE",
  "LICENSE.zh-CN.md",
  "THIRD_PARTY_NOTICES.md",
  "docs",
  "vendor",
  "build",
  "icons",
  "native-host",
  "release-notes-v0.4.0.md"
)

foreach ($item in $items) {
  $source = Join-Path $repoRootPath $item
  if (-not (Test-Path -LiteralPath $source)) {
    throw "缺少发布文件：$item"
  }
  Copy-Item -LiteralPath $source -Destination $packageRoot -Recurse
}

if (Test-Path -LiteralPath $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}

Compress-Archive -Path $packageRoot -DestinationPath $zipPath -Force

Write-Host "已生成发布包：$zipPath"
Write-Host "解压后拖入浏览器扩展页的文件夹：$packageName"
