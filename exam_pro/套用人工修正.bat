@echo off
chcp 65001 >nul
cd /d "%~dp0"
node fix_manual.js --apply
echo.
pause
