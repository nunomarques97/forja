@echo off
rem FORJA with the Kilo provider, in its own window.
rem   forja-kilo.cmd <project path>          start with %USERPROFILE%\forja-goals\<project folder>.md
rem   forja-kilo.cmd <project path> resume   continue the project's unfinished run
rem Expects FORJA in %USERPROFILE%\Desktop\Repositorios\forja and the model
rem profile in %USERPROFILE%\forja-kilo.json.
setlocal
set "FORJA=%USERPROFILE%\Desktop\Repositorios\forja\bin\forja.mjs"
if "%~1"=="" (echo Usage: forja-kilo.cmd ^<project path^> [resume] & pause & exit /b 1)
title FORJA %~nx1 - running
cd /d "%~1" || (title FORJA %~nx1 - STOPPED & pause & exit /b 1)
if /i "%~2"=="resume" (
  node "%FORJA%" core resume
) else (
  node "%FORJA%" start --provider kilo --config "%USERPROFILE%\forja-kilo.json" --goal-file "%USERPROFILE%\forja-goals\%~nx1.md"
)
set "CODE=%ERRORLEVEL%"
rem The title and a short sound tell the outcome without watching the window.
if "%CODE%"=="0" (
  title FORJA %~nx1 - DONE
  powershell -NoProfile -Command "[console]::beep(880,200); [console]::beep(1175,300)" >nul 2>&1
) else (
  title FORJA %~nx1 - STOPPED
  powershell -NoProfile -Command "[console]::beep(440,500); [console]::beep(330,700)" >nul 2>&1
)
echo.
if "%CODE%"=="0" (echo FORJA finished. Review the changes with: git status and git diff) else (echo FORJA stopped before finishing. Inspect with: node "%FORJA%" core status  -- then resume with: forja-kilo.cmd "%~1" resume)
pause
