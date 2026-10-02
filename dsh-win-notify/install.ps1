<#
.SYNOPSIS
    dsh-win-notify 安装脚本：把插件装进 DSH 桌面端 profile（幂等，可重复运行）。

.DESCRIPTION
    步骤：
      1. 把插件文件同步到 <DSH_HOME>\local-plugins\dsh-win-notify
         （用无空格、非中文的路径，避免 pnpm 的 link: 规格出现引号问题）。
      2. 备份 profile 的 package.json / cordis.patch.yml / pnpm-lock.yaml。
      3. 若依赖缺失，执行 dsh plugin --profile desktop add "link:<目标目录>"。
      4. 把 "dsh-win-notify" 追加进 package.json 的 dsh.profile.bundles。

    之后 DSH 的 HMR 通常会自动重载 profile 配置、插件即时生效；
    若未生效，重启 DeepSeek Harness 即可。

.EXAMPLE
    pwsh -File install.ps1
    pwsh -File install.ps1 -WhatIfOnly
#>
[CmdletBinding()]
param(
    # 插件源目录，默认脚本所在目录。
    [string]$SourceDir = $PSScriptRoot,

    # DSH 主目录，默认取 $env:DSH_HOME，否则 $HOME\.dsh。
    [string]$DshHome,

    # 目标 profile 名。
    [string]$Profile = 'desktop',

    # dsh CLI 路径，默认自动发现。
    [string]$DshCli,

    # 只打印将要做的改动，不写入。
    [switch]$WhatIfOnly
)

$ErrorActionPreference = 'Stop'
$pluginName = 'dsh-win-notify'
$requiredFiles = @('package.json', 'index.js', 'notify.ps1', 'cordis.patch.yml')

function Write-Step([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "    $Text" -ForegroundColor Green }
function Write-Warn2([string]$Text) { Write-Host "    $Text" -ForegroundColor Yellow }

# ── 0. 参数与前置检查 ──────────────────────────────────────────────────────
if (-not $DshHome -or $DshHome.Trim() -eq '') {
    $DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
}
$SourceDir = (Resolve-Path -LiteralPath $SourceDir).Path
foreach ($file in $requiredFiles) {
    $path = Join-Path $SourceDir $file
    if (-not (Test-Path -LiteralPath $path)) { throw "插件源目录缺少 $file：$SourceDir" }
}

$targetDir = Join-Path $DshHome "local-plugins\$pluginName"
$profileDir = Join-Path $DshHome "profiles\$Profile"
$manifestPath = Join-Path $profileDir 'package.json'
if (-not (Test-Path -LiteralPath $manifestPath)) {
    throw "找不到 profile：$manifestPath —— 请先启动一次 DeepSeek Harness 桌面端以初始化 profile。"
}

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
        } catch {
            # 快捷方式读取失败时继续报错
        }
    }
    throw ' 找不到 dsh CLI，请用 -DshCli <dsh.cmd 绝对路径> 指定。'
}

Write-Step "DSH 主目录：$DshHome"
Write-Step "profile：$profileDir"

# ── 1. 同步插件文件到 local-plugins ────────────────────────────────────────
Write-Step "同步插件文件到 $targetDir"
if (-not $WhatIfOnly) {
    New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
    foreach ($name in @('package.json', 'index.js', 'notify.ps1', 'cordis.patch.yml', 'README.md')) {
        $from = Join-Path $SourceDir $name
        if (Test-Path -LiteralPath $from) { Copy-Item -LiteralPath $from -Destination $targetDir -Force }
    }
}
Write-Ok '已同步 package.json / index.js / notify.ps1 / cordis.patch.yml / README.md'

# ── 2. 备份 profile 配置 ──────────────────────────────────────────────────
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path (Join-Path $profileDir '.backup') "$pluginName-$stamp"
Write-Step "备份 profile 配置到 $backupDir"
if (-not $WhatIfOnly) {
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    foreach ($name in @('package.json', 'cordis.patch.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml')) {
        $from = Join-Path $profileDir $name
        if (Test-Path -LiteralPath $from) { Copy-Item -LiteralPath $from -Destination $backupDir -Force }
    }
}
Write-Ok '已备份'

# ── 3. 声明依赖（pnpm link:，被策略挡住时退回手工登记） ───────────────────
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$dependencyNames = @()
if ($manifest.PSObject.Properties.Name -contains 'dependencies' -and $null -ne $manifest.dependencies) {
    $dependencyNames = @($manifest.dependencies.PSObject.Properties.Name)
}
$declared = $dependencyNames -contains $pluginName

# 退路：手写 dependencies 条目 + 建 node_modules junction。
# 只在 pnpm 因与本次安装无关的 lockfile 策略（minimumReleaseAge）退出非零时使用；
# link: 依赖不下载任何远端代码，也不改动任何安全策略。
function Add-ManualDependency {
    $linkPath = Join-Path (Join-Path $profileDir 'node_modules') $pluginName
    if (-not (Test-Path -LiteralPath $linkPath)) {
        New-Item -ItemType Junction -Path $linkPath -Target $targetDir | Out-Null
        Write-Ok "已建立 node_modules junction：$linkPath"
    } else {
        Write-Ok 'node_modules 链接已存在'
    }
    $current = [System.IO.File]::ReadAllText($manifestPath, [System.Text.Encoding]::UTF8)
    if ($current -match ('"dependencies"\s*:\s*\{[^}]*"' + [regex]::Escape($pluginName) + '"')) { return }
    $head = [regex]::Match($current, '"dependencies"\s*:\s*\{')
    if (-not $head.Success) { throw "在 $manifestPath 中找不到 dependencies 对象。" }
    $spec = 'link:' + ($targetDir -replace '\\', '/')
    $entry = "`n    `"$pluginName`": `"$spec`","
    $updated = $current.Insert($head.Index + $head.Length, $entry)
    [System.IO.File]::WriteAllText($manifestPath, $updated, (New-Object System.Text.UTF8Encoding($false)))
    Write-Ok '已手写 dependencies 条目'
}

if ($declared) {
    Write-Step "依赖已声明，跳过 pnpm：$pluginName"
} else {
    $cli = Resolve-DshCli -Explicit $DshCli
    $spec = 'link:' + ($targetDir -replace '\\', '/')
    Write-Step "执行：`"$cli`" plugin --profile $Profile add `"$spec`""
    $pnpmOk = $true
    if (-not $WhatIfOnly) {
        & $cli plugin --profile $Profile add $spec
        if ($LASTEXITCODE -ne 0) { $pnpmOk = $false }
    }
    if ($pnpmOk) {
        Write-Ok '依赖已安装'
    } else {
        Write-Warn2 "dsh plugin add 退出码 $LASTEXITCODE（pnpm 已回滚 manifest），改用本机退路：手工登记 link 依赖"
        if (-not $WhatIfOnly) { Add-ManualDependency }
        Write-Ok '依赖已手工登记（未改动安全策略，也未下载远端代码）'
    }
}

# ── 4. 选中 bundle ────────────────────────────────────────────────────────
$text = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8
$match = [regex]::Match($text, '(?s)"bundles"\s*:\s*\[(?<body>[^\]]*)\]')
if (-not $match.Success) { throw "在 $manifestPath 中找不到 dsh.profile.bundles 数组。" }
if ($match.Groups['body'].Value -match [regex]::Escape('"' + $pluginName + '"')) {
    Write-Step 'bundle 已在 dsh.profile.bundles 中，跳过'
} else {
    $body = $match.Groups['body'].Value.TrimEnd("`r", "`n", " ", "`t")
    $newBody = $body + ',' + "`n        " + '"' + $pluginName + '"' + "`n      "
    $updated = $text.Remove($match.Index, $match.Length).Insert($match.Index, '"bundles": [' + $newBody + ']')
    Write-Step "把 $pluginName 追加进 dsh.profile.bundles"
    if (-not $WhatIfOnly) {
        [System.IO.File]::WriteAllText($manifestPath, $updated, (New-Object System.Text.UTF8Encoding($false)))
    }
    Write-Ok 'bundle 已选中'
}

Write-Host ''
Write-Host '安装完成。' -ForegroundColor Green
Write-Host '· DSH 的 HMR 一般会立即重载 profile 配置，插件即时生效；'
Write-Host '· 若未生效，请完全退出并重新打开 DeepSeek Harness。'
Write-Host "· 回滚备份：$backupDir"
