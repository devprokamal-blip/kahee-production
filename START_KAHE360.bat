@echo off
setlocal enabledelayedexpansion
title KAHE 360 - Internal Operations
cd /d "%~dp0"

echo ========================================
echo  KAHE 360 INTERNAL OPERATIONS - STARTUP
echo ========================================

REM --- Check Node.js is installed ---
where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo ERROR: Node.js was not found on this PC.
  echo Please install Node.js LTS from https://nodejs.org and try again.
  echo.
  pause
  exit /b 1
)

REM --- Check npm is installed ---
where npm >nul 2>&1
if errorlevel 1 (
  echo.
  echo ERROR: npm was not found. Reinstall Node.js ^(npm ships with it^).
  echo.
  pause
  exit /b 1
)

echo Node.js and npm found.

REM --- Install dependencies if missing ---
if not exist "node_modules" (
  echo.
  echo Installing dependencies, please wait...
  call npm install
  if errorlevel 1 (
    echo.
    echo ERROR: npm install failed. See the messages above for details.
    echo Startup stopped - the server will NOT be started.
    echo.
    pause
    exit /b 1
  )
  echo Dependencies installed.
) else (
  echo Dependencies already installed.
)

REM --- PostgreSQL (DB-M1): the database is a PostgreSQL server, configured in .env ---
if not exist ".env" (
  echo.
  echo ERROR: .env was not found.
  echo   1. Install PostgreSQL 13+ and make sure the service is running.
  echo   2. copy .env.example .env   and fill in DATABASE_URL / DATABASE_MIGRATION_URL.
  echo   3. First time only: npm run db:bootstrap   ^(creates the two roles and the database^)
  echo   See docs\POSTGRES_MIGRATION_RUNBOOK.md
  pause
  exit /b 1
)
echo.
echo Applying database migrations ^(versioned, safe to run every start^)...
call npm run db:migrate
if errorlevel 1 (
  echo.
  echo ERROR: Database migration failed. Is PostgreSQL running and is DATABASE_MIGRATION_URL in .env correct?
  pause
  exit /b 1
)

REM --- Seed demo database (idempotent - safe to run every start; this also
REM     self-heals a stale/leftover database from an older build) ---
echo.
echo Seeding demo database...
call npm run seed
if errorlevel 1 (
  echo.
  echo ERROR: Database seed failed. See the messages above for details.
  echo Startup stopped - the server will NOT be started.
  echo.
  echo If this keeps failing, check that PostgreSQL is running and DATABASE_URL in .env is correct,
  echo then run: npm run db:migrate ^&^& npm run seed
  echo and run START_KAHE360.bat again.
  echo.
  pause
  exit /b 1
)
echo Database seeded.

REM --- Start the server in the background ---
echo.
echo Starting KAHE 360 Internal Operations server...
if exist "server_output.log" del /q "server_output.log" >nul 2>&1
start "KAHE360-SERVER" /min cmd /c "node server.js > server_output.log 2>&1"

REM --- Wait for the server to actually respond before opening the browser ---
set "SERVER_OK=0"
for /L %%i in (1,1,20) do (
  >"%TEMP%\kahe_health.txt" (
    curl -s -o nul -w "%%{http_code}" http://127.0.0.1:3000/api/system/health 2>nul
  )
  set /p HEALTH=<"%TEMP%\kahe_health.txt"
  if "!HEALTH!"=="200" (
    set "SERVER_OK=1"
    goto :serverReady
  )
  timeout /t 1 /nobreak >nul
)

:serverReady
if "!SERVER_OK!"=="0" (
  echo.
  echo ERROR: The server did not respond within 20 seconds.
  echo It did NOT start correctly - the browser will NOT be opened.
  echo Check server_output.log in this folder for the real error.
  echo.
  pause
  exit /b 1
)

echo Server is running and responding.
start "" "http://127.0.0.1:3000/register"

echo.
echo KAHE 360 is running in a minimized window ^(KAHE360-SERVER^).
echo Laptop:    http://127.0.0.1:3000
echo Phone/LAN: see server_output.log for your LAN address.
echo.
echo You can close this window. Use STOP_KAHE360.bat to stop the server.
pause
exit /b 0
