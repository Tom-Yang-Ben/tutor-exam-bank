@echo off
chcp 65001 >nul
setlocal EnableExtensions

REM ================================================================
REM  install_desktop_shortcut.bat  在桌面建立「出題系統」與「關閉出題系統」兩個圖示（docs\desktop-launcher.md 第 2 節）
REM
REM  雙擊即可；只要做一次（搬動專案資料夾或重裝 Node.js 之後再做一次）。
REM  移除兩個圖示：在命令列執行  install_desktop_shortcut.bat --remove
REM  圖示的目標是 Windows 內建的 wscript.exe（隱藏視窗執行 scripts\desktop\run_hidden.vbs），不會留黑色視窗。
REM ================================================================

cd /d "%~dp0..\.."
set "APP=%CD%"

where node >nul 2>nul
if errorlevel 1 goto :no_node
if not exist "%APP%\scripts\desktop\install_shortcuts.js" goto :no_script

node "%APP%\scripts\desktop\install_shortcuts.js" %*
if errorlevel 1 goto :failed

echo.
echo [OK] 完成。
pause
exit /b 0

:no_node
echo [X] 找不到 Node.js（node 指令）。
echo     本專案需要 Node.js 24：https://nodejs.org 下載 LTS 安裝，裝好後關掉這個視窗、重新雙擊本檔。
goto :end_fail

:no_script
echo [X] 找不到 scripts\desktop\install_shortcuts.js，這份程式可能不完整。請先更新程式（git pull）。
goto :end_fail

:failed
echo [X] 建立捷徑失敗，原因見上方訊息。
goto :end_fail

:end_fail
echo.
pause
exit /b 1
