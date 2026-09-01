@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "PYTHON310=%LocalAppData%\Programs\Python\Python310\python.exe"
set "VENV_PYTHON=%~dp0.venv\Scripts\python.exe"
set "OCR_PYTHON=py"
set "OCR_PYTHON_ARGS=-3.10"

if exist "%VENV_PYTHON%" (
  set "OCR_PYTHON=%VENV_PYTHON%"
  set "OCR_PYTHON_ARGS="
) else if exist "%PYTHON310%" (
  set "OCR_PYTHON=%PYTHON310%"
  set "OCR_PYTHON_ARGS="
)

"%OCR_PYTHON%" %OCR_PYTHON_ARGS% "%~dp0ocr_server.py" --check-running >nul 2>&1
if not errorlevel 1 (
  echo OCR 服務已在執行：http://127.0.0.1:8765
  ping -n 3 127.0.0.1 >nul
  exit /b 0
)

"%OCR_PYTHON%" %OCR_PYTHON_ARGS% "%~dp0ocr_server.py"

if errorlevel 1 (
  echo.
  echo OCR 服務啟動失敗。若尚未安裝，請先執行「安裝依賴.bat」。
  pause
)
