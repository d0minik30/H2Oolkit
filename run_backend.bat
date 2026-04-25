@echo off
REM ==========================================================
REM   H2Oolkit Backend Server - Port 5000
REM ==========================================================

cd /d %~dp0

echo.
echo =========================================
echo   H2Oolkit Backend Server
echo   URL: http://localhost:5000
echo =========================================
echo.
echo To test in browser:
echo   - Open http://localhost:5000/api/health
echo   - Or start frontend separately with:
echo     python -m http.server 8000
echo.
echo Press Ctrl+C to stop the server.
echo.

python -m backend.server

pause
