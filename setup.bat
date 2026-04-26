@echo off
REM ==========================================================
REM   H2Oolkit Setup Script
REM   Run this ONCE on a new device to set everything up
REM ==========================================================

echo.
echo =========================================
echo   H2Oolkit Initial Setup
echo =========================================
echo.

REM Check if Python is installed
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python not found!
    echo Please install Python 3.9+ from https://www.python.org
    echo Make sure to check "Add Python to PATH" during installation
    pause
    exit /b 1
)

echo [✓] Python found
python --version

REM Create virtual environment
if exist venv (
    echo [✓] Virtual environment already exists
) else (
    echo [*] Creating virtual environment...
    python -m venv venv
    if errorlevel 1 (
        echo [ERROR] Failed to create venv
        pause
        exit /b 1
    )
    echo [✓] Virtual environment created
)

REM Activate and install dependencies
echo.
echo [*] Installing dependencies...
call venv\Scripts\activate.bat

REM Upgrade pip first
python -m pip install --quiet --upgrade pip

REM Install requirements
if exist backend\requirements.txt (
    pip install --quiet -r backend\requirements.txt
    echo [✓] Backend dependencies installed
) else (
    echo [!] backend\requirements.txt not found, installing manually...
    pip install --quiet flask>=3.0 flask-cors>=4.0 requests>=2.31 numpy>=1.24 earthengine-api>=0.1.380 reportlab>=4.0
    echo [✓] Dependencies installed
)

echo.
echo =========================================
echo   ✓ Setup Complete!
echo =========================================
echo.
echo Next steps:
echo   1. Double-click run_backend.bat
echo   2. Double-click run_frontend.bat (in another window)
echo   3. Open http://localhost:8000 in your browser
echo.
pause
