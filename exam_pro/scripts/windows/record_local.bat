@echo off
chcp 65001 >nul
setlocal EnableExtensions

REM ================================================================
REM  record_local.bat  以本機模型重錄 CI 用的 cassette 與向量（docs\local-mode.md 第 6 條第 4 點、第 10 條）
REM
REM  雙擊即可。依序：
REM    1. npm run db:up          啟動資料庫容器（需要 Docker Desktop 在執行）
REM    2. npm run migrate:test   測試庫套 migration（測試庫是 tmpfs，每次啟動都是空的）
REM    3. npm run cassettes:rerecord，自動輸入 yes
REM       錄前會先檢查 Ollama 與三個模型、PaddleOCR 自我檢查、測試庫的 migration，任一項沒過就停、一次都不錄。
REM  只錄部分 suite：在命令列執行  record_local.bat classify,nlq  （會變成 --suites classify,nlq）。
REM  完整輸出寫在 exam_pro\data\local_ai\record_時間.log。
REM
REM  本機模型不花錢、不連外，但 CPU 上很慢：整套可能要一整天。請接上電源，並把睡眠設成「永不」。
REM  還沒裝本機 AI 的話，先雙擊同一個資料夾的 setup_local_ai.bat。
REM ================================================================

cd /d "%~dp0..\.."
set "APP=%CD%"
set "LOGDIR=%APP%\data\local_ai"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
set "TS="
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss"') do set "TS=%%i"
if not defined TS set "TS=%RANDOM%"
set "LOG=%LOGDIR%\record_%TS%.log"
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"

call :log ----------------------------------------------------------------
call :log 本機重錄開始 %DATE% %TIME%
call :log 專案目錄：%APP%
call :log log 檔：%LOG%
call :log ----------------------------------------------------------------
echo 整套錄製在 CPU 上可能要一整天；開始錄之前會先印出盤點與粗估的時間。
echo 請接上電源，並到「設定 → 系統 → 電源」把睡眠設成「永不」；錄製期間電腦可以照常使用，只是會很慢。
echo.

where node >nul 2>nul
if errorlevel 1 goto :no_node
where npm >nul 2>nul
if errorlevel 1 goto :no_node
if not exist "%APP%\.env" goto :no_env
if not exist "%APP%\node_modules" goto :no_modules
set "TEE=node "%APP%\eval\tools\tee_run.js" "%LOG%""

REM ── 1. 資料庫容器 ──
call :log [1/3] 啟動資料庫容器（npm run db:up）
docker info >nul 2>&1
if errorlevel 1 goto :no_docker
%TEE% npm run db:up
if errorlevel 1 goto :dbup_failed

REM ── 2. 測試庫 migration ──
call :log [2/3] 測試庫套用 migration（npm run migrate:test）
%TEE% npm run migrate:test
if errorlevel 1 goto :migrate_failed

REM ── 3. 重錄（自動輸入 yes）──
set "SUITES="
if not "%~1"=="" set "SUITES=-- --suites %*"
call :log [3/3] 重錄 cassette 與向量（npm run cassettes:rerecord %SUITES%；自動輸入 yes）
echo yes| %TEE% npm run cassettes:rerecord %SUITES%
set "RC=%ERRORLEVEL%"
if "%RC%"=="0" goto :done_ok

call :log
call :log [!] 錄製或回放驗證沒有全過（結束碼 %RC%）。
echo     先看 log 最後的「回放驗證」表：
echo       - 錄前檢查沒過（Ollama、模型、OCR、測試庫）：照畫面上的處置做完，再雙擊本檔；
echo       - 還有 replay miss：某些呼叫沒錄到，重跑本檔即可（只會多花時間，不花錢）；
echo       - 門檻未達：不會自動放寬，把 log 交給維護的人，由 Owner 另行裁決（docs\local-mode.md 第 6 條第 3 點）。
echo.
echo 完整輸出：%LOG%
pause
exit /b %RC%

:done_ok
call :log
call :log [OK] 重錄與回放驗證都通過。
echo.
echo 下一步（在 exam_pro 資料夾）：
echo   1. git add eval/cassettes eval/fixtures/embeddings.*.json，commit、push。
echo   2. npm run cassettes:prune 會列出 CI 不再讀到的舊檔，包括原本 Gemini 錄的 cassette；
echo      還想保留切回 Gemini 的可能就先不要 --apply（見 docs\local-mode.md 第 10 條）。
echo.
echo 完整輸出：%LOG%
pause
exit /b 0

REM ================================================================
REM  子程序與失敗處置
REM ================================================================

:log
echo(%*
>>"%LOG%" echo(%*
exit /b 0

:no_node
call :log [X] 找不到 Node.js（node／npm 指令）。
echo     本專案需要 Node.js 24：https://nodejs.org 下載 LTS 安裝，裝好後關掉這個視窗、重新雙擊本檔。
goto :end_fail

:no_env
call :log [X] 找不到 exam_pro\.env。
echo     請先把 exam_pro\.env.example 複製成 .env（要改哪幾行見 docs\local-mode.md 第 10 條），再重新雙擊本檔。
goto :end_fail

:no_modules
call :log [X] 找不到 exam_pro\node_modules（還沒安裝相依套件）。
echo     請在 exam_pro 資料夾執行 npm install 之後，再重新雙擊本檔。
goto :end_fail

:no_docker
call :log [X] 偵測不到 Docker 引擎。
echo     請先啟動 Docker Desktop，等鯨魚圖示不再轉動後，再重新雙擊本檔。
goto :end_fail

:dbup_failed
call :log [X] 資料庫容器啟動失敗（npm run db:up）。
echo     常見原因：5442 或 5433 埠被本機既有的 PostgreSQL 佔用。檢查指令：netstat -ano ^| findstr ":5433"
goto :end_fail

:migrate_failed
call :log [X] 測試庫套用 migration 失敗（npm run migrate:test）。
echo     請確認 .env 的 TEST_DATABASE_URL 是 postgres://exam:exam@localhost:5433/tutor_exam_bank_test。
goto :end_fail

:end_fail
echo.
echo 完整輸出：%LOG%
>>"%LOG%" echo [X] 中止 %DATE% %TIME%
pause
exit /b 1
