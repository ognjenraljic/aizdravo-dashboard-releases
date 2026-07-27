---
name: install-app
description: 'Instalira ili ažurira alat(e) u AI Zdravo Dashboard - iz zalijepljenog install/update prompta (šablon iz APPS_AND_WIDGETS.md), iz sirovog app.js koda, ILI iz folder(a) koji su već ručno prekopirani u apps/ (npr. prenešeni sa drugog dashboarda, i po 10 odjednom). Kreira/prepoznaje apps/<id>/, registruje script liniju(e) u index.html, validira svaki manifest PRIJE registracije, i provjerava da alat stvarno radi (server odgovara, alat se pojavljuje u katalogu) prije nego se javi "gotovo". Trigger: zalijepljen tekst koji počinje sa "U ovom folderu je AI Zdravo Dashboard...", ili "instaliraj ovaj alat", "ugradi ovaj alat u dashboard", "dodaj ovaj alat", "instaliraj <ime alata>", "ažuriraj alat <ime>", "dodao sam alate u apps folder, učitaj ih", "sinhronizuj alate", "učitaj sve alate iz apps foldera".'
---

# Instalacija alata (AI Zdravo Dashboard)

Cilj: alat treba biti UGRAĐEN I UPOTREBLJIV za par sekundi, bez nagađanja i bez više krugova pitanja - bilo da stiže kao zalijepljen prompt, sirov kod, ili kao folder koji je neko već ručno ubacio u `apps/` (svaki alat je samostalan folder + jedna script linija, pa je po dizajnu prenosiv - kopiraš `apps/<id>/` sa jednog dashboarda na drugi, i po 10 odjednom, vidi APPS_AND_WIDGETS.md "Struktura alata"). Mehaničke korake (kreiranje foldera, upis fajla, dodavanje script linije) uradi odmah bez traženja potvrde - sve je lokalno i reverzibilno (fizičko brisanje foldera + script linije vraća stanje). Ne javljaj "gotovo" dok Korak 5 nije prošao.

## Prepoznavanje moda

- **Instalacija (nov alat, kod stiže sad)** - prompt sadrži "Instaliraj alat" i/ili je dat link/zalijepljen kod, a APP-ID folder još ne postoji u `apps/`.
- **Ažuriranje (postojeći alat)** - prompt sadrži "Ažuriraj alat", ili je dat nov kod za APP-ID folder koji već postoji u `apps/`.
- **Sinhronizacija (fajlovi već u folderu)** - korisnik kaže da je ručno prekopirao jedan ili više foldera u `apps/` (sa drugog dashboarda, iz zip-a, itd.) i traži da se "učitaju" - nema koda za primiti, samo treba provjeriti/registrovati ono što već postoji na disku.

### Sinhronizacija - kad su fajlovi već u apps/ (jedan ili više, npr. 10 odjednom)

Za "dodao sam alate u folder, učitaj ih" / "sinhronizuj alate" - nema pojedinačnog prompta po alatu, pa se radi u jednom prolazu preko svega što nedostaje, umjesto Koraka 1-3:

1. `ls apps/` - svaki podfolder sa `app.js` unutra je kandidat.
2. Za svaki kandidat, provjeri da li `index.html` već ima `<script src="apps/<id>/app.js...">` liniju u bloku "APLIKACIJE (alati)" - ako da, taj alat je već registrovan, preskoči ga.
3. Za svaki NEregistrovan kandidat: Korak 2 (validacija) → Korak 4 (dodaj script liniju) → Korak 5 (provjera), redom, jedan po jedan - jedan loš manifest ne smije zaustaviti registraciju ostalih.
4. Na kraju javi kratak sumaran spisak: koliko je pronađeno, koliko registrovano, i po imenu svaki koji je preskočen/odbijen uz razlog (npr. "loš id", "icon ne postoji").

## Korak 1 - Nabavi kod (Sinhronizacija ide direktno na odjeljak iznad - kod je već na disku)

- Link dat u poruci (`ovog linka: <URL>`) - fetch ga.
- Kod zalijepljen u istoj poruci/kodnom bloku - koristi direktno.
- Fajl je već sačuvan u `apps/<id>/app.js` (ručno prekopiran folder) - ništa se ne upisuje, samo pređi na Korak 2 (validacija) i Korak 4 (registracija) za taj `id`.
- Neki alati (npr. onima kojima treba ffmpeg ili slična server-side obrada) nose i izmjenu za `server.py`, odvojeno od `apps/<id>/app.js` - prepoznaj po eksplicitnoj oznaci (drugi kodni blok, "server.py izmjena" napomena) i primijeni je ODVOJENO. Nikad ne trpaj server-side kod unutar `apps/<id>/app.js` - vidi APPS_AND_WIDGETS.md pravilo 2 (server je opcion, mora se jasno degradirati bez sebe, poruka ne rušenje).

## Korak 2 - Validiraj PRIJE upisa

Ovo su ISTA pravila koja `apps-core.js registerApp()` provjerava u browseru - provjeri ih unaprijed da se ne upiše nešto što će tiho biti odbijeno:

- `id`: kebab-case (`^[a-z0-9]+(-[a-z0-9]+)*$`), poklapa se sa imenom foldera.
- `name`, `description`, `version`, `icon`: neprazan string.
- `icon` mora postojati kao `<symbol id="icon-tabler-<icon>">` u `index.html` - provjeri sa `grep 'icon-tabler-<icon>"' index.html`. Ako ne postoji, predloži najbližu postojeću ikonicu (grep `icon-tabler-` za punu listu) ili pitaj korisnika.
- Bar jedna od `widget(el, ctx)` / `app(el, ctx)` funkcija mora postojati.
- Ako ima `widget` formu: `sizes` mora imati bar jedan od `s`/`m`/`l`, svaki `{col, row}` cijeli broj 4-40.
- CSS klase i eventualni DOM id-jevi u alatu su prefiksovani po `id`-u alata (npr. `vk-` za video-kompresor) - brz sanity grep, ne mora biti savršen.

Ako nešto ne prolazi, ispravi sam ako je očigledno (npr. icon koji ne postoji → predloži zamjenu), ili pitaj korisnika ako je nejasno šta je namjeravano - tek onda nastavi na Korak 3.

## Korak 3 - Upiši fajlove

1. Napravi `apps/<id>/` ako ne postoji.
2. Sačuvaj `apps/<id>/app.js`.
3. Ako paket nosi i izmjenu za `server.py` - primijeni je (Edit, ne prepiši cijeli fajl), prateći postojeći `do_POST` dispatch obrazac (`path == '/api/<id>/...'`, vidi `handle_video_compress` u `apps/video-kompresor/app.js`-ovom pratećem server.py bloku kao žive reference) ako se dodaje endpoint.

## Korak 4 - Registruj u index.html

- Nov alat: dodaj `<script src="apps/<id>/app.js?v=1"></script>` unutar bloka "APLIKACIJE (alati)" (između `<!-- ===== APLIKACIJE... -->` i `<!-- === KRAJ APLIKACIJA === -->` markera) - redoslijed linija nije bitan.
- Ažuriranje: nađi postojeću liniju za taj `id`, podigni `?v=N` broj za jedan (npr. `?v=1` → `?v=2`) - bez ovoga browser može zadržati keširanu staru verziju iako server šalje no-cache headere za sam HTML (učitani `.js` fajl se kešira po svojoj URL putanji).

## Korak 5 - Provjeri PRIJE nego kažeš "gotovo"

1. **Sintaksa.** `node --check apps/<id>/app.js`. Ako je mijenjan i `server.py`: `python3 -c "import ast; ast.parse(open('server.py').read())"` (NE `py_compile` - piše cache fajl koji zna pući na permission greškama u sandboxovanom okruženju).
2. **Server radi.** `curl -s -o /dev/null -w '%{http_code}' http://localhost:8100/`. Ako nije 200, pokreni ga (`./start-mac.command` na Macu / `start-windows.bat` na Windowsu - vidi CLAUDE.md Korak 1).
3. **Restart samo ako treba.** Ako je mijenjan `server.py`, server MORA se restartovati da pokupi izmjenu (Python se ne hot-reload-uje kao statični JS/HTML) - `python3 server.py --stop` pa ponovo pokreni. Ako je promijenjen SAMO `app.js`/`index.html`, restart nije potreban - server već šalje `Cache-Control: no-store` na sam HTML, običan refresh u browseru je dovoljan.
4. **Alat se stvarno pojavljuje - provjeri SVAKU formu koju ima, ne samo jednu.** Alat može imati widget formu, app formu, ili obje odjednom (npr. `quick-notes`) - manifest sam kaže koje ima (`widget`/`app` polja), pa provjeri tačno te:
   - **Ima `widget` formu** → otvori Aplikacije panel, prebaci na "Widgeti" prikaz, nađi karticu alata, potvrdi da preview NE prikazuje "Alat je javio grešku".
   - **Ima `app` formu** → u "Aplikacije" prikazu (default) klikni alat da se otvori kao poseban tab, potvrdi da se stranica renderuje bez greške, pa se vrati na Dashboard (klik na "Dashboard" karticu).
   - Ako nema browser alata dostupnog u ovoj sesiji, minimalna provjera je obavezna za obje forme: `curl -s http://localhost:8100/index.html | grep 'apps/<id>/app.js'` potvrđuje da je script linija stvarno servirana (ne dokazuje da je manifest prošao registraciju ni da forma radi, ali hvata očigledne greške poput fajla koji nije sačuvan).
5. **Ako alat ima `widget` formu i korisnik već ima pripremljenu, imenovanu praznu sekciju za njega** - podsjeti ga (ne radi sam, pozicija/veličina je njegov izbor) da otvori njen meni (•••) → "Poveži alat..." da ga odmah prikaže tamo, umjesto da traži isti alat u katalogu i dodaje novu odvojenu karticu.

## Šta NE raditi

- Ne diraj druge alate ili njihove foldere.
- Ne diraj `dashboard-state.json` (korisnički layout board-a) - instalacija alata NIKAD sama ne dodaje widget instancu na board, samo ga čini DOSTUPNIM u katalogu. Gdje i da li se prikazuje bira korisnik (katalog, ili "Poveži alat" na već pripremljenoj sekciji).
- Ne javljaj "instalirano"/"gotovo" dok Korak 5 nije prošao. Pokvaren manifest (loš id, nedostaje `sizes`, id se ponavlja) se TIHO odbija uz `console.warn` i završi u `AIZdravo.rejected` - fajl postoji na disku, ali alat se nigdje ne pojavljuje. "Upisao sam fajl" nije isto što i "alat radi".

## Reference

Pun kontrakt (manifest oblik, `ctx` API, pravila autora alata): `APPS_AND_WIDGETS.md`. Živi šablon bez servera: `apps/quick-notes/app.js`. Živi šablon SA sopstvenim server endpointom (referenca za alat kome treba ffmpeg ili slična server-side obrada): `apps/video-kompresor/app.js` + odgovarajući `handle_video_compress` blok u `server.py`.
