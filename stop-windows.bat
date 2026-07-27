@echo off
REM Zaustavlja AI Zdravo Dashboard pokrenut preko start-windows.bat.
cd /d "%~dp0"
py -3 server.py --stop || python server.py --stop || python3 server.py --stop
echo.
pause
