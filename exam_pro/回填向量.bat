@echo off
chcp 65001 >nul
cd /d "%~dp0"

REM 回填 embedding 與 search_tsv（實際邏輯是 WS-C 的 scripts\backfill_embeddings.js，這支只是殼）
REM 這一步會呼叫 Gemini Embedding API，需要 .env 裡的 GEMINI_API_KEY；
REM 可以中斷再重跑（每批一個交易，天然斷點續跑）。

if not exist "scripts\backfill_embeddings.js" (
    echo.
    echo [X] 還沒有 scripts\backfill_embeddings.js。
    echo     這支腳本由 WS-C（檢索零件）提供，等它合進來之後再執行本檔。
    echo.
    pause
    exit /b 1
)

echo 正在回填向量（會呼叫 Gemini，依題數可能要跑一段時間）...
node scripts/backfill_embeddings.js %*
if errorlevel 1 (
    echo.
    echo [X] 回填未完成（腳本以非零碼結束，通常代表還有 embedding IS NULL 的題）。
    echo     直接再執行一次本檔即可從斷點續跑。
    echo.
    pause
    exit /b 1
)

echo.
echo [OK] 回填完成。
echo.
pause
