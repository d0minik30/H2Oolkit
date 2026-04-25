@echo off
setlocal

REM ==========================================================
REM   H2Oolkit | Launch frontend (8000) + backend API (5000)
REM ==========================================================

set "ROOT=%~dp0"
set "VENV=%ROOT%venv"

if not exist "%VENV%\Scripts\python.exe" (
    echo [ERROR] Python venv not found at %VENV%
    echo         Run extraction\setup.bat first to create it,
    echo         then:  %VENV%\Scripts\pip install -r backend\requirements.txt
    pause & exit /b 1
)

echo.
echo  =========================================
echo   Backend API   ^|  http://localhost:5000
echo   Frontend page ^|  http://localhost:8000
echo  =========================================
echo.

REM Start backend (Flask) in a new console
start "H2Oolkit Backend" cmd /k "cd /d "%ROOT%" && "%VENV%\Scripts\python.exe" -m backend.server"

REM Static frontend in this console
"%VENV%\Scripts\python.exe" -m http.server 8000 --directory "%ROOT%"

endlocal
