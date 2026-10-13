@echo off
REM Dvoklik pokretac za Windows - ne treba komandnu liniju.
REM Redoslijed launchera: "py -3" prvi (najpouzdaniji, izbjegava Microsoft
REM Store alias koji "python" zna biti bez stvarne instalacije - 27.7.2026,
REM Codex QA audit), pa "python", pa "python3".
cd /d "%~dp0"

REM 1.7.1 - Python se bira PRIJE pokretanja (isti obrazac kao
REM install-autostart-windows.bat). Ranije je server pokretan lancem
REM "py -3 server.py || python server.py || ...": kad se server ugasi sa
REM kodom razlicitim od 0, lanac je odmah dizao drugi server.
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
    echo.
    echo Python 3 nije pronadjen. Instaliraj ga sa python.org ^(obavezno cekiraj "Add python.exe to PATH" u instalaciji^), pa probaj ponovo.
    echo.
    pause
    exit /b 1
)

REM 24.7.2026 - server se pokrece u ODVOJENOM (minimizovanom) prozoru
REM preko "start", ne u ovom istom cmd sesiji - zatvaranje OVOG prozora
REM vise ne gasi dashboard. Ako server javi gresku, prozor ostaje otvoren
REM (pause) da se vidi poruka.
start "AI Zdravo Dashboard" /min cmd /c "%PYEXE% %PYARG% server.py || pause"

echo.
REM 1.7.1 - ispisi STVARNU adresu (port nije uvijek 8100: ako je zauzet,
REM server prelazi na sljedeci). AI asistent cita liniju "AI Zdravo Dashboard -> ...".
set "DASHURL="
for /f "delims=" %%U in ('%PYEXE% %PYARG% tools\dashboard_url.py --wait 8 2^>nul') do set "DASHURL=%%U"
if defined DASHURL (
    echo AI Zdravo Dashboard -^> %DASHURL%
) else (
    echo Dashboard se nije javio. Otvori minimizovani prozor "AI Zdravo Dashboard"
    echo iz trake zadataka da vidis poruku o gresci.
)
echo Mozes slobodno zatvoriti OVAJ prozor - dashboard ostaje ziv.
echo Da ga zaustavis, dvaput klikni na stop-windows.bat.
echo.
pause
