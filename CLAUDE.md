# AI Zdravo Dashboard — instrukcije za AI asistenta

Ovo je samostalan repo (dashboard shell, vidi README.md za kratak pregled). Kad se otvori sesija u ovom folderu (bilo prvi put ili bilo koji sljedeći), uradi ovo automatski, bez da čekaš da korisnik traži:

## 1. Prvi susret — pozdrav od AI Zdravo tima (SAMO jednom, prvi put ikad)

Provjeri da li u root-u ovog foldera postoji fajl `.aizdravo-welcomed`:

- **Ne postoji** (ovo je bukvalno prvi put da bilo koja sesija radi u ovom folderu) — PRIJE nego pređeš na Korak 2 (Python), pozdravi korisnika u chatu kratkim, toplim uvodom u ime AI Zdravo tima (ne u svoje ime kao alat, ne u ime Ognjena — ovo je proizvod koji koristi širi krug ljudi). U tom uvodu:
  - Objasni da je ovo njihov lični dashboard/operativni sistem — namjerno prazan, grade ga onako kako njima odgovara.
  - Odmah nastavi (u istoj poruci ili odmah zatim, bez čekanja da nešto pitaju) na Korak 2 (provjeri Python) i Korak 3 (pokreni dashboard).
  - Ukratko objasni DVA načina da se doda alat: (1) **prompt** — opišu šta žele, Claude/Codex napiše kod i sam ga registruje; (2) **gotov folder** — prevuku folder u `apps/`, kažu "učitaj ga", automatski se registruje. Naglasi da je JEDAN isti folder dovoljan i za "aplikaciju" i za "widget" formu ako alat ima obje — nema odvojenih foldera po formi, jedan manifest pokriva oboje (pun kontrakt: `APPS_AND_WIDGETS.md`).
  - Naglasi da je ovo od sad NJIHOV operativni sistem — grade alate koji im pomažu u svakodnevnom radu, mijenjaju temu/izgled kako im odgovara.
  - **NE piši `.aizdravo-welcomed` fajl još** — tek na kraju Koraka 3, kad je dashboard STVARNO potvrđeno pokrenut (vidi tamo). Ako se ovdje napiše odmah i nešto poslije zapne (Python nedostaje i korisnik odustane, server ne uspije da se pokrene), sljedeća sesija bi preskočila pozdrav iako korisnik nikad nije dobio radan dashboard.
- **Postoji** — preskoči ovaj korak potpuno, idi direktno na Korak 2.

## 2. Provjeri Python PRIJE pokretanja (auto-instaliraj uz potvrdu, ili daj jasna uputstva)

`start-mac.command` zove `python3`; `start-windows.bat` prvo proba `python`, pa `python3` (drugačiji redoslijed po OS-u — vidi taj fajl). Ako korisnik nema Python instaliran (čest slučaj, pogotovo na Windowsu i na novijem macOS-u bez Xcode alata), pokretanje padne sa kriptičnom greškom umjesto da se dashboard otvori. Provjeri OVO prvo, svaki put kad prvi put uđeš u ovaj folder ili kad korisnik javi da dashboard "ne radi"/"ne može da se pokrene":

1. **Provjeri, redoslijedom koji odgovara OS-u**:
   - **macOS/Linux**: `python3 --version`.
   - **Windows**: prvo `py -3 --version` (najpouzdaniji način da se izbjegne Microsoft Store alias koji NIJE stvarna instalacija), pa `python --version`, pa `python3 --version` — isti redoslijed kao `start-windows.bat`. Ako `python --version` "uspije" ali ispiše ništa ili otvori Microsoft Store, tretiraj kao da Python nije instaliran.
   Ako bilo koja od ovih vrati verziju 3.x — ništa više ne treba, idi na Korak 3.
2. **Ako nedostaje** — prvo objasni korisniku šta nedostaje i šta bi tačno pokrenuo, PA TRAŽI POTVRDU prije nego išta instaliraš (instalacija softvera na tuđoj mašini nije "obična" akcija, isti princip kao Korak 4 ispod):
   - **macOS sa Homebrew-om** (`which brew` uspije): predloži `brew install python3` — ne traži sudo/lozinku, sigurno za pokrenuti nakon potvrde.
   - **macOS bez Homebrew-a**: predloži `xcode-select --install` (otvara Appleov GUI installer za Command Line Tools, koji uključuje python3) — ovo TRAŽI da korisnik sam klikne kroz sistemski dijalog, ne može se do kraja automatizovati; reci mu to unaprijed.
   - **Windows sa `winget`** (`winget --version` uspije): predloži `winget install Python.Python.3.12` — obično ne traži admin prava.
   - **Windows bez winget-a, ili korisnik odbije auto-instalaciju**: daj direktan link `https://www.python.org/downloads/` i jedno upozorenje - na Windowsu OBAVEZNO čekirati "Add python.exe to PATH" na prvom ekranu instalera, inače ni `python`/`python3`/`py` komande neće raditi ni poslije instalacije.
3. **Poslije instalacije** (auto ili ručne) - ponovo provjeri (istim OS-specifičnim redoslijedom) prije nego nastaviš na Korak 3. Ako i dalje ne radi (npr. terminal treba restart da pokupi novi PATH), reci korisniku da zatvori i ponovo otvori terminal/Claude Code sesiju pa pokuša ponovo.

## 3. Pokreni dashboard (uvijek, automatski, bez pitanja)

**NIKAD ne zaključuj "već radi" samo zato što `curl http://localhost:8100/` vrati 200.** Port 8100 je DEFAULT za SVAKI aizdravo dashboard folder na ovoj mašini - ako korisnik ima i drugi folder (svoju ličnu kopiju, drugi preuzet primjerak, prošlu epizodu serijala) već pokrenut, taj isti port već odgovara sa 200 iako je u pitanju POTPUNO DRUGI folder. Provjera samo po HTTP statusu je ovdje pogrešna - dogodilo se uživo 28.7.2026: korisnik je otvorio SVJEŽE preuzet folder, port 8100 je već odgovarao (njegova stara lična kopija), i pokretanje je preskočeno u potpunosti - korisnik je vidio SVOJ STARI dashboard umjesto novog praznog.

Zato UVIJEK direktno pokreni skriptu, bez preliminarne odluke da li treba:

```bash
cd "$(pwd)" && ./start-mac.command   # Mac
```
ili na Windowsu `start-windows.bat`. Ovo je bezbjedno pokrenuti bilo kad, bez izuzetka - `server.py` sam ispravno odlučuje: ako OVAJ ISTI folder već ima živ server na nekom portu, prepoznaje to preko `/api/instance` rute (poredi stvaran apsolutni put foldera, ne samo HTTP status) i ne diže drugi proces; ako je port zauzet NEČIM DRUGIM (drugi aizdravo folder, bilo koja druga app), sam bira sljedeći slobodan port (8101, 8102...) i to ispisuje. Server ostaje živ u pozadini i poslije zatvaranja terminala (detached od 24.7.2026), pa se ovo ne mora ponavljati unutar iste sesije/dana, ali provjeri svaki put kad korisnik kaže da dashboard "ne radi" ili "ne može da se poveže" - najčešći uzrok je da server nije pokrenut (npr. poslije restarta računara).

**Pročitaj STVARAN port iz izlaza skripte** ("AI Zdravo Dashboard -> http://localhost:XXXX") - ne pretpostavljaj da je uvijek 8100. Reci korisniku da otvori TAJ tačan URL i sačuva ga u Bookmarks (Cmd+D / Ctrl+D) - dvoklik na taj bookmark će odsad otvarati baš OVAJ folder, čak i ako je na drugom portu od 8100.

Tek OVDJE, kad je `curl` na taj stvaran URL (port iz izlaza skripte, ne pretpostavljen 8100) stvarno vratio 200 (ne prije) - ako `.aizdravo-welcomed` iz Koraka 1 još ne postoji, sačuvaj ga sad (`touch .aizdravo-welcomed` ili ekvivalent). Ovo potvrđuje da je korisnik zaista dobio radan dashboard OVOG foldera prije nego se pozdrav označi kao odrađen.

## 4. Auto-start pri prijavi na računar (ponudi, ne pokreći bez potvrde)

Ako korisnik želi da dashboard radi i poslije restarta računara (ne samo dok se ne zatvori terminal), ponudi da pokreneš `./install-autostart-mac.command` (Mac) ili `install-autostart-windows.bat` (Windows) — ali **prvo objasni šta radi i traži potvrdu**, jer:
- Postavlja trajnu sistemsku konfiguraciju (macOS LaunchAgent / Windows Startup stavka) koja preživljava restart.
- Ako se ovaj folder trenutno nalazi unutar Desktop/Documents/Downloads, skripta će (uz potvrdu od korisnika unutar same skripte) **premjestiti cijeli folder** na `~/aizdravo` prije nego postavi auto-start — macOS ne dozvoljava auto-pokrenutim procesima da čitaju fajlove unutar tih zaštićenih foldera (TCC ograničenje bez rješenja preko skripte), pa je premještanje jedini pouzdan način da auto-start uopšte radi.

Ne pokreći ovaj korak automatski bez da prvo pitaš — to je sistemska izmjena, ne obična pokretanje servera.

## Skills

- **`.claude/skills/install-app/`** — čita zalijepljen instalacioni/update prompt za nov alat (šablon iz `APPS_AND_WIDGETS.md`) ili prekopiran folder u `apps/`, validira manifest PRIJE registracije, registruje ga u `index.html`, i provjerava da stvarno radi (obje forme, widget i app) prije nego javi "gotovo". Koristi se automatski čim se zalijepi takav prompt/kod ili korisnik kaže "instaliraj"/"ažuriraj"/"učitaj alat" - ne treba ga eksplicitno zvati. **Instalacija i ažuriranje idu kroz ISTI mehanizam** - ažuriranje jednog alata je novi kod/folder za POSTOJEĆI `id`, ništa posebno. **Jedan folder `apps/<id>/` pokriva i app i widget formu** ako alat ima obje - nikad se ne pravi zaseban folder po formi (pun kontrakt: `APPS_AND_WIDGETS.md`). Radi i za Claude Code (native `.claude/skills/` otkrivanje) i za Codex preko `.agents/skills/install-app` simlinka ka istom fajlu - jedan SKILL.md, dva alata ga čitaju.
- **`.claude/skills/update-dashboard/`** — provjerava da li postoji novija verzija SAMOG dashboard core-a (index.html/app.js/apps-core.js/style.css/server.py/dokumentacija), pravi backup PRIJE primjene, i mijenja SAMO core fajlove - `dashboard-state.json` i `apps/` (korisnikovi instalirani alati) se nikad ne diraju. Koristi se kad korisnik kaže "provjeri ima li update za dashboard"/"ažuriraj dashboard na najnoviju verziju". Isti Claude/Codex simlink obrazac kao install-app.

## Ostalo

Kratak pregled: `README.md`. Ovaj CLAUDE.md fajl postoji samo da AI asistent (Claude Code/Codex) odmah zna šta da uradi kad uđe u ovaj folder, bez da korisnik mora sam da traži.
