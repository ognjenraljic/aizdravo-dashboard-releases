@echo off
REM Dvoklik pokretac za Windows - ne treba komandnu liniju.
REM Redoslijed launchera: "py -3" prvi (najpouzdaniji, izbjegava Microsoft
REM Store alias koji "python" zna biti bez stvarne instalacije - 27.7.2026,
REM Codex QA audit), pa "python", pa "python3".
cd /d "%~dp0"

REM 24.7.2026 - server se sad pokrece u ODVOJENOM (minimizovanom) prozoru
REM preko "start", ne u ovom istom cmd sesiji - zatvaranje OVOG prozora
REM vise ne gasi dashboard. Ako nesto ne uspije, otvori taj minimizovani
REM prozor iz trake zadataka da vidis poruku o gresci.
start "AI Zdravo Dashboard" /min cmd /c "py -3 server.py || python server.py || python3 server.py || (echo. & echo Python 3 nije pronadjen. Instaliraj ga sa python.org (obavezno cekiraj "Add python.exe to PATH" u instalaciji), pa probaj ponovo. & pause)"

timeout /t 2 >nul
echo.
REM 27.7.2026 (Codex QA) - ovo NIJE potvrda da je server stvarno odgovorio,
REM samo da je prozor pokrenut. Ako nesto ne valja (Python fali, port
REM zauzet), poruka o gresci ceka u minimizovanom prozoru iz trake
REM zadataka - otvori ga prije nego zakljucis da nesto ne radi.
echo AI Zdravo Dashboard bi trebalo da se pokrece u odvojenom (minimizovanom) prozoru.
echo Ako http://localhost:8100 ne radi za par sekundi, otvori taj minimizovani
echo prozor iz trake zadataka da vidis eventualnu poruku o gresci.
echo Mozes slobodno zatvoriti OVAJ prozor - dashboard ostaje ziv.
echo Da ga zaustavis, dvaput klikni na stop-windows.bat.
echo.
pause
