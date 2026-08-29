@echo off
setlocal
cd /d "%~dp0"
title Fruit Addicts CRM

echo ======================================================
echo   Fruit Addicts CRM - starting...
echo ======================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found.
  echo Please install Node.js 24+ from https://nodejs.org then run this again.
  echo.
  pause
  exit /b 1
)

if not exist ".env" (
  echo - Creating .env from .env.example
  copy ".env.example" ".env" >nul
)

if not exist "node_modules" (
  echo - Installing dependencies ^(first run only, please wait^)
  call npm install
)

echo - Preparing database + demo data
call npm run seed

echo - Setting admin password to match .env
call npm run reset-admin

echo.
echo ======================================================
echo   Server:  http://localhost:3000/admin
echo   Members: http://localhost:3000/liff
echo   Login:   admin  /  ^(ADMIN_BOOTSTRAP_PASSWORD in .env^)
echo.
echo   The server runs in a NEW window titled
echo   "Fruit Addicts CRM Server". Close THAT window to stop.
echo ======================================================
echo.

REM Start the server in its own window (stays open), working dir = this folder.
start "Fruit Addicts CRM Server" /d "%~dp0" cmd /k node src\server.ts

REM Wait a moment for it to boot, then open the browser.
timeout /t 3 >nul
start "" "http://localhost:3000/admin"

echo Browser opened. You can close THIS window now.
echo.
pause
endlocal
