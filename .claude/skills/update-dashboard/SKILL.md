---
name: update-dashboard
description: 'Provjerava da li postoji novija verzija SAMOG dashboard core-a (index.html, app.js, apps-core.js, style.css, server.py, dokumentacija) i primjenjuje je bez da dira korisnikov raspored, teme ili instalirane alate. Uvijek pravi backup PRIJE primjene. Trigger: "provjeri ima li update za dashboard", "ažuriraj dashboard", "da li imam najnoviju verziju dashboarda", "update dashboard core".'
---

# Update dashboard core-a (AI Zdravo Dashboard)

Cilj: dashboard core (izgled, funkcije, ispravke) se ažurira na najnoviju verziju, a korisnikov raspored (`dashboard-state.json`), instalirani alati (`apps/`) i njegov `.aizdravo-welcomed` marker ostaju POTPUNO netaknuti. Backup se pravi UVIJEK, prije bilo koje izmjene, bez izuzetka.

## Izvor istine

Core fajlovi se hostuju u GitHub repou `ognjenraljic/aizdravo-dashboard-releases` (privatan repo, samo core - bez korisničkih podataka). Raw URL baza:

```
https://raw.githubusercontent.com/ognjenraljic/aizdravo-dashboard-releases/main/
```

Ako fetch na ovaj URL vrati 404 ili grešku (repo još ne postoji, ili nije public/nije dostupan bez auth-a) - javi korisniku jasno da update-izvor još nije podešen, ne pravi ništa, ne javljaj lažno "gotovo".

## Korak 1 - Uporedi verzije

1. Pročitaj lokalni `VERSION` fajl u root-u ovog foldera (ako ne postoji, tretiraj kao `0.0.0`).
2. Fetch `VERSION` sa raw URL-a iznad.
3. Ako su iste - javi korisniku da je dashboard već na najnovijoj verziji, završi ovdje.
4. Ako je remote noviji - nastavi na Korak 2. Ako fetch ne uspije - vidi "Izvor istine" iznad.

## Korak 2 - Backup PRIJE bilo čega

Napravi potpunu kopiju CIJELOG trenutnog foldera (isti princip kao ručni backup - "cijeli dashboard je samo folder") u sibling folder pored njega, npr. `../aizdravo-backup-<YYYY-MM-DD-HHMM>/`. Ovo je jeftina sigurnosna kopija - ako nešto poslije update-a ne valja, korisnik se vraća na taj folder umjesto da izgubi raspored/alate. Ne nastavljaj na Korak 3 dok backup nije potvrđeno završen.

## Korak 3 - Primijeni SAMO core fajlove

Fetch i prepiši SAMO ove putanje (svaka 1:1 prema istoj putanji u repou):

```
index.html, app.js, apps-core.js, style.css, server.py
APPS_AND_WIDGETS.md, CLAUDE.md, AGENTS.md, README.md, VERSION
vendor/sortable.min.js
assets/logo.png
start-mac.command, start-windows.bat, stop-mac.command, stop-windows.bat
install-autostart-mac.command, install-autostart-windows.bat
uninstall-autostart-mac.command, uninstall-autostart-windows.bat
.claude/skills/install-app/SKILL.md
.claude/skills/update-dashboard/SKILL.md
```

**NIKAD ne diraj** (izostavi iz fetch liste potpuno, čak i ako bi remote repo teoretski imao fajl na toj putanji):
- `dashboard-state.json` (korisnikov raspored/teme/tabovi)
- `apps/` (svi instalirani alati korisnika, uključujući njihov sopstveni kod i podatke)
- `.aizdravo-welcomed` (marker za prvi pozdrav - ne treba se ponoviti poslije update-a)
- `dashboard.pid`, `dashboard-autostart.log`, `errors.jsonl` (per-mašina runtime fajlovi)

Ako neki core fajl ne postoji lokalno (npr. sasvim nov fajl dodat u novijoj verziji) - kreiraj ga. Ako korisnik ima svoj `.gitignore` sa dodatnim linijama - ne prepisuj taj fajl bez provjere (rijedak slučaj, samo ako ga je ručno mijenjao).

## Korak 4 - Restart i provjera

1. Ako je `server.py` promijenjen - restartuj server (`python3 server.py --stop` pa ponovo pokreni preko `start-mac.command`/`start-windows.bat`, vidi CLAUDE.md Korak 3). Ako je promijenjen SAMO JS/CSS/HTML, običan refresh u browseru je dovoljan.
2. Provjeri da server odgovara: `curl -s -o /dev/null -w '%{http_code}' http://localhost:8100/` treba vratiti 200.
3. Provjeri da su korisnikovi podaci netaknuti - `dashboard-state.json` i `apps/` imaju IDENTIČAN sadržaj kao prije update-a (uporedi sa backup kopijom iz Koraka 2 ako je sumnjivo).
4. Javi korisniku kratko: sa koje na koju verziju je ažurirano, i gdje je backup (puna putanja) ako nešto zatreba vraćanje.

## Šta NE raditi

- Ne primjenjuj update bez da prvo napraviš backup (Korak 2) - bez izuzetka.
- Ne diraj `dashboard-state.json` ni `apps/` ni pod kojim uslovom.
- Ne javljaj "ažurirano" dok Korak 4 nije prošao.
- Ne pokreći ovaj skill automatski bez da korisnik eksplicitno zatraži - za razliku od Python-provjere/pokretanja dashboarda (CLAUDE.md Korak 2-3), provjera update-a je NIJE automatska pri svakom otvaranju sesije.
