param(
  [ValidateSet('Chrome', 'Edge', 'Both')]
  [string]$Browser = 'Both'
)

$ErrorActionPreference = 'Stop'
$hostName = 'com.kingston.web_video_downloader'
$installDir = Join-Path $env:LOCALAPPDATA 'WebVideoDownloaderNativeHost'
$registryPaths = @()
if ($Browser -in @('Chrome', 'Both')) {
  $registryPaths += "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
}
if ($Browser -in @('Edge', 'Both')) {
  $registryPaths += "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName"
}
foreach ($registryPath in $registryPaths) {
  if (Test-Path -LiteralPath $registryPath) Remove-Item -LiteralPath $registryPath -Recurse -Force
}

if (Test-Path -LiteralPath $installDir) {
  $resolved = (Resolve-Path -LiteralPath $installDir).Path
  $expectedRoot = [IO.Path]::GetFullPath($env:LOCALAPPDATA)
  if (-not $resolved.StartsWith($expectedRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw '安装目录不在 LOCALAPPDATA 内，已停止清理。'
  }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
Write-Host '本地增强宿主已卸载。'
