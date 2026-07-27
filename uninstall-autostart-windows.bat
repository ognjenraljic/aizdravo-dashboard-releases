@echo off
REM Uklanja auto-pokretanje instalirano preko install-autostart-windows.bat.
set "VBS_PATH=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\AIZdravoDashboard.vbs"

if exist "%VBS_PATH%" (
    del "%VBS_PATH%"
    echo Auto-pokretanje uklonjeno. Dashboard se vise nece sam pokretati pri prijavi.
) else (
    echo Auto-pokretanje nije bilo instalirano - nema sta da se ukloni.
)

echo.
pause
