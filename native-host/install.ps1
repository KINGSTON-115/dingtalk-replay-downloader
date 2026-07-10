param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-p]{32}$')]
  [string]$ExtensionId,

  [ValidateSet('Chrome', 'Edge', 'Both')]
  [string]$Browser = 'Both',

  [string]$OutputDirectory = (Join-Path $HOME 'Downloads\网页视频下载器')
)

$ErrorActionPreference = 'Stop'
$hostName = 'com.kingston.web_video_downloader'
$sourceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$installDir = Join-Path $env:LOCALAPPDATA 'WebVideoDownloaderNativeHost'
$node = (Get-Command node -ErrorAction Stop).Source
$ffmpeg = (Get-Command ffmpeg -ErrorAction Stop).Source

New-Item -ItemType Directory -Path $installDir -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $sourceDir 'host.cjs') -Destination (Join-Path $installDir 'host.cjs') -Force
Copy-Item -LiteralPath (Join-Path $sourceDir 'launcher.cs') -Destination (Join-Path $installDir 'launcher.cs') -Force

$config = @{
  ffmpegPath = $ffmpeg
  outputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
} | ConvertTo-Json
Set-Content -LiteralPath (Join-Path $installDir 'config.json') -Value $config -Encoding UTF8

$launcherConfig = @($node, (Join-Path $installDir 'host.cjs'))
Set-Content -LiteralPath (Join-Path $installDir 'launcher.config') -Value $launcherConfig -Encoding UTF8
$launcherPath = Join-Path $installDir 'native-host-launcher.exe'
$cscCandidates = @(
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$csc = $cscCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $csc) {
  throw '找不到 .NET Framework C# 编译器，无法生成 Native Messaging 启动器。'
}
& $csc /nologo /target:exe "/out:$launcherPath" (Join-Path $installDir 'launcher.cs')
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $launcherPath)) {
  throw "Native Messaging 启动器编译失败，退出码：$LASTEXITCODE"
}

$manifestPath = Join-Path $installDir "$hostName.json"
$manifest = @{
  name = $hostName
  description = '网页视频下载器 FFmpeg 本地增强宿主'
  path = $launcherPath
  type = 'stdio'
  allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json -Depth 4
Set-Content -LiteralPath $manifestPath -Value $manifest -Encoding UTF8

$registryPaths = @()
if ($Browser -in @('Chrome', 'Both')) {
  $registryPaths += "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
}
if ($Browser -in @('Edge', 'Both')) {
  $registryPaths += "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName"
}
foreach ($registryPath in $registryPaths) {
  New-Item -Path $registryPath -Force | Out-Null
  Set-Item -Path $registryPath -Value $manifestPath
}

Write-Host "本地增强宿主安装完成。"
Write-Host "FFmpeg：$ffmpeg"
Write-Host "输出目录：$OutputDirectory"
Write-Host "扩展 ID：$ExtensionId"
