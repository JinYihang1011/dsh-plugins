<#
.SYNOPSIS
    dsh-win-notify 卸载脚本：从 DSH 桌面端 profile 中移除插件（幂等）。

.DESCRIPTION
    步骤：
      1. 备份 profile 的 package.json / cordis.patch.yml / pnpm-lock.yaml。
      2. 从 package.json 的 dsh.profile.bundles 中移除 "dsh-win-notify"。
      3. 执行 dsh plugin --profile desktop remove dsh-win-notify（卸依赖）。
      4. 删除 <DSH_HOME>\local-plugins\dsh-win-notify（插件副本；
         工作区里的源码目录不动）。

    之后重启 DeepSeek Harness 使卸载完全生效。

.EXAMPLE
    pwsh -File uninstall.ps1
    pwsh -File uninstall.ps1 -WhatIfOnly
#>
[CmdletBinding()]
param(
    [string]$DshHome,
    [string]$Profile = 'desktop',
    [string]$DshCli,
    [switch]$WhatIfOnly
)

$ErrorActionPreference = 'Stop'
$pluginName = 'dsh-win-notify'

function Write-Step([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "    $Text" -ForegroundColor Green }

if (-not $DshHome -or $DshHome.Trim() -eq '') {
    $DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
}
$targetDir = Join-Path $DshHome "local-plugins\$pluginName"
$profileDir = Join-Path $DshHome "profiles\$Profile"
$manifestPath = Join-Path $profileDir 'package.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "找不到 profile：$manifestPath" }

function Resolve-DshCli {
    param([string]$Explicit)
    if ($Explicit -and (Test-Path -LiteralPath $Explicit)) { return $Explicit }
    foreach ($name in @('dsh.cmd', 'dsh')) {
        $found = Get-Command $name -ErrorAction SilentlyContinue
        if ($found) { return $found.Source }
    }
    $lnk = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\DeepSeek Harness.lnk'
    if (Test-Path -LiteralPath $lnk) {
        try {
            $shell = New-Object -ComObject WScript.Shell
            $root = Split-Path $shell.CreateShortcut($lnk).TargetPath -Parent
            $candidate = Join-Path $root 'resources\runtime\cli\bin\dsh.cmd'
            if (Test-Path -LiteralPath $candidate) { return $candidate }
        } catch { }
    }
    throw ' 找不到 dsh CLI，请用 -DshCli <dsh.cmd 绝对路径> 指定。'
}

# ── 1. 备份 ───────────────────────────────────────────────────────────────
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path (Join-Path $profileDir '.backup') "$pluginName-uninstall-$stamp"
Write-Step "备份 profile 配置到 $backupDir"
if (-not $WhatIfOnly) {
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    foreach ($name in @('package.json', 'cordis.patch.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml')) {
        $from = Join-Path $profileDir $name
        if (Test-Path -LiteralPath $from) { Copy-Item -LiteralPath $from -Destination $backupDir -Force }
    }
}
Write-Ok '已备份'

# ── 2. 取消 bundle 选中 ───────────────────────────────────────────────────
$text = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8
$match = [regex]::Match($text, '(?s)"bundles"\s*:\s*\[(?<body>[^\]]*)\]')
if ($match.Success -and $match.Groups['body'].Value -match [regex]::Escape('"' + $pluginName + '"')) {
    Write-Step "从 dsh.profile.bundles 移除 $pluginName"
    $body = $match.Groups['body'].Value
    # 先尝试连带前置逗号（非首项），否则去掉后置逗号（首项）
    $stripped = [regex]::Replace($body, '\s*,\s*"' + [regex]::Escape($pluginName) + '"', '')
    if ($stripped -eq $body) { $stripped = [regex]::Replace($body, '"' + [regex]::Escape($pluginName) + '"\s*,?', '') }
    $updated = $text.Remove($match.Index, $match.Length).Insert($match.Index, '"bundles": [' + $stripped + ']')
    if (-not $WhatIfOnly) {
        [System.IO.File]::WriteAllText($manifestPath, $updated, (New-Object System.Text.UTF8Encoding($false)))
    }
    Write-Ok '已移除'
} else {
    Write-Step 'dsh.profile.bundles 中没有该插件，跳过'
}

# ── 3. 卸载依赖 ───────────────────────────────────────────────────────────
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$dependencyNames = @()
if ($manifest.PSObject.Properties.Name -contains 'dependencies' -and $null -ne $manifest.dependencies) {
    $dependencyNames = @($manifest.dependencies.PSObject.Properties.Name)
}
if ($dependencyNames -contains $pluginName) {
    $cli = Resolve-DshCli -Explicit $DshCli
    Write-Step "执行：`"$cli`" plugin --profile $Profile remove $pluginName"
    if (-not $WhatIfOnly) {
        & $cli plugin --profile $Profile remove $pluginName
        if ($LASTEXITCODE -ne 0) { Write-Host "    remove 返回退出码 $LASTEXITCODE，请检查 profile。" -ForegroundColor Yellow }
    }
    Write-Ok '依赖已移除'
} else {
    Write-Step '依赖未声明，跳过'
}

# ── 4. 删除插件副本 ───────────────────────────────────────────────────────
if (Test-Path -LiteralPath $targetDir) {
    Write-Step "删除插件副本 $targetDir"
    if (-not $WhatIfOnly) { Remove-Item -LiteralPath $targetDir -Recurse -Force }
    Write-Ok '已删除（工作区里的源码目录保持不变）'
}

Write-Host ''
Write-Host '卸载完成，请重启 DeepSeek Harness。' -ForegroundColor Green
Write-Host "· 回滚备份：$backupDir"
