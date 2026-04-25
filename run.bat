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

echo.
echo =========================================
echo   Backend API   ^|  http://localhost:5000
echo   Frontend page ^|  http://localhost:8000
echo =========================================
echo.
echo Starting both servers in separate windows...
echo Press Ctrl+C in each window to stop.
echo.

start "H2Oolkit Backend (Port 5000)" cmd /k "cd /d "!ROOT!" && "!PYTHON!" -m backend.server"
start "H2Oolkit Frontend (Port 8000)" cmd /k "cd /d "!ROOT!" && "!PYTHON!" -m http.server 8000"

echo [*] Both servers launched. Opening browser in 2 seconds...
timeout /t 2 /nobreak >nul
start http://localhost:8000

endlocal
