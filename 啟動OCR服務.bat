@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "PYTHON310=%LocalAppData%\Programs\Python\Python310\python.exe"
set "VENV_PYTHON=%~dp0.venv\Scripts\python.exe"

if exist "%VENV_PYTHON%" (
  "%VENV_PYTHON%" "%~dp0ocr_server.py"
) else if exist "%PYTHON310%" (
  "%PYTHON310%" "%~dp0ocr_server.py"
) else (
  py -3.10 "%~dp0ocr_server.py"
)

if errorlevel 1 (
  echo.
  echo OCR 服務啟動失敗，請先執行「安裝依賴.bat」。
  pause
)
