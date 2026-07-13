@echo off
chcp 65001 >nul
cd /d "%~dp0"
node setup_index_views.js
echo.
pause
