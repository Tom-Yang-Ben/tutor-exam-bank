@echo off
chcp 65001 >nul
cd /d "%~dp0"
node fix_verified.js
echo.
pause
