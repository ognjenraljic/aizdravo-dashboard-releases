@echo off
REM JEDNOKRATNO podesavanje (opciono): dashboard se poslije ovoga sam
REM pokrece pri SVAKOJ prijavi na Windows, cak i poslije restarta
REM racunara - ne treba vise rucno pokretati start-windows.bat. Bezbjedno
REM je pokrenuti ovo vise puta (prepisuje isti startup fajl).
cd /d "%~dp0"
set "BASE_DIR=%~dp0"
set "STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "VBS_PATH=%STARTUP_DIR%\AIZdravoDashboard.vbs"

REM 27.7.2026 (Codex bezbjednosni/QA audit) - stari kod je ugnijezdio
REM "if %errorlevel%==0" unutar vec otvorenog "else (" bloka. Batch
REM supstituira SVE %varijable% JEDNOM, kad parsira CIJELI spoljni
REM if/else blok - unutrasnji %errorlevel% je zato uvijek nosio staru
REM vrijednost od PRVE "where" komande, ne od druge. Ovaj oblik (odvojeni
REM "if not defined" redovi, svaki sam za sebe) nema taj problem jer se
REM svaki parsira i izvrsava kao zaseban iskaz. "py -3" je provjeren prvi
REM (najpouzdaniji launcher, izbjegava Microsoft Store alias koji "where
REM python" zna lazno prijaviti kao pronadjen).
REM PYEXE = sam launcher (jedan token, bez razmaka - bitno za VBS Run
REM liniju ispod, koja svaki argument kvotuje POSEBNO); PYARG = opcioni
REM dodatni argument launcheru (npr. "-3" za "py -3"). Razdvojeno 27.7.2026
REM (Codex QA) - "py -3" kao JEDAN string bi u VBS Run liniji ispalo kao
REM ime fajla sa razmakom u nazivu, ne kao launcher+argument.
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
    echo Python 3 nije pronadjen. Instaliraj ga sa python.org pa probaj ponovo.
    pause
    exit /b 1
)

REM VBS wrapper pokrece server BEZ vidljivog konzolnog prozora (window
REM style 0 = hidden) - obican .bat u Startup folderu bi na svakoj
REM prijavi bljesnuo crn konzolni prozor. Napomena: echo u batch fajlu
REM piše u sistemskoj ANSI kodnoj stranici - ako BASE_DIR sadrži znakove
REM van te stranice, VBS putanja se može oštetiti (poznato ograničenje,
REM nije provjereno na pravom Windows računaru - vidi CLAUDE.md/README
REM ograničenje o Windows testiranju).
set "PYARGQ="
if defined PYARG set "PYARGQ=""%PYARG%"" "
> "%VBS_PATH%" echo Set WshShell = CreateObject("WScript.Shell")
>> "%VBS_PATH%" echo WshShell.Run """%PYEXE%"" %PYARGQ%""%BASE_DIR%server.py"" --no-browser", 0, False

echo.
echo Gotovo! AI Zdravo Dashboard ce se sad sam pokretati pri svakoj prijavi na ovaj Windows racunar.
echo Otvori http://localhost:8100 u browseru i sacuvaj ga u Bookmarks (Ctrl+D) -
echo odsad samo klikni taj bookmark, dashboard je uvijek spreman.
echo.
echo Da uklonis auto-pokretanje, dvaput klikni uninstall-autostart-windows.bat.
echo.
pause
