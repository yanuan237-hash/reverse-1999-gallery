@echo off
rem Convenience wrapper with an ASCII-only name (in case a Chinese
rem filename is inconvenient). The real launcher is the .bat next to it
rem (its name is Chinese); this file just calls it.
cd /d "%~dp0"

if exist "%~dp0启动.bat" (
  call "%~dp0启动.bat" %*
  exit /b %ERRORLEVEL%
)

if exist "%~dp0desktop\启动.bat" (
  call "%~dp0desktop\启动.bat" %*
  exit /b %ERRORLEVEL%
)

echo   [X] Could not find the launcher next to this file.
pause
exit /b 1
