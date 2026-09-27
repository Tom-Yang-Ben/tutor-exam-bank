@echo off
chcp 65001 >nul
setlocal EnableExtensions

REM ================================================================
REM  wsl_memory_check.bat  WSL／Docker 記憶體與 Smart App Control 的檢查（docs\desktop-app-design.md 第 10 節；DA-14、DA-9）
REM
REM  只讀取與記錄：.wslconfig 的內容、vmmem／VmmemWSL 的記憶體、總記憶體與使用中、Docker Desktop 與 Ollama 有沒有在跑、
REM  Smart App Control 的狀態。結果附加到 exam_pro\data\logs\wsl_check-日期.log。
REM  不改任何設定、不執行 wsl --shutdown、不開關任何程式：重錄或上傳進行中也可以跑。
REM  用法：雙擊後按 1／2／3 選這次的情況；或在命令列執行  wsl_memory_check.bat idle（或 upload、rerecord）
REM ================================================================

cd /d "%~dp0..\.."
set "APP=%CD%"

where node >nul 2>nul
if errorlevel 1 goto :no_node
if not exist "%APP%\scripts\desktop\wsl_memory_check.js" goto :no_script

set "SCENE=%~1"
if not "%SCENE%"=="" goto :run

echo 這次檢查是在哪一種情況？
echo   1  閒置：Docker 開著，沒有上傳考卷、沒有重錄
echo   2  上傳：正在拆一份考卷
echo   3  重錄：record_local.bat 正在跑
choice /c 123 /n /m "請按 1、2 或 3："
if errorlevel 3 goto :scene_rerecord
if errorlevel 2 goto :scene_upload
set "SCENE=idle"
goto :run

:scene_upload
set "SCENE=upload"
goto :run

:scene_rerecord
set "SCENE=rerecord"
goto :run

:run
node "%APP%\scripts\desktop\wsl_memory_check.js" --scene %SCENE%
if errorlevel 1 goto :failed

echo.
echo [OK] 完成。結果也寫在 exam_pro\data\logs\wsl_check-日期.log。
pause
exit /b 0

:no_node
echo [X] 找不到 Node.js（node 指令）。
echo     本專案需要 Node.js 24：https://nodejs.org 下載 LTS 安裝，裝好後關掉這個視窗、重新雙擊本檔。
goto :end_fail

:no_script
echo [X] 找不到 scripts\desktop\wsl_memory_check.js，這份程式可能不完整。請先更新程式（git pull）。
goto :end_fail

:failed
echo [X] 檢查沒有完成，原因見上方訊息。
goto :end_fail

:end_fail
echo.
pause
exit /b 1
