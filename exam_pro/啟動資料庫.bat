@echo off
chcp 65001 >nul
cd /d "%~dp0"

REM 啟動本機 PostgreSQL + pgvector（docker-compose.yml 的 postgres 5442 / postgres_test 5433）

docker info >/dev/null 2>&1
if errorlevel 1 (
    echo.
    echo [X] 偵測不到 Docker 引擎。請先啟動 Docker Desktop，等鯨魚圖示不再轉動後再執行這支。
    echo.
    pause
    exit /b 1
)

echo [1/2] 啟動資料庫容器（第一次會先下載 pgvector/pgvector:pg16，約需數分鐘）...
docker compose up -d --wait
if errorlevel 1 (
    echo.
    echo [X] 容器啟動失敗。常見原因：5442 或 5433 埠被本機既有的 PostgreSQL 佔用。
    echo     檢查指令： netstat -ano ^| findstr ":5442"
    echo.
    pause
    exit /b 1
)

echo [2/2] 套用 migrations 到開發資料庫...
call npm run migrate
if errorlevel 1 (
    echo.
    echo [X] migration 失敗。請確認 .env 裡的 DATABASE_URL 是否為：
    echo     postgres://exam:exam@localhost:5442/tutor_exam_bank
    echo.
    pause
    exit /b 1
)

echo.
echo [OK] 資料庫已就緒：
echo      開發庫  postgres://exam:exam@localhost:5442/tutor_exam_bank
echo      測試庫  postgres://exam:exam@localhost:5433/tutor_exam_bank_test
echo      停止指令： docker compose down
echo.
pause
