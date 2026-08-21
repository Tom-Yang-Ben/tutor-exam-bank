@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在套用公式修正(會先備份再以交易更新資料庫)...
echo 提醒：請先執行「預覽公式修正.bat」確認過內容再套用。
node scripts/formulas.js apply
if errorlevel 1 (
    echo.
    echo [X] 套用失敗，資料庫已回滾。請看上面的訊息。
    echo.
    pause
    exit /b 1
)
echo.
pause
