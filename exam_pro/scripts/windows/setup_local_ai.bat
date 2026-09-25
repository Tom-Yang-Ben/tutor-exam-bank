@echo off
chcp 65001 >nul
setlocal EnableExtensions

REM ================================================================
REM  setup_local_ai.bat  本機模式一鍵安裝（docs\local-mode.md 第 6 條第 4 點、第 10 條）
REM
REM  雙擊即可。依序：
REM    1. 檢查 Ollama 已安裝、而且正在執行
REM    2. ollama pull 三個模型：qwen3-vl:8b、qwen3:8b、qwen3-embedding:0.6b（合計約 12 GB）
REM    3. 檢查 Python 3（先找 py -3，再找 python；要 3.9 以上、64 位元）
REM    4. 建立 exam_pro\ocr_service\.venv
REM    5. pip install -r exam_pro\ocr_service\requirements.txt（PaddlePaddle CPU 版、PaddleOCR、PyMuPDF）
REM    6. ocr_pdf.py --warmup（下載 PaddleOCR 的模型）
REM    7. ocr_pdf.py --selftest（確認套件與模型都已就緒）
REM  任何一步失敗都會寫明原因並停下；重跑這支是安全的（已完成的步驟會很快跳過或只做檢查）。
REM  完整輸出寫在 exam_pro\data\local_ai\setup_時間.log。
REM
REM  只有安裝時要連網；裝好之後，系統執行期不再連到本機以外的地方（docs\local-mode.md 第 1 條）。
REM ================================================================

cd /d "%~dp0..\.."
set "APP=%CD%"
set "LOGDIR=%APP%\data\local_ai"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
set "TS="
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss"') do set "TS=%%i"
if not defined TS set "TS=%RANDOM%"
set "LOG=%LOGDIR%\setup_%TS%.log"
set "OCR_DIR=%APP%\ocr_service"
set "VENV=%OCR_DIR%\.venv"
set "VPY=%VENV%\Scripts\python.exe"
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
set "PIP_DISABLE_PIP_VERSION_CHECK=1"

call :log ----------------------------------------------------------------
call :log 本機模式安裝開始 %DATE% %TIME%
call :log 專案目錄：%APP%
call :log log 檔：%LOG%
call :log ----------------------------------------------------------------
echo 需要的磁碟空間約 15 GB（三個模型約 12 GB，OCR 套件與模型約 2 至 3 GB）；第一次安裝要下載很久，請保持連網。
echo.

REM ── 0. Node.js（下面用 eval\tools\tee_run.js 把輸出同時寫進 log）──
where node >nul 2>nul
if errorlevel 1 goto :no_node
set "TEE=node "%APP%\eval\tools\tee_run.js" "%LOG%""

REM ── 1. Ollama ──
call :log [1/7] 檢查 Ollama 是否已安裝並在執行
set "OLLAMA="
where ollama >nul 2>nul
if not errorlevel 1 set "OLLAMA=ollama"
if not defined OLLAMA if exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" set "OLLAMA=%LOCALAPPDATA%\Programs\Ollama\ollama.exe"
if not defined OLLAMA goto :no_ollama
"%OLLAMA%" --version >>"%LOG%" 2>&1
"%OLLAMA%" list >>"%LOG%" 2>&1
if errorlevel 1 goto :ollama_down
call :log       Ollama 已在執行。

REM ── 2. 三個模型 ──
call :log [2/7] 下載模型（已下載過的只會檢查更新，很快）
call :pull qwen3-vl:8b
if errorlevel 1 goto :pull_failed
call :pull qwen3:8b
if errorlevel 1 goto :pull_failed
call :pull qwen3-embedding:0.6b
if errorlevel 1 goto :pull_failed
"%OLLAMA%" list >>"%LOG%" 2>&1

REM ── 3. Python ──
call :log [3/7] 檢查 Python
if not exist "%OCR_DIR%\requirements.txt" goto :no_ocr_service
if not exist "%OCR_DIR%\ocr_pdf.py" goto :no_ocr_service
set "PY="
py -3 --version >nul 2>nul
if not errorlevel 1 set "PY=py -3"
if defined PY goto :py_found
python --version >nul 2>nul
if not errorlevel 1 set "PY=python"
:py_found
if not defined PY goto :no_python
%PY% --version >>"%LOG%" 2>&1
%PY% -c "import sys, struct; sys.exit(0 if sys.version_info >= (3, 9) and struct.calcsize('P') == 8 else 1)"
if errorlevel 1 goto :python_too_old
%PY% -c "import sys; sys.exit(1 if sys.version_info >= (3, 13) else 0)"
if errorlevel 1 call :log       [注意] 這是 Python 3.13 以上；PaddlePaddle 可能還沒有這個版本的套件。若第 5 步失敗，請改裝 Python 3.11 或 3.12。
call :log       使用 %PY%

REM ── 4. 虛擬環境 ──
call :log [4/7] 建立 OCR 專用的 Python 環境 %VENV%
if exist "%VPY%" goto :venv_ok
%PY% -m venv "%VENV%" >>"%LOG%" 2>&1
if errorlevel 1 goto :venv_failed
:venv_ok
if not exist "%VPY%" goto :venv_failed
call :log       %VPY%

REM ── 5. 安裝套件 ──
call :log [5/7] 安裝 OCR 套件（PaddlePaddle CPU 版、PaddleOCR、PyMuPDF；第一次約 5 到 15 分鐘）
%TEE% "%VPY%" -m pip install --upgrade pip
%TEE% "%VPY%" -m pip install -r "%OCR_DIR%\requirements.txt"
if errorlevel 1 goto :pip_failed

REM ── 6. 下載 OCR 模型 ──
call :log [6/7] 下載 PaddleOCR 的模型（ocr_pdf.py --warmup）
%TEE% "%VPY%" "%OCR_DIR%\ocr_pdf.py" --warmup
if errorlevel 1 goto :warmup_failed

REM ── 7. 自我檢查 ──
call :log [7/7] OCR 自我檢查（ocr_pdf.py --selftest）
%TEE% "%VPY%" "%OCR_DIR%\ocr_pdf.py" --selftest
if errorlevel 1 goto :selftest_failed

call :log
call :log [OK] 本機 AI 安裝完成。
echo.
echo 下一步：
echo   1. 確認 exam_pro\.env 的本機模式設定（要改哪幾行見 docs\local-mode.md 第 10 條）。
echo   2. 重啟伺服器（npm start），上傳一份小考卷試試；CPU 上一頁要跑好幾分鐘，這是正常的。
echo   3. 要讓 CI 改用本機模型錄的回放檔：雙擊 exam_pro\scripts\windows\record_local.bat（會跑很久）。
if not defined OLLAMA_MAX_LOADED_MODELS (
    echo.
    echo 建議：16 GB 記憶體一次只放一個大模型。在「開始」搜尋「編輯您帳戶的環境變數」，
    echo       新增 OLLAMA_MAX_LOADED_MODELS，值填 1，然後從右下角圖示結束 Ollama 再重新開啟。
)
echo.
echo 完整輸出：%LOG%
pause
exit /b 0

REM ================================================================
REM  子程序
REM ================================================================

:log
echo(%*
>>"%LOG%" echo(%*
exit /b 0

:pull
call :log       ollama pull %~1
"%OLLAMA%" pull %~1
if errorlevel 1 (
    >>"%LOG%" echo       ollama pull %~1 失敗，結束碼 %errorlevel%
    set "FAILED_MODEL=%~1"
    exit /b 1
)
>>"%LOG%" echo       ollama pull %~1 完成
exit /b 0

REM ================================================================
REM  失敗：寫明原因、處置，停下
REM ================================================================

:no_node
call :log [X] 找不到 Node.js（node 指令）。
echo     本專案需要 Node.js 24：https://nodejs.org 下載 LTS 安裝，裝好後關掉這個視窗、重新雙擊本檔。
goto :end_fail

:no_ollama
call :log [X] 找不到 Ollama。
echo     請到 https://ollama.com/download 下載 Windows 版安裝（免費），裝好後會自動在背景執行，
echo     工作列右下角出現羊駝圖示；然後重新雙擊本檔。
goto :end_fail

:ollama_down
call :log [X] Ollama 已安裝，但沒有在執行（ollama list 連不上服務）。
echo     請從「開始」選單開啟 Ollama，等工作列右下角出現羊駝圖示後，重新雙擊本檔。
echo     若 .env 或系統環境變數設了 OLLAMA_HOST，請確認它是 127.0.0.1:11434 這類本機位址。
goto :end_fail

:pull_failed
call :log [X] 下載模型 %FAILED_MODEL% 失敗。
echo     常見原因：網路中斷（重跑本檔會從中斷處接著下載）、磁碟空間不足（三個模型約 12 GB）、
echo     或模型名稱在 Ollama 上不存在（先在 https://ollama.com/library 搜尋確認）。
echo     也可以自己在命令列執行：ollama pull %FAILED_MODEL%
goto :end_fail

:no_ocr_service
call :log [X] 找不到 exam_pro\ocr_service\requirements.txt 或 ocr_pdf.py。
echo     本機 OCR 服務還沒放進這個版本的程式碼。請先更新到含本機模式的版本（git pull），再重新雙擊本檔。
goto :end_fail

:no_python
call :log [X] 找不到 Python 3（試過 py -3 與 python）。
echo     請到 https://www.python.org/downloads/windows/ 下載 Python 3.11 或 3.12 的 64 位元安裝檔，
echo     安裝時勾選「Add python.exe to PATH」；裝好後關掉這個視窗、重新雙擊本檔。
echo     （Windows 內建的 python 指令只是 Microsoft Store 的捷徑，不算安裝。）
goto :end_fail

:python_too_old
call :log [X] Python 版本不符：需要 3.9 以上、64 位元。
echo     請安裝 Python 3.11 或 3.12 的 64 位元版（https://www.python.org/downloads/windows/），再重新雙擊本檔。
goto :end_fail

:venv_failed
call :log [X] 建立虛擬環境失敗：%VENV%
echo     請確認磁碟空間與資料夾權限；若之前建到一半，可以刪掉 exam_pro\ocr_service\.venv 資料夾後重跑。
goto :end_fail

:pip_failed
call :log [X] 安裝 OCR 套件失敗（pip install -r requirements.txt）。
echo     常見原因：網路中斷（重跑即可）、Python 版本太新而 PaddlePaddle 還沒有對應套件（改裝 Python 3.11 或 3.12，
echo     刪掉 exam_pro\ocr_service\.venv 後重跑）、防毒軟體擋下安裝。詳細錯誤在 log 的最後幾十行。
goto :end_fail

:warmup_failed
call :log [X] 下載 PaddleOCR 模型失敗（ocr_pdf.py --warmup）。
echo     常見原因：網路中斷或被防火牆擋下（重跑即可）；詳細錯誤在 log 的最後幾十行。
goto :end_fail

:selftest_failed
call :log [X] OCR 自我檢查沒有通過（ocr_pdf.py --selftest）。
echo     多半是模型沒有下載完整：重跑本檔會再做一次第 6 步。仍然失敗時，把 log 檔交給維護的人看。
echo     在還沒修好之前，可以在 .env 設 OCR_ENGINE=none 暫時只用視覺模型拆題（所有題都會停在人工複核）。
goto :end_fail

:end_fail
echo.
echo 完整輸出：%LOG%
>>"%LOG%" echo [X] 安裝中止 %DATE% %TIME%
pause
exit /b 1
