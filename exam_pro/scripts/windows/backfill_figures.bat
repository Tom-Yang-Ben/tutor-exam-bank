@echo off
chcp 65001 >nul
setlocal EnableExtensions

REM ================================================================
REM  backfill_figures.bat  舊題補附圖：產生提議（只跑 dry-run，不寫資料庫）
REM  〔Owner 決策單 2026-09-25 B20〕說明見 docs\figures.md「舊題補附圖」
REM
REM  用法（兩種都可以）：
REM    1. 把放原卷 PDF 的資料夾（例如桌面上的「各校考卷」）拖到這個檔案的圖示上放開；
REM    2. 直接雙擊，畫面問的時候把資料夾拖進視窗、按 Enter。
REM  會掃描資料夾（含子資料夾）裡的 PDF，把裁出的圖對到題庫裡沒有附圖的舊題，產生
REM  exam_pro\data\figure-backfill\時間\ 底下的 proposals.csv（提議檔）、preview.html（預覽頁）與暫存圖。
REM  不寫資料庫、不呼叫任何 AI 模型。老師確認提議檔之後，另外執行 --apply 才會寫進題庫（畫面最後會印出指令）。
REM  需要資料庫在執行（先雙擊 exam_pro\啟動資料庫.bat）。完整輸出寫在 exam_pro\data\figure-backfill\dry-run_時間.log。
REM ================================================================

cd /d "%~dp0..\.."
set "APP=%CD%"
set "ROOT=%APP%\data\figure-backfill"
if not exist "%ROOT%" mkdir "%ROOT%"
set "TS="
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss"') do set "TS=%%i"
if not defined TS set "TS=%RANDOM%"
set "OUT=%ROOT%\%TS%"
set "LOG=%ROOT%\dry-run_%TS%.log"

call :log ----------------------------------------------------------------
call :log 舊題補附圖：產生提議（不寫資料庫、不呼叫 AI 模型）%DATE% %TIME%
call :log 專案目錄：%APP%
call :log ----------------------------------------------------------------

where node >nul 2>nul
if errorlevel 1 goto :no_node
if not exist "%APP%\.env" goto :no_env
if not exist "%APP%\node_modules" goto :no_modules

set "PDFDIR=%~1"
if defined PDFDIR goto :have_dir
echo 請把放原卷 PDF 的資料夾（例如桌面上的「各校考卷」）拖進這個視窗，再按 Enter：
set /p "PDFDIR=資料夾："
:have_dir
if not defined PDFDIR goto :no_dir
set "PDFDIR=%PDFDIR:"=%"
if not exist "%PDFDIR%\" goto :no_dir
call :log 原卷資料夾：%PDFDIR%
call :log 輸出資料夾：%OUT%
echo.

set "TEE=node "%APP%\eval\tools\tee_run.js" "%LOG%""
%TEE% node "%APP%\scripts\backfill_figures.js" --dir "%PDFDIR%" --out-dir "%OUT%"
if errorlevel 1 goto :run_failed
if not exist "%OUT%\proposals.csv" goto :no_proposals

call :log
call :log [OK] 已產生提議檔，資料庫沒有任何改動。
echo.
echo   預覽頁：%OUT%\preview.html
echo   提議檔：%OUT%\proposals.csv
echo.
echo 下一步：
echo   1. 預覽頁會自動用瀏覽器打開：逐題看裁出來的圖是不是這一題的圖。
echo   2. 用 Excel 開提議檔，不要套用的題把整列刪掉（其他欄位不用改），存檔時選「CSV UTF-8（逗號分隔）」。
echo   3. 確認完，在 exam_pro 資料夾開命令列執行下面這一行，才會真的寫進題庫：
echo      npm run figures:backfill -- --apply "%OUT%\proposals.csv"
echo.
start "" "%OUT%\preview.html"
echo 完整輸出：%LOG%
pause
exit /b 0

:no_proposals
call :log
call :log 這次沒有可以提議的圖（原因統計在上面），沒有產生提議檔；資料庫沒有任何改動。
echo 常見原因：資料夾裡的卷都是掃描檔（沒有文字層），或題庫裡對應的題都已經有附圖。
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
call :log [X] 找不到 Node.js（node 指令）。
echo     本專案需要 Node.js：https://nodejs.org 下載 LTS 安裝，裝好後關掉這個視窗、重新執行本檔。
goto :end_fail

:no_env
call :log [X] 找不到 exam_pro\.env（資料庫連線設定）。
echo     請先把 exam_pro\.env.example 複製成 .env 並填好 DATABASE_URL，再重新執行本檔。
goto :end_fail

:no_modules
call :log [X] 找不到 exam_pro\node_modules（還沒安裝相依套件）。
echo     請在 exam_pro 資料夾執行 npm install 之後，再重新執行本檔。
goto :end_fail

:no_dir
call :log [X] 找不到原卷資料夾。
echo     請把「資料夾」（不是單一 PDF 檔）拖到本檔的圖示上，或雙擊後把資料夾拖進視窗再按 Enter。
goto :end_fail

:run_failed
call :log [X] 產生提議失敗（錯誤訊息在上面）。
echo     常見原因：資料庫沒有在執行（先雙擊 exam_pro\啟動資料庫.bat），或 .env 的 DATABASE_URL 不對。
goto :end_fail

:end_fail
echo.
echo 完整輸出：%LOG%
>>"%LOG%" echo [X] 中止 %DATE% %TIME%
pause
exit /b 1
