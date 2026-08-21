@echo off
chcp 65001 >nul
cd /d "%~dp0"

REM 這支已退役（規劃 §2.3.2、§5.3.7）。
REM 索引與兩個 VIEW 現在都寫在 migrations\0001_init.sql 與 0002_vector.sql 裡，
REM 由 migrate.js 套用，不再需要獨立的 setup_index_views.js。

echo.
echo ====================================================
echo  這支已退役。
echo.
echo  索引與檢視表已經寫進 migrations\0001_init.sql、
echo  0002_vector.sql，改用下面任一種方式套用：
echo.
echo      雙擊「啟動資料庫.bat」（起容器 + 套 migrations）
echo      或執行  npm run migrate
echo.
echo  本檔與 setup_index_views.js 會在 D-X1 一起自版控移除。
echo ====================================================
echo.
pause
