@echo off
chcp 65001 >nul
cd /d "%~dp0"

REM PostgreSQL 備份：借容器裡的 pg_dump 倒出自訂格式（-Fc）到 backups\
REM 失敗時 scripts\backup.js 會寫 backups\LAST_FAILED.txt，這支則停在畫面上不關視窗。
REM 每次執行（成功或失敗）都會 append 一行到 backups\backup.log；要查哪幾天沒備到看那個檔。

echo 正在備份資料庫（第一次可能要等容器回應）...
node scripts/backup.js %*
if errorlevel 1 (
    echo.
    echo ========================================
    echo  [X] 備份失敗！請看上面的訊息與
    echo      backups\LAST_FAILED.txt
    echo ========================================
    echo.
    pause
    exit /b 1
)

echo.
echo [OK] 備份完成，檔案在 backups\ 資料夾（執行紀錄在 backups\backup.log）。
echo      還原方式見 docs\cutover-runbook.md 的「回滾」段。
echo.
pause
