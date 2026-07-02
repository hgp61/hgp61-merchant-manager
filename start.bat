@echo off
title HeiJin PAY Merchant Manager
cd /d "%~dp0"

set NODE_CMD=
set NPM_CMD=

REM Use bundled Node.js if available
if exist "%~dp0node-runtime\node.exe" (
    set NODE_CMD="%~dp0node-runtime\node.exe"
    set NPM_CMD="%~dp0node-runtime\npm.cmd"
)

REM Search common system Node.js paths
if "%NODE_CMD%"=="" (
    if exist "%ProgramFiles%\nodejs\node.exe" (
        set NODE_CMD="%ProgramFiles%\nodejs\node.exe"
        set NPM_CMD="%ProgramFiles%\nodejs\npm.cmd"
    )
    if exist "%ProgramFiles(x86)%\nodejs\node.exe" (
        set NODE_CMD="%ProgramFiles(x86)%\nodejs\node.exe"
        set NPM_CMD="%ProgramFiles(x86)%\nodejs\npm.cmd"
    )
    if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" (
        set NODE_CMD="%LOCALAPPDATA%\Programs\nodejs\node.exe"
        set NPM_CMD="%LOCALAPPDATA%\Programs\nodejs\npm.cmd"
    )
    if exist "C:\nodejs\node.exe" (
        set NODE_CMD="C:\nodejs\node.exe"
        set NPM_CMD="C:\nodejs\npm.cmd"
    )
)

REM Fallback to PATH node and derive npm.cmd from node location
if "%NODE_CMD%"=="" (
    where node >nul 2>&1
    if %errorlevel%==0 (
        set NODE_CMD=node
        for /f "delims=" %%i in ('where node') do (
            if exist "%%~dpinpm.cmd" set NPM_CMD="%%~dpinpm.cmd"
        )
    )
)

REM Final fallback for npm
if "%NPM_CMD%"=="" (
    where npm >nul 2>&1
    if %errorlevel%==0 set NPM_CMD=npm
)

if "%NODE_CMD%"=="" (
    echo ============================================================
    echo  ERROR: Node.js not found.
    echo.
    echo  Please install Node.js first:
    echo  https://nodejs.org/en/download/
    echo ============================================================
    pause
    exit /b 1
)

if "%NPM_CMD%"=="" (
    echo ============================================================
    echo  ERROR: Node.js found, but npm not found.
    echo.
    echo  Please reinstall Node.js:
    echo  https://nodejs.org/en/download/
    echo ============================================================
    pause
    exit /b 1
)

if not exist "node_modules\" (
    echo [INIT] Installing dependencies...
    call %NPM_CMD% install
    if %errorlevel% neq 0 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
    echo.
)

echo ============================================================
echo    HeiJin PAY Merchant Manager
echo ============================================================
echo.
echo Server: http://localhost:3000
echo.
%NODE_CMD% server.js
pause
