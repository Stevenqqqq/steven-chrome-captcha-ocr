@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "PYTHON310=%LocalAppData%\Programs\Python\Python310\python.exe"
set "VENV_PYTHON=%~dp0.venv\Scripts\python.exe"

if not exist "%VENV_PYTHON%" (
  echo 正在建立專案專用 Python 環境 .venv ...
  if exist "%PYTHON310%" (
    "%PYTHON310%" -m venv "%~dp0.venv"
  ) else (
    py -3.10 -m venv "%~dp0.venv"
  )
  if errorlevel 1 goto :failed
)

"%VENV_PYTHON%" -m pip install -r "%~dp0requirements.txt"
if errorlevel 1 goto :failed

echo.
echo 安裝完成。依賴位於本專案的 .venv，不會安裝到全域 Python。
pause
exit /b 0

:failed
echo.
echo 安裝失敗，請確認已安裝 Python 3.10 64-bit。
pause
exit /b 1
