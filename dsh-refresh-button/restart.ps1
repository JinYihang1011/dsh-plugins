<#
  dsh-refresh-button action script  (two-stage, job-object safe)

  Problem (measured 2026-10-02): the host is an Electron/Chromium child, so every
  process it spawns lives inside a job object with kill-on-close. A single-stage
  script therefore killed the app successfully (window closed) and was reaped in
  the same instant, never reaching the relaunch step.

  Fix: stage 2 must be created by something OUTSIDE that job object. Two ways to
  escape are attempted, in order, each verified by watching for the worker's own
  log line; if neither works the script falls back to an inline run (correct for
  the manual .cmd path, which is not inside any job).

    1) WMI  Win32_Process.Create  -> child of WmiPrvSE.exe, outside the job.
    2) schtasks /create + /run    -> runs under the Task Scheduler service.
    3) inline                     -> may be reaped; last resort.

  Usage:
    powershell -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File restart.ps1 -Action restart
    (-Worker is internal, used by stage 1)

  ASCII-only on purpose: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI
  (GBK here), where multi-byte characters can swallow the following quote.
#>
param([string]$Action = 'restart', [switch]$Worker)

$ErrorActionPreference = 'Continue'

$logDir = Join-Path $env:USERPROFILE '.dsh\logs'
try { New-Item -ItemType Directory -Force -Path $logDir | Out-Null } catch { }
$log = Join-Path $logDir 'dsh-refresh-button.log'

$exe = 'D:\Apps\DeepSeek Harness\DeepSeek Harness.exe'
$procName = 'DeepSeek Harness'
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$taskName = 'dsh-refresh-button-restart'

function Log([string]$m) {
  try { Add-Content -Path $log -Value ('{0} {1}' -f (Get-Date -Format 'HH:mm:ss.fff'), $m) } catch { }
}

function LogLength {
  try { if (Test-Path $log) { return (Get-Item $log).Length } } catch { }
  return 0
}

# ---------------------------------------------------------------- stage 1 ----
if (-not $Worker) {
  $self = $PSCommandPath
  if (-not $self) { $self = $MyInvocation.MyCommand.Path }
  Log ('=== request action={0} pid={1} stage=bootstrap script={2} ===' -f $Action, $PID, $self)

  $before = LogLength
  $escaped = $false

    # ---- strategy 1: WMI ----
  if (-not $escaped) {
    try {
      $cmdLine = '"{0}" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{1}" -Action {2} -Worker' -f $psExe, $self, $Action
      $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmdLine } -ErrorAction Stop
      Log ('[wmi] create returned={0} pid={1}' -f $r.ReturnValue, $r.ProcessId)
      if ($r.ReturnValue -eq 0) {
        for ($i = 0; $i -lt 20 -and -not $escaped; $i++) {
          Start-Sleep -Milliseconds 300
          if (LogLength -gt $before) {
            $new = Get-Content -LiteralPath $log -ErrorAction SilentlyContinue | Select-Object -Last 5
            if (($new -join "`n") -match 'stage=worker') { $escaped = $true }
          }
        }
        Log ('[wmi] worker observed = {0}' -f $escaped)
      }
    }
    catch { Log ('[wmi] failed: {0}' -f $_) }
  }

  # ---- strategy 2: scheduled task ----
  if (-not $escaped) {
    if ($self -match ' ') {
      Log '[task] skipped: script path contains a space'
    }
    else {
      try {
        $tr = 'powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File {0} -Action {1} -Worker' -f $self, $Action
        $o1 = (& schtasks /create /tn $taskName /tr $tr /sc once /st 00:00 /f 2>&1 | Out-String).Trim()
        Log ('[task] create: {0}' -f $o1)
        $o2 = (& schtasks /run /tn $taskName 2>&1 | Out-String).Trim()
        Log ('[task] run: {0}' -f $o2)
        for ($i = 0; $i -lt 20 -and -not $escaped; $i++) {
          Start-Sleep -Milliseconds 300
          if (LogLength -gt $before) {
            $new = Get-Content -LiteralPath $log -ErrorAction SilentlyContinue | Select-Object -Last 5
            if (($new -join "`n") -match 'stage=worker') { $escaped = $true }
          }
        }
        Log ('[task] worker observed = {0}' -f $escaped)
      }
      catch { Log ('[task] failed: {0}' -f $_) }
    }
  }

  if ($escaped) {
    Log 'bootstrap done (worker owns the restart now)'
    exit 0
  }
  Log 'no escape route worked; running inline'
  $Worker = $true
}

# ---------------------------------------------------------------- stage 2 ----
Log ('=== action={0} pid={1} stage=worker ===' -f $Action, $PID)

Start-Sleep -Milliseconds 1500

$targets = @()
try {
  $targets = @(Get-Process -Name $procName -ErrorAction Stop)
  Log ('Get-Process -Name "{0}" ok: count={1} pid={2}' -f $procName, $targets.Count, (($targets | ForEach-Object { $_.Id }) -join ','))
}
catch {
  Log ('Get-Process -Name "{0}" failed: {1}' -f $procName, $_)
  try {
    $targets = @(Get-Process | Where-Object { $_.ProcessName -like '*DeepSeek*' })
    Log ('fallback wildcard match: count={0} ({1})' -f $targets.Count, (($targets | ForEach-Object { $_.Id.ToString() + ':' + $_.ProcessName }) -join ', '))
  }
  catch { Log ('fallback enum failed: {0}' -f $_) }
}

if ($targets.Count -gt 0) {
  try {
    $targets | Stop-Process -Force -ErrorAction Stop
    Log 'Stop-Process ok'
  }
  catch { Log ('Stop-Process failed: {0}' -f $_) }

  Start-Sleep -Milliseconds 1200
  $left = @(Get-Process -Name $procName -ErrorAction SilentlyContinue).Count
  Log ('remaining after Stop-Process: {0}' -f $left)

  if ($left -gt 0) {
    $out = (& taskkill /F /T /IM ($procName + '.exe') 2>&1 | Out-String).Trim()
    Log ('taskkill: {0}' -f $out)
    Start-Sleep -Milliseconds 1200
    Log ('remaining after taskkill: {0}' -f @(Get-Process -Name $procName -ErrorAction SilentlyContinue).Count)
  }
}
else {
  Log 'no matching process; skip kill'
}

if ($Action -eq 'restart') {
  Start-Sleep -Milliseconds 1200
  if (Test-Path -LiteralPath $exe) {
    try {
      Start-Process -FilePath $exe
      Start-Sleep -Milliseconds 2500
      $now = @(Get-Process -Name $procName -ErrorAction SilentlyContinue).Count
      Log ('relaunch ok; running now = {0}' -f $now)
    }
    catch { Log ('relaunch failed: {0}' -f $_) }
  }
  else { Log ('exe not found: {0}' -f $exe) }
}

try { & schtasks /delete /tn $taskName /f 2>&1 | Out-Null } catch { }
Log 'done'
