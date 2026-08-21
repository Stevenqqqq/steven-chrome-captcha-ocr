@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "PYTHON310=%LocalAppData%\Programs\Python\Python310\python.exe"
set "VENV_PYTHON=%~dp0.venv\Scripts\python.exe"
set "FAILED=0"

if exist "%VENV_PYTHON%" (
  "%VENV_PYTHON%" -B -m unittest discover -s tests -p "test*.py" -v
  if errorlevel 1 set "FAILED=1"
  "%VENV_PYTHON%" -B ocr_server.py --check
  if errorlevel 1 set "FAILED=1"
) else if exist "%PYTHON310%" (
  "%PYTHON310%" -m unittest discover -s tests -v
  if errorlevel 1 set "FAILED=1"
  "%PYTHON310%" ocr_server.py --check
  if errorlevel 1 set "FAILED=1"
) else (
  py -3.10 -m unittest discover -s tests -v
  if errorlevel 1 set "FAILED=1"
  py -3.10 ocr_server.py --check
  if errorlevel 1 set "FAILED=1"
)

where node.exe >nul 2>nul
if not errorlevel 1 (
  node.exe --test tests\test_background.js tests\test_captcha_image.js tests\test_detect_helpers.js tests\test_feedback_helpers.js tests\test_popup_startup.js
  if errorlevel 1 set "FAILED=1"
) else (
  echo 找不到 Node.js，無法執行 Chrome 擴充功能測試。
  set "FAILED=1"
)

pause
exit /b %FAILED%
