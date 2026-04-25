@echo off
REM ==========================================================
REM   H2Oolkit Frontend Server - Port 8000
REM ==========================================================

cd /d %~dp0

echo.
echo =========================================
echo   H2Oolkit Frontend Server
echo   URL: http://localhost:8000
echo =========================================
echo.
echo Make sure backend is running at port 5000!
echo   Run run_backend.bat in another window
echo.
echo Press Ctrl+C to stop the server.
echo.

python -m http.server 8000

pause
