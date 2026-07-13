@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在連線資料庫並健檢題庫公式...
node audit_formulas.js
echo.
echo ====== 完成！請開啟「公式健檢報告.html」 ======
pause
