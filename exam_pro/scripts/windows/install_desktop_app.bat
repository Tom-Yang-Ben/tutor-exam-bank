@echo off
chcp 65001 >nul
setlocal EnableExtensions

REM ================================================================
REM  install_desktop_app.bat  在桌面建立「出題系統（桌面版）」圖示（Electron 桌面版 B1；docs\desktop-app-design.md 第 6.2 節）
REM
REM  雙擊即可。第一次會在 repo 的 desktop 資料夾執行 npm ci 並下載 Electron（100 多 MB），之後只建立圖示。
REM  從 repo 啟動（DA-6＝1，U1）：圖示的目標是 desktop\node_modules\electron\dist\electron.exe，參數是 desktop 資料夾。
REM  桌面啟動器 A 的「出題系統」「關閉出題系統」兩個圖示不受影響（install_desktop_shortcut.bat 照舊）。
REM
REM  更新程式（git pull）後 desktop\package-lock.json 有變時，加 --reinstall 重裝 Electron：
REM      install_desktop_app.bat --reinstall
REM  移除圖示：install_desktop_app.bat --remove
REM ================================================================

cd /d "%~dp0..\..\.."
set "REPO=%CD%"
set "DESKTOP=%REPO%\desktop"
set "ELECTRON=%DESKTOP%\node_modules\electron\dist\electron.exe"
set "MODE=install"
if /i "%~1"=="--remove" set "MODE=remove"
if /i "%~1"=="--reinstall" set "MODE=reinstall"

if not exist "%DESKTOP%\package.json" goto :no_desktop
if "%MODE%"=="remove" goto :remove

where node >nul 2>nul
if errorlevel 1 goto :no_node
where npm >nul 2>nul
if errorlevel 1 goto :no_node
if not exist "%REPO%\exam_pro\node_modules" goto :no_exam_modules

if "%MODE%"=="reinstall" goto :install_electron
if exist "%ELECTRON%" goto :shortcut

:install_electron
echo 安裝桌面版需要的 Electron（第一次要下載 100 多 MB，約需幾分鐘）...
pushd "%DESKTOP%"
call npm ci --no-audit --no-fund
if errorlevel 1 goto :npm_failed
REM Electron 44 起 npm ci 不會下載執行檔，要另外執行它的 install.js
node "%DESKTOP%\node_modules\electron\install.js"
if errorlevel 1 goto :npm_failed
popd
if not exist "%ELECTRON%" goto :no_electron

:shortcut
"%ELECTRON%" "%DESKTOP%" --install-shortcut
if errorlevel 1 goto :shortcut_failed
echo.
echo [OK] 完成。之後點桌面的「出題系統（桌面版）」就會開起整套系統（說明：docs\desktop-app-design.md 第 6.2 節）。
pause
exit /b 0

:remove
if not exist "%ELECTRON%" goto :remove_manual
"%ELECTRON%" "%DESKTOP%" --remove-shortcut
echo.
pause
exit /b 0

:remove_manual
echo 找不到 Electron，無法自動移除；請直接把桌面的「出題系統（桌面版）」圖示拖到資源回收筒。
pause
exit /b 0

:no_desktop
echo [X] 找不到 desktop\package.json，這份程式可能不完整。請先更新程式（git pull）。
goto :end_fail

:no_node
echo [X] 找不到 Node.js（node 或 npm 指令）。
echo     本專案需要 Node.js 24：https://nodejs.org 下載 LTS 安裝，裝好後關掉這個視窗、重新雙擊本檔。
goto :end_fail

:no_exam_modules
echo [X] 找不到 exam_pro\node_modules：後端的相依套件還沒安裝。
echo     請先在 exam_pro 資料夾執行 npm install（或照 README 的安裝步驟），再重新雙擊本檔。
goto :end_fail

:npm_failed
popd
echo [X] 安裝 Electron 失敗，原因見上方訊息（常見是網路連不上 github.com）。網路恢復後再雙擊一次本檔。
goto :end_fail

:no_electron
echo [X] 安裝看起來成功，但找不到 %ELECTRON%。請加 --reinstall 再試一次。
goto :end_fail

:shortcut_failed
echo [X] 建立圖示失敗，原因見上方訊息。
goto :end_fail

:end_fail
echo.
pause
exit /b 1
