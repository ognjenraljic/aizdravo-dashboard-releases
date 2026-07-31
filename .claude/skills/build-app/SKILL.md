---
name: build-app
description: 'Gradi NOV alat za AI Zdravo Dashboard od nule, isključivo pričanjem sa korisnikom - ne od zalijepljenog gotovog koda (za to postoji install-app). Pretvara korisnikov opis ("napravi mi widget koji...", "hoću alat za...", "u ovoj sekciji napravi...") u kompletan, radeći, PRENOSIV apps/<id>/ folder: manifest (registerApp), widget/app/oboje po potrebi, server_ext.py ako treba server dio, verzija 1.0.0. Alat se pojavljuje u katalogu SPREMAN za testiranje čim je gotov - korisnik ne mora prije toga praviti nikakvu sekciju. Prolazi kroz punu prenosivost provjeru (samodovoljan folder, izolovan test) prije nego javi "gotovo". Trigger: "napravi mi widget/alat/aplikaciju koji/za...", "hoću alat koji...", "napravimo alat za X", "u ovoj sekciji napravi...", "build me a tool/widget that...", ili kad korisnik na prazna (custom) sekciju kaže šta treba da radi. Radi i za Claude Code (native `.claude/skills/` otkrivanje) i za Codex preko `.agents/skills/build-app` (identičan fajl, ne simlink - Windows git-symlink gotcha).'
---

# Gradnja novog alata (AI Zdravo Dashboard)

Cilj: od jedne rečenice opisa do RADEĆEG, PRENOSIVOG alata u katalogu, bez međukoraka koje korisnik mora sam raditi. Ovo je PROIZVOĐAČKA strana kontrakta iz `APPS_AND_WIDGETS.md` — `install-app` skill je potrošačka strana (prima gotov kod/folder). Ne miješaj ih: ako korisnik LIJEPI gotov kod ili prompt "Instaliraj alat...", to je `install-app`, ne ovaj skill. Ovaj skill je za "hoću nešto što radi X" bez ijedne linije koda date unaprijed.

**Prenosivost nije opciona provjera na kraju — to je CILJ cijelog procesa.** Alat izgrađen ovim skillom mora raditi identično na BILO KOM AI Zdravo Dashboardu, ne samo na ovom — korisnik ga dijeli sa nekim drugim (folder + eventualne instrukcije unutar njega), taj neko ga prevuče u svoj `apps/` ili zalijepi `install-app` prompt, i radi bez ijedne dodatne izmjene. Svaki korak ispod postoji da to garantuje, ne samo Korak 6.

## Korak 0 — Razumij šta korisnik traži PRIJE pisanja koda

Ne piši kod na prvu rečenicu ako je nejasna. Razjasni (kratko, ne ispitivanje sa deset pitanja):

1. **Šta alat treba da radi** — konkretna funkcija, ne generički naziv. "Kalkulator" nije dovoljno; "kalkulator koji konvertuje jedinice dužine" jeste.
2. **Widget, aplikacija, ili oboje?** Widget = mala, brza forma koja živi kao sekcija na boardu (kompletna radnja u par klikova/sekundi). Aplikacija = puna forma sa više opcija, otvara se u svom tabu. Ako korisnik kaže "u ovoj sekciji napravi..." ili opiše nešto brzo i jednostavno → widget. Ako opiše nešto sa više koraka/podešavanja/prikaza → aplikacija, ili oboje (widget kao brz prečac + aplikacija za pun rad, isti obrazac kao Video Kompresor). Kad nije očigledno, pitaj jednom kratko umjesto da nagađaš.
3. **Treba li server dio?** Bilo šta što zahtijeva nešto van browsera — čitanje/pisanje fajlova na disku (npr. "sačuvaj na Desktop"), pokretanje eksternog programa (ffmpeg i sl.), mrežni poziv koji browser sam ne može (CORS) — treba `server_ext.py` (Korak 4). Čisto-browserska logika (računanje, prikaz, `ctx.storage` čuvanje) ne treba ništa od ovoga.
4. **Da li je sekcija već pripremljena?** Ako korisnik već ima praznu (custom) imenovanu sekciju i kaže "u OVOJ sekciji napravi X" — zapamti njenu veličinu (vidljivo u UI-u ili pitaj) kao orijentir za `sizes` u manifestu, ali NE veži alat na tu sekciju sam (vidi "Šta NE raditi" — to je korisnikov ručni korak preko "Poveži alat...").

## Korak 1 — `id` i folder

- `id`: kebab-case izveden iz imena/funkcije alata, kratak i jasan (npr. "konverter-jedinica", ne "moj-novi-alat-za-konverziju-jedinica-duzine"). Provjeri da `apps/<id>/` već ne postoji (`ls apps/`) — ako postoji, pitaj da li je ovo nova verzija POSTOJEĆEG alata (ide kroz `install-app` Ažuriranje mod, ne ovaj skill) ili stvarno drugi alat (promijeni id).
- Folder: `apps/<id>/`, `app.js` DIREKTNO u njemu (ne u podfolderu — vidi Korak 6).

## Korak 2 — Napiši manifest i implementaciju

Prati TAČNO oblik iz `APPS_AND_WIDGETS.md` ("Manifest (registerApp)" sekcija) — pun `ctx` API, event bus, pravila stilova su tamo, ne duplira se ovdje. Ključno za ovaj korak:

```js
AIZdravo.registerApp({
  id: '<id>',
  name: '...',                    // max 40 znakova
  description: '...',             // max 160 znakova
  icon: '<postojeca-tabler-ikonica>',
  version: '1.0.0',                // SVAKI nov alat kreće od 1.0.0, bez izuzetka
  sizes: { s: {col:8,row:6}, m: {col:16,row:10} },  // samo uz widget formu
  widget(el, ctx) { /* ... */ },
  app(el, ctx) { /* ... */ },
});
```

- **`icon`** mora VEĆ postojati u `index.html` kao `<symbol id="icon-tabler-<icon>">` — provjeri sa `grep 'icon-tabler-<icon>"' index.html` PRIJE nego je upišeš u manifest. Ne postoji → `grep 'icon-tabler-' index.html` za punu listu i izaberi najbližu, ili pitaj korisnika.
- **`ctx.storage`, nikad direktan `localStorage` ključ** — za bilo kakvo pamćenje stanja alata.
- **Boje isključivo preko `var(--accent)`/`var(--border)`/`var(--text)`...** — alat automatski prati svih 6 tema + custom + svijetli/tamni mod bez dodatnog koda.
- **CSS klase prefiksovane po `id`-u** (npr. `konverter-jedinica-drop`, ne `.drop`) — dva alata bez prefiksa mogu tiho pokvariti jedan drugog.
- **Fluidno renderovanje** — `container-type:size` na korijenskom elementu + `clamp()`/`cqh`/`cqw` za font/ikonice, NE fiksni `px` testiran na jednoj veličini (puna formula i primjer u `APPS_AND_WIDGETS.md` pravilo 7). Widget koji izgleda dobro samo na jednoj veličini nije gotov.
- **Bez eksternih zavisnosti** (CDN skripte/fontovi) — mora raditi offline.

## Korak 3 — Style injection

Alat ubacuje sopstveni `<style id="<id>-styles">` jednom sa provjerom `if (!document.getElementById(...))` na vrhu funkcije koja ga registruje — nikad se ne oslanja na to da će dashboard core ili neki drugi alat već imati stil koji mu treba.

## Korak 4 — Server dio, SAMO ako treba (Korak 0.3)

Nov `apps/<id>/server_ext.py`, NIKAD ručna izmjena `server.py`:

```python
ROUTES = { ('POST', '/api/<id>/<akcija>'): 'handle_<akcija>' }
def handle_<akcija>(handler):
    handler.send_json(200, {...})
```

`aizdravo.BASE_DIR`, `aizdravo.resolve_desktop_dir()`, `aizdravo.safe_popen_kwargs()`, `aizdravo.register_shutdown_hook(fn)` su dostupni bez importa (core ih injektuje). Core `server.py` OTKRIJE ovaj fajl sam, LIJENO, čim stigne prvi zahtjev na njegovu rutu — instalacija radi i dok je dashboard već pokrenut, restart nije potreban za NOV `server_ext.py` fajl (jeste potreban ako se MIJENJA postojeći core `server.py`, što ovaj skill nikad ne radi). Ako alat zavisi od eksternog programa (npr. ffmpeg), dodaj rutu koja provjerava `shutil.which(...)` i pozovi je čim se `widget()`/`app()` učita, po obrascu `apps/video-kompresor/server_ext.py` (ako je instaliran) — degradiraj sa jasnom porukom, ne rušenjem, ako program nije prisutan.

## Korak 5 — Registruj u index.html

Dodaj `<script src="apps/<id>/app.js?v=1"></script>` unutar bloka "APLIKACIJE (alati)" (između markera). Ovim je alat ODMAH vidljiv u katalogu — bez ijednog dodatnog koraka, bez potrebe da korisnik prvo napravi sekciju.

## Korak 6 — Prenosivost provjera (OBAVEZNA, prije "gotovo")

Ovo nije opciona higijena — ovo je CIJELA poenta. Prođi kroz svaku stavku iz `APPS_AND_WIDGETS.md` sekcije "Prenosivost", eksplicitno:

1. **`app.js` je direktno u `apps/<id>/`**, ne u podfolderu.
2. **Samodovoljnost — stvaran izolovan test, ne pretpostavka.** Kopiraj `apps/<id>/` u prazan privremeni folder (`cp -R apps/<id>/ /tmp/portability-test-<id>/`) i provjeri da NIJEDAN fajl unutra ne referencira ništa apsolutnom putanjom sa OVOG računara, niti fajl iz nekog DRUGOG alata (`grep -rn "/Users/\|/home/\|C:\\\\" apps/<id>/` — prazan izlaz = prošlo). Svaka biblioteka/slika/JSON koju `app.js` učitava mora fizički biti UNUTAR tog istog foldera, referencirana relativno.
3. **`id` u manifestu odgovara imenu foldera.**
4. **`version: '1.0.0'`** stoji u manifestu (Korak 2 — ponovo provjeri da nije zaboravljeno ili promijenjeno tokom pisanja).
5. **Server dio (ako postoji) je isključivo u `apps/<id>/server_ext.py`** — nula pretpostavki da ciljni dashboard već ima nešto ručno dodano u svom `server.py`.
6. **`icon` postoji u OVOM `index.html`-u** (provjereno u Koraku 2) — na drugom dashboardu isti core simbol set postoji po dizajnu (core fajl, dio svakog izdanja), pa ova provjera ovdje već garantuje i tamo.
7. **`ctx.storage`, ne `localStorage`** (provjereno u Koraku 2) — garantuje da se na NOVOM dashboardu alat učita prazan/default, ne vuče tuđe podatke.

Obriši `/tmp/portability-test-<id>/` poslije provjere.

## Korak 7 — Provjeri da alat STVARNO radi (ista disciplina kao `install-app` Korak 5)

1. **Sintaksa.** `node --check apps/<id>/app.js`. Ako je pisan `server_ext.py`: `python3 -c "import ast; ast.parse(open('apps/<id>/server_ext.py').read())"`.
2. **Server dostupan.** `curl -s -o /dev/null -w '%{http_code}' http://localhost:8100/` — ako nije 200, pokreni (`./start-mac.command`/`start-windows.bat`).
3. **Nov `server_ext.py` NE traži restart** (lijeno učitavanje, vidi Korak 4) — samo `app.js`/`index.html` izmjena, obična browser osvježa dovoljna.
4. **Alat se pojavljuje u katalogu, provjeri SVAKU formu koju ima:**
   - Widget → katalog (+ dole desno → Alati) → "Widgeti" prikaz → kartica alata, preview BEZ "Alat je javio grešku".
   - Aplikacija → "Aplikacije" prikaz → klik otvara u sopstvenom tabu bez greške.
   - Testiraj widget na BAR DVIJE različite veličine sekcije (npr. `s` i `l` preset) — fiksni `px` koji je "izgledao dobro" na jednoj veličini je čest propust (vidi Korak 2).
   - Bez browser alata dostupnog: `curl -s http://localhost:8100/index.html | grep 'apps/<id>/app.js'` (minimalna provjera, ne dokazuje da forma stvarno radi).

## Šta NE raditi

- Ne pretpostavljaj kod — ako korisnikov opis ostavlja stvarnu nejasnoću (widget vs aplikacija, šta tačno "brzo" znači za tu funkciju), pitaj JEDNOM kratko prije pisanja, ne poslije.
- Ne veži nov alat na postojeću sekciju sam, čak i ako je korisnik rekao "u ovoj sekciji napravi X" — sekcija ostaje netaknuta, alat se pojavi u katalogu, PA korisnik sam preko "Poveži alat..." (meni sekcije) poveže — isti princip kao `install-app`: instalacija/gradnja NIKAD sama ne dodaje widget instancu na board.
- Ne diraj core `server.py` direktno, ni za jedan red koda — uvijek `apps/<id>/server_ext.py`.
- Ne javljaj "gotovo" dok Korak 6 (prenosivost) i Korak 7 (radi) nisu oba prošla. Alat koji "izgleda gotov" a nije prenosiv je gotov samo na OVOM računaru — poenta cijelog serijala je da gledalac ponovi isto na svom.

## Reference

Pun kontrakt (manifest oblik, `ctx` API, event bus, pravila stilova, kompletan primjer): `APPS_AND_WIDGETS.md`. Potrošačka strana istog kontrakta (instalacija gotovog koda/foldera): `.claude/skills/install-app/`. Server-plugin obrazac uživo: `apps/video-kompresor/server_ext.py` (ako je trenutno instaliran na ovom dashboardu).
