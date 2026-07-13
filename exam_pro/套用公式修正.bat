@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在套用公式修正(會先備份再以交易更新資料庫)...
node fix_formulas.js --apply
echo.
pause
