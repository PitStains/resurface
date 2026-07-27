@echo off
rem Pulls the latest version, updates dependencies, rebuilds, then starts the app.

rem cmd re-reads this file from disk as it runs, line by line. "git pull" below
rem can rewrite this very file, and execution then resumes at a byte offset that
rem no longer means what it did - so the rest of the update runs garbled. Run
rem from a copy instead; the copy is what git is free to replace underneath us.
if not defined RESURFACE_UPDATE_HOME (
  set "RESURFACE_UPDATE_HOME=%~dp0"
  copy /y "%~f0" "%TEMP%\resurface-update-running.bat" >nul
  "%TEMP%\resurface-update-running.bat"
  exit /b %errorlevel%
)
cd /d "%RESURFACE_UPDATE_HOME%"

git pull
if errorlevel 1 (
  echo git pull failed - check the message above.
  pause & exit /b 1
)

rem "npm ci" installs exactly what package-lock.json specifies, deleting any
rem half-installed tree first. Plain "npm install" was leaving the local
rem embedding library (@huggingface/transformers) only partly installed, which
rem broke the meaning index until a manual reinstall.
call npm ci
if errorlevel 1 (
  echo Dependency install failed. Trying a clean install...
  rmdir /s /q node_modules 2>nul
  call npm install
  if errorlevel 1 ( echo Install still failing - check the message above. & pause & exit /b 1 )
)

rem Fail loudly if the embedding library is missing, rather than silently
rem falling back to rebuilding the index or breaking search.
if not exist "node_modules\@huggingface\transformers\package.json" (
  echo.
  echo The local embedding library did not install. Run "npm install" by hand,
  echo then start the app again with Start Resurface.bat.
  pause & exit /b 1
)

call npm run build:web
if errorlevel 1 ( pause & exit /b 1 )

rem Output goes to a log file rather than this window: a click inside a console
rem puts it into "Select" mode and blocks the next write, which freezes the
rem server and blanks every page. See Start Resurface.bat.
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
