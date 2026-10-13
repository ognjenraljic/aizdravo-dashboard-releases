---
name: update-dashboard
description: 'Primjenjuje noviju verziju dashboard core-a (index.html, app.js, apps-core.js, style.css, server.py, dokumentacija) iz lokalnog foldera nove verzije, bez da dira korisnikov raspored, teme ili instalirane alate. Uvijek pravi backup PRIJE primjene, provjerava SHA-256 hash svakog fajla PRIJE nego se bilo šta primijeni, i pri grešci vraća sve iz backupa. Trigger: "skinuta je nova verzija, ažuriraj dashboard", "primijeni update iz ovog foldera", "ažuriraj naš operativni sistem", "update dashboard core".'
---

# Update dashboard core-a (AI Zdravo Dashboard)

Cilj: dashboard core (izgled, funkcije, ispravke) se ažurira na novu verziju, a korisnikov raspored (`dashboard-state.json`), **instalirani alati (i njihove registracije u `index.html`, i eventualne server.py dopune)** i njegov `.aizdravo-welcomed` marker ostaju POTPUNO netaknuti. Backup se pravi UVIJEK, prije bilo koje izmjene, bez izuzetka. Ako kopiranje pukne usred posla (npr. Windows antivirus zaključa fajl), skripta sama vrati sve iz tog backupa i javi grešku.

## Izvor istine

**Nova verzija stiže kao lokalan folder** - korisnik je negdje dobio/raspakovao zip nove verzije (privatno podijeljen link, direktan transfer, itd.) i kaže nešto kao "skinuta je nova verzija, ažuriraj dashboard" ili "primijeni update iz ovog foldera". Nema mrežnog provjeravanja/preuzimanja - dashboard sam ne provjerava nikakav eksteran izvor za novu verziju, niti se oslanja na bilo koji javan servis. Sve što treba je putanja do raspakovanog foldera.

Provjeri da taj folder stvarno ima `MANIFEST.json` i `VERSION` u root-u (svaki pravi izvezen paket ih nosi) - ako ne, tretiraj kao nepouzdan izvor i pitaj korisnika da potvrdi da je zip kompletan/ispravno raspakovan.

Ako korisnik kaže da je nova verzija skinuta ali ne navede putanju, pitaj gdje je raspakovana (npr. Downloads, Desktop) prije nego nastaviš.

## Korak 1 - Uporedi verzije

1. Pročitaj lokalni `VERSION` fajl u root-u ovog foldera (ako ne postoji, tretiraj kao `0.0.0`).
2. Pročitaj `VERSION` iz foldera nove verzije (korisnikova putanja).
3. Ako su iste - provjeri da li lokalno postoji SVAKI fajl naveden u `MANIFEST.json` nove verzije. Ako neki fali, prošli update je bio polovičan (npr. sa 1.6.x na 1.7.0 radila je stara skripta koja nije znala za `tools/katalog.py`): nastavi na Korak 2 bez pitanja. Ako ništa ne fali, javi da je dashboard već na toj verziji i pitaj da li ipak želi primijeniti (npr. da vrati čisto stanje).
4. Ako je nova verzija novija - nastavi na Korak 2.
5. Ako je nova verzija STARIJA od lokalne - ne primjenjuj. Javi korisniku da bi to vratilo stariju verziju; samo ako to izričito traži, dodaj `--allow-downgrade` u Koraku 2.

## Korak 2-5 - Pokreni `tools/dashboard_updater.py` (mehanika je deterministička, ne prozna)

Backup + hash provjera + spajanje `index.html` bloka + detekcija `server.py` customizacije + atomska primjena su izvučeni iz proze u pravi Python skript, `tools/dashboard_updater.py` (determinističan kod, brže i bez rizika da neki korak bude preskočen ili pogrešno protumačen; test pokrivenost: `tools/test_dashboard_updater.py`).

```bash
cd <folder dashboarda>
python3 <putanja nove verzije>/tools/dashboard_updater.py . --source-dir <putanja nove verzije>
```

Skripta se pokreće IZ FOLDERA NOVE VERZIJE (ne lokalna `tools/dashboard_updater.py`): samo nova skripta zna za fajlove koje nova verzija donosi. Na Windowsu umjesto `python3` koristi isti Python kao u CLAUDE.md Koraku 2 (obično `py -3`). Putanje sa razmakom stavi u navodnike.

Skript sam radi sve ovo, u ovom redoslijedu:
1. Čita `MANIFEST.json` direktno iz foldera nove verzije (ako postoji - nema fetch koraka, sve lokalno).
2. SHA-256 provjera svakog fajla protiv `MANIFEST.json` - ako ijedan ne odgovara, PREKIDA ODMAH, ništa lokalno se ne mijenja, javlja grešku.
3. Backup CIJELOG trenutnog foldera u sibling folder (`../<ime-foldera>-backup-<YYYY-MM-DD-HHMM>/`).
4. Spaja `index.html`: izdvaja korisnikove `<script src="apps/...">` registracije iz TRENUTNOG fajla i ubacuje ih u NOVI (core update nikad ne prepisuje instalirane alate).
5. Provjerava `server.py`: ako trenutni fajl ima bilo koju metodu unutar `Handler` klase koja NE postoji u novoj core verziji (znak da je neki alat preko install-app skilla dodao sopstveni endpoint) - **preskače `server.py` u ovoj primjeni** (ostatak core-a se i dalje primjenjuje) i prijavljuje TAČNO koje metode su prepoznate kao customizacija.
6. Primjenjuje sve ostalo; ako bilo koji upis pukne, vraća sve iz backupa (`restored_from_backup` u izvještaju) i izlazi sa greškom.
7. Odbija izvor bez `MANIFEST.json` i izvor sa starijom verzijom (vidi Korak 1).

Rezultat je JSON izvještaj (`backup_dir`, `applied_files`, `server_customization_detected`, `server_update_skipped`) - pročitaj ga da znaš šta se tačno desilo.

**NIKAD ne dira** (skript ovo već garantuje, ali vrijedi znati zašto): `dashboard-state.json` (raspored/teme/tabovi), `apps/` (instalirani alati), `.aizdravo-welcomed`, `dashboard.pid`, `dashboard-autostart.log`, `errors.jsonl`.

Ako je izvještaj javio `server_customization_detected` (neprazna lista) i `server_update_skipped: true`:
- Javi korisniku TAČNO koje metode su prepoznate kao njegova dopuna.
- Pitaj da li želi da RUČNO spojiš: uzmeš core `server.py` iz backup foldera (ili iz foldera nove verzije) i preko Edit-a (ne bulk overwrite) vratiš tu dopunu nazad.
- Ako ne potvrdi, ostavi `server.py` kakav jeste (skript ga već nije dirao) - ostatak update-a je već primijenjen normalno.

Ako fajl `MANIFEST.json` ili `VERSION` nedostaje u folderu nove verzije, ili hash provjera pukne - tretiraj kao "izvor nije pouzdan/kompletan", vidi "Izvor istine" iznad, ne primjenjuj ništa.

## Korak 6 - Restart i provjera

1. Ako je `server.py` promijenjen - restartuj server (`python3 server.py --stop` pa ponovo pokreni preko `start-mac.command`/`start-windows.bat`, vidi CLAUDE.md Korak 3). Ako je promijenjen SAMO JS/CSS/HTML, običan refresh u browseru je dovoljan.
2. Provjeri da server odgovara na SVOM portu: port pročitaj iz `dashboard.pid` (JSON `{"pid": ..., "port": ...}`) ili iz izlaza start skripte - ne pretpostavljaj 8100 (na tom portu može biti drugi dashboard folder). `curl -s http://localhost:<port>/api/instance` mora vratiti `base_dir` OVOG foldera.
3. Provjeri da su korisnikovi podaci netaknuti - `dashboard-state.json` i `apps/` imaju IDENTIČAN sadržaj kao prije update-a (uporedi sa `backup_dir` iz JSON izvještaja ako je sumnjivo), i da se svi instalirani alati i dalje pojavljuju u katalogu.
4. Javi korisniku kratko: sa koje na koju verziju je ažurirano, gdje je backup (puna putanja iz izvještaja) ako nešto zatreba vraćanje, i da li je `server.py` update preskočen zbog korisničke dopune.

## Šta NE raditi

- Ne primjenjuj update bez da `dashboard_updater.py` prvo napravi backup - bez izuzetka (skript ovo garantuje sam, ali ne zaobilaziti ga ručnim kopiranjem fajlova).
- Ne diraj `dashboard-state.json` ni `apps/` ni pod kojim uslovom.
- Ne prepisuj `index.html` ručno mimo skripta (koji spaja blok APLIKACIJE) - to je najčešći način da update tiho obriše instalirane alate iz interfejsa.
- Ne prepisuj `server.py` ako izvještaj javi customizaciju, bez eksplicitne korisnikove potvrde.
- Ne primjenjuj ništa ako skript prijavi hash grešku (`UpdateError`).
- Ne javljaj "ažurirano" dok Korak 6 nije prošao.
- Ne pokreći ovaj skill automatski bez da korisnik eksplicitno zatraži i navede (ili potvrdi) putanju do nove verzije.
