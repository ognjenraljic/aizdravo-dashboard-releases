@echo off
REM JEDNOKRATNO podesavanje (opciono): dashboard se poslije ovoga sam
REM pokrece pri SVAKOJ prijavi na Windows, cak i poslije restarta
REM racunara - ne treba vise rucno pokretati start-windows.bat. Bezbjedno
REM je pokrenuti ovo vise puta (prepisuje isti startup fajl).
cd /d "%~dp0"
set "BASE_DIR=%~dp0"
set "STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "VBS_PATH=%STARTUP_DIR%\AIZdravoDashboard.vbs"

where python >nul 2>nul
if %errorlevel%==0 (
    set "PYEXE=python"
) else (
    where python3 >nul 2>nul
    if %errorlevel%==0 (
        set "PYEXE=python3"
    ) else (
        echo Python 3 nije pronadjen. Instaliraj ga sa python.org pa probaj ponovo.
        pause
        exit /b 1
    )
)

REM VBS wrapper pokrece server BEZ vidljivog konzolnog prozora (window
REM style 0 = hidden) - obican .bat u Startup folderu bi na svakoj
REM prijavi bljesnuo crn konzolni prozor.
> "%VBS_PATH%" echo Set WshShell = CreateObject("WScript.Shell")
>> "%VBS_PATH%" echo WshShell.Run """%PYEXE%"" ""%BASE_DIR%server.py"" --no-browser", 0, False

echo.
echo Gotovo! AI Zdravo Dashboard ce se sad sam pokretati pri svakoj prijavi na ovaj Windows racunar.
echo Otvori http://localhost:8100 u browseru i sacuvaj ga u Bookmarks (Ctrl+D) -
echo odsad samo klikni taj bookmark, dashboard je uvijek spreman.
echo.
echo Da uklonis auto-pokretanje, dvaput klikni uninstall-autostart-windows.bat.
echo.
pause
