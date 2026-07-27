@echo off
rem Starts Resurface: syncs the vault, serves the app, opens your browser.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install it from https://nodejs.org and run this again.
  pause & exit /b 1
)
if not exist node_modules (
  echo First run: installing dependencies...
  call npm ci
  if errorlevel 1 ( call npm install )
  if errorlevel 1 ( pause & exit /b 1 )
)
rem A half-installed embedding library makes the meaning index look empty and
rem rebuild itself, so check for it rather than starting into a broken state.
if not exist "node_modules\@huggingface\transformers\package.json" (
  echo.
  echo The local embedding library is missing. Repairing...
  call npm install
  if not exist "node_modules\@huggingface\transformers\package.json" (
    echo Could not install it. Run "npm install" by hand and try again.
    pause & exit /b 1
  )
)
if not exist packages\web\dist (
  echo First run: building the web app...
  call npm run build:web
  if errorlevel 1 ( pause & exit /b 1 )
)
rem --------------------------------------------------------------------------
rem The server's output goes to a log file, never straight to this window.
rem Clicking inside a Windows console window puts it into "Select" mode, which
rem blocks the next write by the process that owns it. That is enough to freeze
rem the server in place: every page in the browser goes blank and stays blank
rem until somebody presses Esc in a window they had no reason to suspect.
rem Writing to a file instead makes a stray click harmless.
rem --------------------------------------------------------------------------
if not defined RESURFACE_PORT set "RESURFACE_PORT=7433"
set "RS_LOGDIR=%LOCALAPPDATA%\Resurface\logs"
if not exist "%RS_LOGDIR%" mkdir "%RS_LOGDIR%"
if exist "%RS_LOGDIR%\server.log" move /y "%RS_LOGDIR%\server.log" "%RS_LOGDIR%\server-previous.log" >nul
echo.
echo   Resurface is starting: http://127.0.0.1:%RESURFACE_PORT%
echo   Log:   %RS_LOGDIR%\server.log
echo   Close this window to stop the app.
echo.
call npm run serve >> "%RS_LOGDIR%\server.log" 2>&1
echo.
echo Resurface has stopped. The end of its log:
echo ----------------------------------------------------------------------
powershell -NoProfile -Command "Get-Content -LiteralPath ($env:RS_LOGDIR + '\server.log') -Tail 30"
echo ----------------------------------------------------------------------
pause
