@echo off
setlocal enabledelayedexpansion

REM ==========================================================
REM   H2Oolkit | Launch frontend (8000) + backend API (5000)
REM ==========================================================

set "ROOT=%~dp0"
set "VENV=%ROOT%venv"
set "PYTHON=%VENV%\Scripts\python.exe"

if not exist "%PYTHON%" (
    echo [ERROR] Python venv not found at %VENV%\Scripts\python.exe
    echo.
    echo You can either:
    echo   1. Run extraction\setup.bat to create the venv
    echo   2. Or use system Python: python -m backend.server
    echo.
    pause
    exit /b 1
)

REM Install/upgrade requirements if needed
echo [*] Checking dependencies...
"%PYTHON%" -m pip install -q flask flask-cors requests numpy reportlab 2>nul

echo.
echo =========================================
echo   Backend API   ^|  http://localhost:5000
echo   Frontend page ^|  http://localhost:8000
echo =========================================
echo.
echo Press Ctrl+C to stop either server.
echo.

REM Start backend (Flask) in a new visible window
echo [*] Starting Backend on port 5000...
start "H2Oolkit Backend (Port 5000)" /wait cmd /k "cd /d "!ROOT!" && "!PYTHON!" -m backend.server"

REM Note: Frontend would run in current window, but we exit after backend
endlocal
