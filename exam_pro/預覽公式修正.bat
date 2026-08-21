@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在產生公式修正預覽(不會寫入資料庫)...
node scripts/formulas.js preview
if errorlevel 1 (
    echo.
    echo [X] 預覽失敗，請看上面的訊息。
    echo.
    pause
    exit /b 1
)
echo.
echo ====== 預覽完成，請開啟「公式修正預覽.html」 ======
pause
