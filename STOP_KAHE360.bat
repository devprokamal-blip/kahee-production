@echo off
title KAHE 360 - Stop Server
echo Stopping KAHE 360 Internal Operations server...

REM Kill any node.exe process listening on port 3000
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING"') do (
  echo Stopping process ID %%P
  taskkill /F /PID %%P >nul 2>&1
)

echo Done.
pause
