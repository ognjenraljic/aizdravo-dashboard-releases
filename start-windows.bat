@echo off
REM Dvoklik pokretac za Windows - ne treba komandnu liniju.
REM Trazi Python 3 pod imenom "python" prvo (najcesce na Windows-u),
REM pa "python3" ako prvo ne postoji.
cd /d "%~dp0"

REM 24.7.2026 - server se sad pokrece u ODVOJENOM (minimizovanom) prozoru
REM preko "start", ne u ovom istom cmd sesiji - zatvaranje OVOG prozora
REM vise ne gasi dashboard. Ako nesto ne uspije, otvori taj minimizovani
REM prozor iz trake zadataka da vidis poruku o gresci.
start "AI Zdravo Dashboard" /min cmd /c "python server.py || python3 server.py || (echo. & echo Python 3 nije pronadjen. Instaliraj ga sa python.org (obavezno cekiraj "Add python.exe to PATH" u instalaciji), pa probaj ponovo. & pause)"

timeout /t 2 >nul
echo.
echo AI Zdravo Dashboard je pokrenut u odvojenom (minimizovanom) prozoru.
echo Mozes slobodno zatvoriti OVAJ prozor - dashboard ostaje ziv.
echo Da ga zaustavis, dvaput klikni na stop-windows.bat.
echo.
pause
