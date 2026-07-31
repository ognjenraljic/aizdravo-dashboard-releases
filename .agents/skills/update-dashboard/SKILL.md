---
name: update-dashboard
description: 'Provjerava da li postoji novija verzija SAMOG dashboard core-a (index.html, app.js, apps-core.js, style.css, server.py, dokumentacija) i primjenjuje je bez da dira korisnikov raspored, teme ili instalirane alate. Uvijek pravi backup PRIJE primjene, provjerava SHA-256 hash svakog fajla PRIJE nego se bilo šta primijeni, i radi atomski (sve ili ništa). Trigger: "provjeri ima li update za dashboard", "ažuriraj dashboard", "da li imam najnoviju verziju dashboarda", "update dashboard core".'
---

# Update dashboard core-a (AI Zdravo Dashboard)

Cilj: dashboard core (izgled, funkcije, ispravke) se ažurira na najnoviju verziju, a korisnikov raspored (`dashboard-state.json`), **instalirani alati (i njihove registracije u `index.html`, i eventualne server.py dopune)** i njegov `.aizdravo-welcomed` marker ostaju POTPUNO netaknuti. Backup se pravi UVIJEK, prije bilo koje izmjene, bez izuzetka. Primjena je atomska (garantovano kodom u `tools/dashboard_updater.py`, ne prozom) - ili sve prođe do kraja, ili se ništa lokalno ne mijenja.

## Izvor istine

Core fajlovi se hostuju u GitHub repou `ognjenraljic/aizdravo-dashboard-releases` (JAVAN repo - mora biti public da `raw.githubusercontent.com` fetch radi bez autentikacije sa bilo čije mašine koja skida dashboard; sadrži SAMO core - bez korisničkih podataka, provjereno prije objave). Raw URL baza:

```
https://raw.githubusercontent.com/ognjenraljic/aizdravo-dashboard-releases/main/
```

Uz `VERSION`, repo nosi i `MANIFEST.json` - `{"fajl/putanja": "sha256hex", ...}` za SVAKI core fajl te verzije. Manifest je obavezan dio provjere integriteta (radi ga sam `dashboard_updater.py`, Korak 2-5 ispod) - ako ga fetch ne vrati, tretiraj kao da update-izvor nije dostupan (isto kao 404 ispod), ne primjenjuj ništa bez njega.

Ako fetch na ovaj URL vrati 404 ili grešku (repo još ne postoji, ili nije public/nije dostupan bez auth-a) - javi korisniku jasno da update-izvor još nije podešen, ne pravi ništa, ne javljaj lažno "gotovo".

### Alternativa - korisnik već ima lokalno raspakovan folder nove verzije

Ako je korisnik SAM skinuo/raspakovao zip nove verzije (bilo odakle - GitHub Release, privatan link, itd.) i kaže nešto kao "primijeni update iz ovog foldera" ili "vidi šta je novo u toj verziji i primijeni kod nas" - ne treba nikakav fetch. `dashboard_updater.py` ima `--source-dir` umjesto `--source-url` (vidi Korak 2-5) koji radi IDENTIČNU `apply_update()` mehaniku (backup, SHA-256 provjera protiv `MANIFEST.json` UNUTAR tog lokalnog foldera, spajanje `index.html`, detekcija `server.py` customizacije) potpuno offline, bez ijednog mrežnog poziva. Provjeri samo da raspakovan folder stvarno ima `MANIFEST.json` i `VERSION` u root-u (svaki pravi release ih nosi) - ako ne, tretiraj kao nepouzdan izvor i pitaj korisnika da potvrdi da je zip kompletan.

## Korak 1 - Uporedi verzije

1. Pročitaj lokalni `VERSION` fajl u root-u ovog foldera (ako ne postoji, tretiraj kao `0.0.0`).
2. Fetch `VERSION` sa raw URL-a iznad.
3. Ako su iste - javi korisniku da je dashboard već na najnovijoj verziji, završi ovdje.
4. Ako je remote noviji - nastavi na Korak 2. Ako fetch ne uspije - vidi "Izvor istine" iznad.

## Korak 2-5 - Pokreni `tools/dashboard_updater.py` (mehanika je deterministička, ne prozna)

Od 28.7.2026, backup + fetch + hash provjera + spajanje `index.html` bloka + detekcija `server.py` customizacije + atomska primjena su izvučeni iz proze u pravi Python skript, `tools/dashboard_updater.py` (ista logika koju bi ranije AI agent ručno pratio korak po korak - sad je to determinističan kod, brže i bez rizika da neki korak bude preskočen ili pogrešno protumačen; test pokrivenost: `tools/test_dashboard_updater.py`).

```bash
cd <folder dashboarda>
python3 tools/dashboard_updater.py . --source-url https://raw.githubusercontent.com/ognjenraljic/aizdravo-dashboard-releases/main
```

Ili, za lokalni-folder slučaj iz "Alternativa" iznad (bez fetch-a):

```bash
cd <folder dashboarda>
python3 tools/dashboard_updater.py . --source-dir <putanja do raspakovanog foldera nove verzije>
```

Skript sam radi sve ovo, u ovom redoslijedu:
1. Fetch `MANIFEST.json` + svaki core fajl sa raw URL-a u privremeni staging folder (ili, kod `--source-dir`, čita ih direktno iz tog lokalnog foldera - nema fetch koraka).
2. SHA-256 provjera svakog fajla protiv `MANIFEST.json` - ako ijedan ne odgovara, PREKIDA ODMAH, ništa lokalno se ne mijenja, javlja grešku.
3. Backup CIJELOG trenutnog foldera u sibling folder (`../<ime-foldera>-backup-<YYYY-MM-DD-HHMM>/`).
4. Spaja `index.html`: izdvaja korisnikove `<script src="apps/...">` registracije iz TRENUTNOG fajla i ubacuje ih u NOVI (core update nikad ne prepisuje instalirane alate).
5. Provjerava `server.py`: ako trenutni fajl ima bilo koju metodu unutar `Handler` klase koja NE postoji u novoj core verziji (znak da je neki alat preko install-app skilla dodao sopstveni endpoint) - **preskače `server.py` u ovoj primjeni** (ostatak core-a se i dalje primjenjuje) i prijavljuje TAČNO koje metode su prepoznate kao customizacija.
6. Atomski primjenjuje sve ostalo.

Rezultat je JSON izvještaj (`backup_dir`, `applied_files`, `server_customization_detected`, `server_update_skipped`) - pročitaj ga da znaš šta se tačno desilo.

**NIKAD ne dira** (skript ovo već garantuje, ali vrijedi znati zašto): `dashboard-state.json` (raspored/teme/tabovi), `apps/` (instalirani alati), `.aizdravo-welcomed`, `dashboard.pid`, `dashboard-autostart.log`, `errors.jsonl`.

Ako je izvještaj javio `server_customization_detected` (neprazna lista) i `server_update_skipped: true`:
- Javi korisniku TAČNO koje metode su prepoznate kao njegova dopuna.
- Pitaj da li želi da RUČNO spojiš: uzmeš core `server.py` iz backup foldera (ili ponovnim fetch-om) i preko Edit-a (ne bulk overwrite) vratiš tu dopunu nazad.
- Ako ne potvrdi, ostavi `server.py` kakav jeste (skript ga već nije dirao) - ostatak update-a je već primijenjen normalno.

Ako je fetch/hash provjera pukla (Korak 1-2 skripta), tretiraj kao "update-izvor nije dostupan" - vidi "Izvor istine" iznad, ne primjenjuj ništa.

## Korak 6 - Restart i provjera

1. Ako je `server.py` promijenjen - restartuj server (`python3 server.py --stop` pa ponovo pokreni preko `start-mac.command`/`start-windows.bat`, vidi CLAUDE.md Korak 3). Ako je promijenjen SAMO JS/CSS/HTML, običan refresh u browseru je dovoljan.
2. Provjeri da server odgovara: `curl -s -o /dev/null -w '%{http_code}' http://localhost:8100/` treba vratiti 200.
3. Provjeri da su korisnikovi podaci netaknuti - `dashboard-state.json` i `apps/` imaju IDENTIČAN sadržaj kao prije update-a (uporedi sa `backup_dir` iz JSON izvještaja ako je sumnjivo), i da se svi instalirani alati i dalje pojavljuju u katalogu.
4. Javi korisniku kratko: sa koje na koju verziju je ažurirano, gdje je backup (puna putanja iz izvještaja) ako nešto zatreba vraćanje, i da li je `server.py` update preskočen zbog korisničke dopune.

## Šta NE raditi

- Ne primjenjuj update bez da `dashboard_updater.py` prvo napravi backup - bez izuzetka (skript ovo garantuje sam, ali ne zaobilaziti ga ručnim kopiranjem fajlova).
- Ne diraj `dashboard-state.json` ni `apps/` ni pod kojim uslovom.
- Ne prepisuj `index.html` ručno mimo skripta (koji spaja blok APLIKACIJE) - to je najčešći način da update tiho obriše instalirane alate iz interfejsa.
- Ne prepisuj `server.py` ako izvještaj javi customizaciju, bez eksplicitne korisnikove potvrde.
- Ne primjenjuj ništa ako skript prijavi hash grešku (`UpdateError`).
- Ne javljaj "ažurirano" dok Korak 6 nije prošao.
- Ne pokreći ovaj skill automatski bez da korisnik eksplicitno zatraži - za razliku od Python-provjere/pokretanja dashboarda (CLAUDE.md Korak 2-3), provjera update-a NIJE automatska pri svakom otvaranju sesije.
