@echo off
setlocal

echo.
echo  =========================================
echo   H2Oolkit ^| Python Environment Setup
echo  =========================================
echo.

set "PYTHON=C:\Python314\python.exe"
set "ROOT=%~dp0.."
set "VENV=%ROOT%\venv"
set "REQ=%~dp0requirements.txt"

REM ── Check Python ─────────────────────────────────────
"%PYTHON%" --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Python not found at %PYTHON%
    echo         Try: py --version
    echo         If that works, replace PYTHON= in this file with the correct path.
    pause & exit /b 1
)
for /f "tokens=*" %%v in ('"%PYTHON%" --version') do echo [OK] Found %%v at %PYTHON%

REM ── Create venv if missing ────────────────────────────
if not exist "%VENV%\Scripts\activate.bat" (
    echo.
    echo [VENV] Creating virtual environment at %VENV% ...
    "%PYTHON%" -m venv "%VENV%"
    if %errorlevel% neq 0 (
        echo [ERROR] Failed to create venv. Check Python installation.
        pause & exit /b 1
    )
    echo [OK] Virtual environment created.
) else (
    echo [OK] Virtual environment already exists at %VENV%
)

REM ── Install / upgrade packages ────────────────────────
echo.
echo [PIP] Installing packages from requirements.txt ...
call "%VENV%\Scripts\activate.bat"
"%VENV%\Scripts\python.exe" -m pip install --upgrade pip --quiet
"%VENV%\Scripts\pip.exe" install -r "%REQ%"

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] pip install failed. Check network connection.
    pause & exit /b 1
)

echo.
echo  =========================================
echo   Setup complete!
echo  =========================================
echo.
echo  Activate the environment in a new terminal:
echo.
echo    venv\Scripts\activate
echo.
echo  Authenticate with Google Earth Engine (first time only):
echo.
echo    earthengine authenticate
echo.
echo  Then run the scripts:
echo.
echo    py extraction\extract_satellite.py
echo    py extraction\fetch_springs.py "Vrancea, Romania"
echo.
pause
endlocal
