<#
  dsh-refresh-button —— 安装 / 更新脚本（幂等，可反复执行）

  1. 把插件文件同步到 <DSH_HOME>\local-plugins\dsh-refresh-button
     （用无空格、非中文的路径，避免 pnpm 的 link: 规格出现引号问题）
  2. 若 desktop profile 尚未登记该依赖，执行 dsh plugin --profile desktop add "link:<目标目录>"
     link: 只建立本地链接，不下载任何远端代码，也不改动安全策略。

  用法：pwsh -File install.ps1            # 默认装进 desktop profile
        pwsh -File install.ps1 -Profile web
#>
[CmdletBinding()]
param(
  [string]$Profile = 'desktop',
  [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
  [string]$DshCli
)

$ErrorActionPreference = 'Stop'
$pluginName = 'dsh-refresh-button'
$sourceDir = $PSScriptRoot
$targetDir = Join-Path $DshHome "local-plugins\$pluginName"
$files = @('package.json', 'cordis.patch.yml', 'index.js', 'client.v3.js', 'restart.ps1', 'README.md')

Write-Host "[1/3] 同步插件文件 -> $targetDir"
New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
foreach ($f in $files) {
  $from = Join-Path $sourceDir $f
  if (Test-Path -LiteralPath $from) {
    Copy-Item -LiteralPath $from -Destination (Join-Path $targetDir $f) -Force
    Write-Host ("      {0}" -f $f)
  }
}
$stale = Join-Path $targetDir 'client.js'
if (Test-Path -LiteralPath $stale) {
  Write-Host '      提示：旧的 client.js 已不被 exports 引用（留可忽略）'
}

Write-Host '[2/3] 定位 dsh CLI'
if (-not $DshCli) {
  foreach ($name in @('dsh.cmd', 'dsh')) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { $DshCli = $cmd.Source; break }
  }
}
if (-not $DshCli) {
  foreach ($root in @('D:\Apps\DeepSeek Harness')) {
    $candidate = Join-Path $root 'resources\runtime\cli\bin\dsh.cmd'
    if (Test-Path -LiteralPath $candidate) { $DshCli = $candidate; break }
  }
}
if (-not $DshCli) { throw '找不到 dsh CLI，请用 -DshCli <dsh.cmd 绝对路径> 指定。' }
Write-Host "      $DshCli"

Write-Host "[3/3] 校验 profile '$Profile' 的依赖登记"
$spec = 'link:' + ($targetDir -replace '\\', '/')
$profileJson = Join-Path $DshHome "profiles\$Profile\package.json"
$registered = $false
if (Test-Path -LiteralPath $profileJson) {
  $registered = (Get-Content -LiteralPath $profileJson -Raw) -match [regex]::Escape('"dsh-refresh-button"')
}
if ($registered) {
  Write-Host '      已登记，跳过安装（文件已更新）'
}
else {
  Write-Host "      执行：`"$DshCli`" plugin --profile $Profile add `"$spec`""
  & $DshCli plugin --profile $Profile add $spec
}

Write-Host ''
Write-Host '完成。请重启 DSH：宿主半边的新路由（POST /dsh-refresh-button/restart）只在启动时挂载。'
