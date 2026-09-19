@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

rem ============================================================
rem  Reverse: 1999 Wallpaper Downloader - launcher
rem  NOTE: kept ASCII-only on purpose. cmd.exe reads .bat files
rem        using the OEM codepage, so Chinese text here would
rem        corrupt the script itself.
rem
rem  Usage:  double-click              -> start
rem          this file --test         -> self check, no window
rem          set PORT=xxxx && this    -> use another port
rem
rem  Works both from the project root (1999\) and from desktop\.
rem ============================================================

if not defined PORT set "PORT=19990"
set "URL=http://127.0.0.1:%PORT%/"
set "TESTMODE="
if /i "%~1"=="--test" set "TESTMODE=1"

rem ---- locate the app (root layout or desktop\ layout) ----
set "APPDIR=%~dp0"
if not exist "%APPDIR%src\server.mjs" (
  if exist "%APPDIR%desktop\src\server.mjs" set "APPDIR=%~dp0desktop\"
)
if not exist "%APPDIR%src\server.mjs" (
  echo   [X] Cannot find src\server.mjs next to this file.
  echo       Keep this launcher together with the app folder.
  echo.
  pause
  exit /b 1
)
cd /d "%APPDIR%"

echo.
echo   Reverse: 1999  -  Wallpaper Downloader
echo   ==========================================
echo.

rem ---- 1. Node.js check ----
where node >nul 2>nul
if errorlevel 1 (
  echo   [X] Node.js not found.
  echo       Install Node.js 18+ from https://nodejs.org/
  echo       then run this file again.
  echo.
  if not defined TESTMODE pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do echo   [1/4] Node.js %%v  OK

rem ---- 2. Is a service already listening? ----
set "RUNNING="
powershell -NoProfile -Command "try{$c=New-Object Net.Sockets.TcpClient;$c.Connect('127.0.0.1',%PORT%);$c.Close();exit 0}catch{exit 1}" >nul 2>nul
if not errorlevel 1 set "RUNNING=1"
if defined RUNNING (echo   [2/4] Service already listening on port %PORT%) else (echo   [2/4] Port %PORT% is free)

rem ---- 3. Pick a browser that supports app mode ----
set "BROWSER="
for %%B in (
  "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LocalAppData%\Google\Chrome\Application\chrome.exe"
) do (
  if not defined BROWSER if exist %%B set "BROWSER=%%~B"
)
if defined BROWSER (echo   [3/4] Browser: "!BROWSER!") else (echo   [3/4] Edge/Chrome not found - will use the default browser)

rem ---- 4. Open the application window ----
if defined RUNNING goto :skipopen
if defined TESTMODE goto :skipopen
if defined BROWSER (
  echo   [4/4] Opening application window...
  ping -n 2 127.0.0.1 >nul
  start "" "!BROWSER!" --app="%URL%" --window-size=1400,920 --user-data-dir="%LocalAppData%\reverse1999-gui" --no-first-run --no-default-browser-check
) else (
  ping -n 2 127.0.0.1 >nul
  start "" "%URL%"
)
goto :serve

:skipopen
if defined TESTMODE (echo   [4/4] Test mode - window not opened) else (echo   [4/4] Skipped - window already open)

:serve
echo.
echo   Service : %URL%
echo.
if defined TESTMODE (
  echo   Running self check, about 10 seconds...
  rem pushd first: a space in the path (e.g. "AI perfect") would split node's argument
  start "r1999-test" /min cmd /c "pushd ""%APPDIR%"" && node src\server.mjs %PORT% 1> ""%TEMP%\r1999-selftest.log"" 2>&1"
  ping -n 4 127.0.0.1 >nul
  powershell -NoProfile -Command "try{$r=Invoke-WebRequest -Uri '%URL%' -UseBasicParsing -TimeoutSec 10;Write-Host ('   Page : HTTP ' + $r.StatusCode + ', ' + $r.RawContentLength + ' bytes')}catch{Write-Host ('   Page : FAILED - ' + $_.Exception.Message)}"
  powershell -NoProfile -Command "try{$j=Invoke-RestMethod -Uri ('%URL%' + 'api/remote') -TimeoutSec 30;Write-Host ('   API  : ' + $j.items.Count + ' wallpapers from official site')}catch{Write-Host ('   API  : FAILED - ' + $_.Exception.Message)}"
  echo.
  echo   --- server log ---
  type "%TEMP%\r1999-selftest.log" 2>nul
  echo   ------------------
  echo   Stopping test service...
  powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*server.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>nul
  echo.
  echo   Self check finished.
  echo.
  exit /b 0
)

echo   Keep this window open while using the app.
echo   Close this window to stop the service.
echo.
node src\server.mjs %PORT%

echo.
echo   [X] Service exited with code %ERRORLEVEL%.
echo.
pause
exit /b %ERRORLEVEL%
