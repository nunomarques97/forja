@echo off
rem Runs FORJA with the Kilo provider on the project passed as the first argument.
rem Expects FORJA in %USERPROFILE%\Desktop\Repositorios\forja, the model profile in
rem %USERPROFILE%\forja-kilo.json and the goal in %USERPROFILE%\forja-goal.md.
title FORJA
if "%~1"=="" (echo Usage: forja-kilo.cmd ^<project path^> & pause & exit /b 1)
cd /d "%~1" || (pause & exit /b 1)
node "%USERPROFILE%\Desktop\Repositorios\forja\bin\forja.mjs" start --provider kilo --config "%USERPROFILE%\forja-kilo.json" --goal-file "%USERPROFILE%\forja-goal.md"
echo.
echo FORJA finished. Review the changes with: git status and git diff
pause
