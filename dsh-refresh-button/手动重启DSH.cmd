@echo off
rem ===========================================================================
rem  Manual DSH restart (diagnostic / fallback)
rem
rem  This runs the SAME restart.ps1 the plugin button uses, so it is a good
rem  triage tool:
rem    * DSH restarts      -> the script is fine; the problem is host-side spawn
rem                           (host log lines start with "[host]", count them)
rem    * nothing happens   -> the log tail printed below shows the last step
rem
rem  Log: %USERPROFILE%\.dsh\logs\dsh-refresh-button.log
rem
rem  ASCII-only on purpose: cmd.exe parses a .cmd using the ANSI code page
rem  (GBK here), so UTF-8 Chinese content turns into garbage commands.
rem ===========================================================================
setlocal
set "LOG=%USERPROFILE%\.dsh\logs\dsh-refresh-button.log"

echo Requesting DSH restart via restart.ps1 ...
start "" powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0restart.ps1" -Action restart

echo Waiting 10 seconds for the app to go down and come back ...
timeout /t 10 >nul

echo.
echo ---- tasklist (DeepSeek) ----
tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" 2>nul | findstr /I "DeepSeek" || echo   (no DeepSeek Harness.exe running)

echo.
echo ---- log tail ----
if exist "%LOG%" (
  powershell.exe -NoProfile -Command "Get-Content -LiteralPath '%LOG%' -Tail 20"
) else (
  echo   (log not created: %LOG%)
)

echo.
pause
exit /b 0
