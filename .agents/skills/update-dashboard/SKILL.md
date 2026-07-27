---
name: update-dashboard
description: 'Provjerava da li postoji novija verzija SAMOG dashboard core-a (index.html, app.js, apps-core.js, style.css, server.py, dokumentacija) i primjenjuje je bez da dira korisnikov raspored, teme ili instalirane alate. Uvijek pravi backup PRIJE primjene, provjerava SHA-256 hash svakog fajla PRIJE nego se bilo šta primijeni, i radi atomski (sve ili ništa). Trigger: "provjeri ima li update za dashboard", "ažuriraj dashboard", "da li imam najnoviju verziju dashboarda", "update dashboard core".'
---

# Update dashboard core-a (AI Zdravo Dashboard)

Cilj: dashboard core (izgled, funkcije, ispravke) se ažurira na najnoviju verziju, a korisnikov raspored (`dashboard-state.json`), **instalirani alati (i njihove registracije u `index.html`, i eventualne server.py dopune)** i njegov `.aizdravo-welcomed` marker ostaju POTPUNO netaknuti. Backup se pravi UVIJEK, prije bilo koje izmjene, bez izuzetka. Primjena je atomska - ili sve prođe (Korak 1-5 do kraja), ili se ništa lokalno ne mijenja.

## Izvor istine

Core fajlovi se hostuju u GitHub repou `ognjenraljic/aizdravo-dashboard-releases` (JAVAN repo - mora biti public da `raw.githubusercontent.com` fetch radi bez autentikacije sa bilo čije mašine koja skida dashboard; sadrži SAMO core - bez korisničkih podataka, provjereno prije objave). Raw URL baza:

```
https://raw.githubusercontent.com/ognjenraljic/aizdravo-dashboard-releases/main/
```

Uz `VERSION`, repo nosi i `MANIFEST.json` - `{"fajl/putanja": "sha256hex", ...}` za SVAKI core fajl te verzije. Manifest je obavezan dio provjere integriteta (Korak 3) - ako ga fetch ne vrati, tretiraj kao da update-izvor nije dostupan (isto kao 404 ispod), ne primjenjuj ništa bez njega.

Ako fetch na ovaj URL vrati 404 ili grešku (repo još ne postoji, ili nije public/nije dostupan bez auth-a) - javi korisniku jasno da update-izvor još nije podešen, ne pravi ništa, ne javljaj lažno "gotovo".

## Korak 1 - Uporedi verzije

1. Pročitaj lokalni `VERSION` fajl u root-u ovog foldera (ako ne postoji, tretiraj kao `0.0.0`).
2. Fetch `VERSION` sa raw URL-a iznad.
3. Ako su iste - javi korisniku da je dashboard već na najnovijoj verziji, završi ovdje.
4. Ako je remote noviji - nastavi na Korak 2. Ako fetch ne uspije - vidi "Izvor istine" iznad.

## Korak 2 - Backup PRIJE bilo čega

Napravi potpunu kopiju CIJELOG trenutnog foldera (isti princip kao ručni backup - "cijeli dashboard je samo folder") u sibling folder pored njega, npr. `../aizdravo-backup-<YYYY-MM-DD-HHMM>/`. Ovo je jeftina sigurnosna kopija - ako nešto poslije update-a ne valja, korisnik se vraća na taj folder umjesto da izgubi raspored/alate. Ne nastavljaj na Korak 3 dok backup nije potvrđeno završen.

## Korak 3 - Skini i PROVJERI u privremeni folder (ništa lokalno se još ne mijenja)

1. Fetch `MANIFEST.json` i `VERSION` sa raw URL-a.
2. Fetch SVAKI core fajl iz liste ispod u privremeni staging folder (npr. `.aizdravo-update-staging/`), NE direktno preko lokalnih fajlova:

```
index.html, app.js, apps-core.js, style.css, server.py
APPS_AND_WIDGETS.md, CLAUDE.md, AGENTS.md, README.md, VERSION, MANIFEST.json
vendor/sortable.min.js
assets/logo.png
start-mac.command, start-windows.bat, stop-mac.command, stop-windows.bat
install-autostart-mac.command, install-autostart-windows.bat
uninstall-autostart-mac.command, uninstall-autostart-windows.bat
.claude/skills/install-app/SKILL.md
.claude/skills/update-dashboard/SKILL.md
```

3. Za SVAKI skinut fajl, izračunaj SHA-256 (`shasum -a 256 <fajl>` ili ekvivalent) i uporedi sa `MANIFEST.json`. Ako ijedan fajl ne odgovara svom hash-u - PREKINI ODMAH, obriši staging folder, javi korisniku da provjera integriteta nije prošla (mogući nepotpun download ili kompromitovan izvor), ne primjenjuj ništa.
4. Tek kad SVAKI fajl prođe hash provjeru, nastavi na Korak 4.

**NIKAD ne diraj** (izostavi iz fetch liste potpuno, čak i ako bi remote repo teoretski imao fajl na toj putanji):
- `dashboard-state.json` (korisnikov raspored/teme/tabovi)
- `apps/` (svi instalirani alati korisnika, uključujući njihov sopstveni kod i podatke)
- `.aizdravo-welcomed` (marker za prvi pozdrav - ne treba se ponoviti poslije update-a)
- `dashboard.pid`, `dashboard-autostart.log`, `errors.jsonl` (per-mašina runtime fajlovi)

## Korak 4 - Spoji `index.html` (NIKAD ga ne prepisuj golo) i provjeri `server.py`

`index.html` nosi i core markup (update-uje se) i registracije korisnikovih instaliranih alata unutar bloka `<!-- ===== APLIKACIJE (alati) ===== -->` ... `<!-- === KRAJ APLIKACIJA === -->` (NE update-uje se - to su korisnikovi podaci, isti princip kao `apps/`). Preskočiti ovo pravilo znači da instalirani alati nestanu iz kataloga poslije update-a iako `apps/` folder ostaje netaknut na disku.

1. Iz TRENUTNOG (starog) lokalnog `index.html`, izdvoj TAČAN sadržaj između ta dva markera (sve `<script src="apps/...">` linije koje korisnik ima).
2. U NOVOM (staged) `index.html`, zamijeni njegov (prazan ili drugačiji) sadržaj između istih markera tim izdvojenim sadržajem.
3. Rezultat je core update + korisnikove registracije alata sačuvane - to je verzija koja ide u Korak 5.

Za `server.py`: uporedi staged (novi core) `server.py` sa lokalnim. Ako lokalni `server.py` sadrži bilo koji `handle_` blok ili `do_POST`/`do_GET` granu koja NE postoji u staged verziji (znak da je neki instalirani alat dodao sopstveni server-side endpoint preko install-app skilla) - **NE prepisuj `server.py` automatski**. Umjesto toga:
   - Javi korisniku tačno koji dio izgleda kao njegova dopuna (imena funkcija/putanja).
   - Ponudi da RUČNO, uz njegovu potvrdu, prepišeš `server.py` novom core verzijom i PA VRATIŠ tu dopunu nazad (Edit, ne bulk overwrite) - isti oprez kao kad install-app prvi put dodaje takvu dopunu.
   - Ako korisnik ne potvrdi, preskoči `server.py` u ovom update-u (ostatak core-a se i dalje primjenjuje), i to jasno navedi u završnom izvještaju (Korak 6).
   Ako lokalni `server.py` NEMA nikakvu dopunu van poznatog baznog seta (`handle_log_error`, `handle_video_compress`, `handle_delete_app`) - staged verzija se primjenjuje direktno, bez pitanja.

## Korak 5 - Atomska primjena

Tek kad su Korak 3 (hash) i Korak 4 (index.html spoj + server.py provjera) završeni bez greške, premjesti (ne kopiraj pojedinačno) svaki staged fajl na svoje mjesto. Ako bilo šta u ovom koraku pukne na pola puta, odmah zaustavi i uputi korisnika na backup iz Koraka 2 - ne pokušavaj djelimično popravljati.

## Korak 6 - Restart i provjera

1. Ako je `server.py` promijenjen - restartuj server (`python3 server.py --stop` pa ponovo pokreni preko `start-mac.command`/`start-windows.bat`, vidi CLAUDE.md Korak 3). Ako je promijenjen SAMO JS/CSS/HTML, običan refresh u browseru je dovoljan.
2. Provjeri da server odgovara: `curl -s -o /dev/null -w '%{http_code}' http://localhost:8100/` treba vratiti 200.
3. Provjeri da su korisnikovi podaci netaknuti - `dashboard-state.json` i `apps/` imaju IDENTIČAN sadržaj kao prije update-a (uporedi sa backup kopijom iz Koraka 2 ako je sumnjivo), i da se svi instalirani alati i dalje pojavljuju u katalogu (Korak 4 provjera).
4. Javi korisniku kratko: sa koje na koju verziju je ažurirano, gdje je backup (puna putanja) ako nešto zatreba vraćanje, i da li je `server.py` update preskočen zbog korisničke dopune (Korak 4).

## Šta NE raditi

- Ne primjenjuj update bez da prvo napraviš backup (Korak 2) - bez izuzetka.
- Ne diraj `dashboard-state.json` ni `apps/` ni pod kojim uslovom.
- Ne prepisuj `index.html` bez spajanja bloka APLIKACIJE (Korak 4) - to je najčešći način da update tiho obriše instalirane alate iz interfejsa.
- Ne prepisuj `server.py` ako sadrži korisničku dopunu, bez eksplicitne potvrde (Korak 4).
- Ne primjenjuj nijedan fajl čiji hash ne odgovara `MANIFEST.json` (Korak 3).
- Ne javljaj "ažurirano" dok Korak 6 nije prošao.
- Ne pokreći ovaj skill automatski bez da korisnik eksplicitno zatraži - za razliku od Python-provjere/pokretanja dashboarda (CLAUDE.md Korak 2-3), provjera update-a NIJE automatska pri svakom otvaranju sesije.
