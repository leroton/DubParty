@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-dubparty.ps1"
set "DUBPARTY_EXIT_CODE=%ERRORLEVEL%"
if not "%DUBPARTY_EXIT_CODE%"=="0" pause
exit /b %DUBPARTY_EXIT_CODE%
