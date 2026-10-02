<#
.SYNOPSIS
    dsh-win-notify delivery script: show one message as a Windows notification.

.DESCRIPTION
    Called by index.js as:
        powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass `
          -File notify.ps1 -PayloadBase64 <base64 of UTF-8 JSON>

    The payload travels as base64 so command-line quoting, non-ASCII text and
    line breaks can never be mangled by the shell boundary.

    Payload JSON:
      { "appId": "com.deepseek.dsh",
        "title": "Title",
        "texts": ["first line", "second line"],
        "sound": true,
        "launch": "dsh://open",
        "actionLabel": "Open DeepSeek Harness" }

    When "launch" is present the whole toast becomes a protocol activation and
    an action button carrying the same URI is added. DSH Desktop registers the
    "dsh" URI scheme (app.setAsDefaultProtocolClient) and focuses its main
    window on "dsh://open", so the click lands back in the app.

    Two conditions must hold or Windows refuses the toast with
    HRESULT 0x80073D54 ("The process has no package identity"):
      1. The process integrity level is Medium or higher. A Low-integrity
         process (for example a shell inside the DSH file sandbox) cannot use
         the WinRT notification APIs at all.
      2. The appId is an AppUserModelID already registered by a Start Menu
         shortcut. DSH Desktop registers "com.deepseek.dsh" at install time,
         which is why the toast shows up as "DeepSeek Harness" with its icon.

    Standalone self-test (payload mode is optional):
      powershell.exe -NoProfile -ExecutionPolicy Bypass -File notify.ps1
      powershell.exe -NoProfile -ExecutionPolicy Bypass -File notify.ps1 `
        -Title "Hello" -Text "world"

.NOTES
    Windows PowerShell 5.1 only (powershell.exe). PowerShell 7 has no WinRT
    type projection, so [Windows.UI.Notifications...] cannot be loaded there.

    This file is deliberately pure ASCII: Windows PowerShell 5.1 decodes a .ps1
    without a UTF-8 BOM using the system ANSI code page, so non-ASCII comments
    would break parsing. Every localized string arrives through the payload.
#>
[CmdletBinding(DefaultParameterSetName = 'Payload')]
param(
    # base64(UTF-8 JSON) payload supplied by index.js.
    [Parameter(ParameterSetName = 'Payload')]
    [string]$PayloadBase64,

    # Manual self-test parameters.
    [Parameter(ParameterSetName = 'Manual')]
    [string]$Title = 'DSH notification test',

    [Parameter(ParameterSetName = 'Manual')]
    [string[]]$Text = @('If you can see this, the notification channel works.'),

    [Parameter(ParameterSetName = 'Manual')]
    [string]$AppId = 'com.deepseek.dsh',

    [Parameter(ParameterSetName = 'Manual')]
    [switch]$Silent
)

$ErrorActionPreference = 'Stop'

# Defaults that keep this file pure ASCII: the localized label is decoded from
# its UTF-8 base64 form ("Open DeepSeek Harness" in Simplified Chinese).
# index.js normally supplies both values; these defaults also cover an older
# index.js already loaded in a running DSH.
$defaultLaunch = 'dsh://open'
$defaultActionLabel = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('5omT5byAIERlZXBTZWVrIEhhcm5lc3M='))

# -- 1. Parse the payload -----------------------------------------------------
if ($PSCmdlet.ParameterSetName -eq 'Payload') {
    if ([string]::IsNullOrWhiteSpace($PayloadBase64)) {
        Write-Error 'notify.ps1: -PayloadBase64 is required'
        exit 2
    }
    try {
        $decoded = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($PayloadBase64))
        $payload = $decoded | ConvertFrom-Json
    } catch {
        Write-Error ('notify.ps1: cannot parse payload - ' + $_.Exception.Message)
        exit 2
    }
    $notificationTitle = [string]$payload.title
    $texts = @($payload.texts | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } | ForEach-Object { [string]$_ })
    if ($payload.PSObject.Properties.Name -contains 'sound') { $sound = [bool]$payload.sound } else { $sound = $true }
    if ($payload.PSObject.Properties.Name -contains 'launch') { $launch = [string]$payload.launch } else { $launch = $defaultLaunch }
    if ($payload.PSObject.Properties.Name -contains 'actionLabel') { $actionLabel = [string]$payload.actionLabel } else { $actionLabel = $defaultActionLabel }
    if ($payload.PSObject.Properties.Name -contains 'scenario') { $scenario = [string]$payload.scenario } else { $scenario = '' }
    if ($payload.PSObject.Properties.Name -contains 'appId' -and -not [string]::IsNullOrWhiteSpace([string]$payload.appId)) {
        $AppId = [string]$payload.appId
    }
} else {
    $notificationTitle = $Title
    $texts = @($Text | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
    $sound = -not $Silent
    $launch = $defaultLaunch
    $actionLabel = $defaultActionLabel
    $scenario = ''
}

if ([string]::IsNullOrWhiteSpace($notificationTitle)) { $notificationTitle = 'DSH' }
if ($texts.Count -eq 0) { $texts = @('') }

# -- 2. Adopt the registered AppUserModelID for this process ------------------
try {
    if (-not ('DshWinNotify.Aumid' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace DshWinNotify {
    public static class Aumid {
        [DllImport("shell32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern int SetCurrentProcessExplicitAppUserModelID(
            [MarshalAs(UnmanagedType.LPWStr)] string AppID);
    }
}
'@ -ErrorAction Stop
    }
    [void][DshWinNotify.Aumid]::SetCurrentProcessExplicitAppUserModelID($AppId)
} catch {
    # Not fatal: the named-notifier call below still gets a chance.
}

# -- 3. Load the WinRT types --------------------------------------------------
try {
    [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]
} catch {
    Write-Error ('notify.ps1: cannot load the WinRT notification types (Windows PowerShell 5.1 required) - ' + $_.Exception.Message)
    exit 3
}

# -- 4. Build the toast XML with the DOM (escaping handled for us) ------------
$document = New-Object Windows.Data.Xml.Dom.XmlDocument
$toast = $document.CreateElement('toast')
if (-not [string]::IsNullOrWhiteSpace($scenario)) { [void]$toast.SetAttribute('scenario', $scenario) }
$visual = $document.CreateElement('visual')
$binding = $document.CreateElement('binding')
[void]$binding.SetAttribute('template', 'ToastGeneric')

$allLines = @($notificationTitle) + $texts
foreach ($line in $allLines) {
    $node = $document.CreateElement('text')
    $node.InnerText = [string]$line
    [void]$binding.AppendChild($node)
}
[void]$visual.AppendChild($binding)
[void]$toast.AppendChild($visual)

# Actions must precede <audio> (toast schema order: visual, actions, audio).
$hasLaunch = -not [string]::IsNullOrWhiteSpace($launch)
if ($hasLaunch) {
    [void]$toast.SetAttribute('activationType', 'protocol')
    [void]$toast.SetAttribute('launch', $launch)
    if (-not [string]::IsNullOrWhiteSpace($actionLabel)) {
        $actions = $document.CreateElement('actions')
        $action = $document.CreateElement('action')
        [void]$action.SetAttribute('content', $actionLabel)
        [void]$action.SetAttribute('activationType', 'protocol')
        [void]$action.SetAttribute('arguments', $launch)
        [void]$actions.AppendChild($action)
        [void]$toast.AppendChild($actions)
    }
}

if ($sound) {
    $audio = $document.CreateElement('audio')
    [void]$audio.SetAttribute('src', 'ms-winsoundevent:Notification.Default')
    [void]$toast.AppendChild($audio)
}
[void]$document.AppendChild($toast)

# -- 5. Deliver ---------------------------------------------------------------
try {
    $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId)
    $notification = New-Object Windows.UI.Notifications.ToastNotification $document
    $notifier.Show($notification)
    exit 0
} catch {
    Write-Error ('notify.ps1: toast delivery failed - ' + $_.Exception.Message)
    exit 4
}
