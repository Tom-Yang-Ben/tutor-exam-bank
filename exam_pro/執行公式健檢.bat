@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在連線資料庫並健檢題庫公式...
node scripts/formulas.js audit
if errorlevel 1 (
    echo.
    echo [X] 健檢失敗，請看上面的訊息。
    echo.
    pause
    exit /b 1
)
echo.
echo ====== 完成！請開啟「公式健檢報告.html」 ======
pause
