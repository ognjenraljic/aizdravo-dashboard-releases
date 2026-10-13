@echo off
REM Zaustavlja AI Zdravo Dashboard pokrenut preko start-windows.bat.
cd /d "%~dp0"
REM 1.7.1 - Python se bira prije poziva (bez "||" lanca koji bi --stop
REM pokrenuo vise puta ako prvi pokusaj vrati gresku).
set "PYEXE="
set "PYARG="
py -3 --version >nul 2>nul
if not errorlevel 1 (
    set "PYEXE=py"
    set "PYARG=-3"
)
if not defined PYEXE (
    where python >nul 2>nul
    if not errorlevel 1 (
        python --version >nul 2>nul
        if not errorlevel 1 set "PYEXE=python"
    )
)
if not defined PYEXE (
    where python3 >nul 2>nul
    if not errorlevel 1 set "PYEXE=python3"
)
if not defined PYEXE (
    echo Python 3 nije pronadjen.
    pause
    exit /b 1
)
%PYEXE% %PYARG% server.py --stop
echo.
pause
