# Aplikacije i widgeti — distribucioni kontrakt

Ovaj dokument je izvor istine za pravljenje i instalaciju alata za AI Zdravo Dashboard. Piše se jednom, koristi svake sedmice: svaka epizoda serijala donosi nov alat koji gledaoci instaliraju u svoj lokalni dashboard — ručno ili tako što zalijepe gotov prompt u Claude Code / Codex.

## Pojmovi

Svaki **alat** može imati dvije forme istog koda:

- **Widget** — mala, brza verzija koja živi kao sekcija na boardu (npr. video kompresor: prevuci jedan fajl, gotovo). Veličinu (S/M/L) određuje autor alata u manifestu; korisnik je poslije može ručno mijenjati kao svaku sekciju, osim ako alat kaže `resizable: false`.
- **Aplikacija** — puna verzija sa svim opcijama. Otvara se u SVOM tabu (narandžasta tačka lijevo u sidebar-u, x za zatvaranje). Jedna aplikacija = najviše jedan otvoren tab; ponovno otvaranje samo fokusira postojeći. Otvoreni app tabovi prežive reload.

**Forme su pojedinačno opcione — bar jedna mora postojati.** Alat može biti samo widget (npr. sat), samo aplikacija (npr. složen editor bez smislene mini forme), ili oboje. Katalog automatski prikazuje alat samo u prikazima za forme koje ima; folder pločice nude samo alate sa app formom; `sizes` su obavezne samo uz widget formu. Kad postoje obje forme, pišu se u jednom fajlu kroz jedan `registerApp` poziv — nikad dva odvojena koda koja se ručno sinhronizuju.

## Struktura alata

```
apps/
  <app-id>/            # kebab-case, jedinstven (npr. video-kompresor)
    app.js             # manifest + widget + app render, sve u jednom
    ...                # opcioni dodatni fajlovi alata (slike, podaci)
```

Instalacija = folder u `apps/` + JEDNA script linija u `index.html`, unutar jasno označenog bloka:

```html
<!-- ===================== APLIKACIJE (alati) ===================== -->
<script src="apps/quick-notes/app.js?v=1"></script>
<script src="apps/<app-id>/app.js?v=1"></script>   <!-- nova linija -->
<!-- =================== KRAJ APLIKACIJA ========================== -->
```

Nema build koraka, nema npm-a, nema fetch-a — zato radi i preko `server.py` i dvoklikom na `index.html` (file://).

## Manifest (registerApp)

`apps/<app-id>/app.js` zove `AIZdravo.registerApp({...})` na vrhu fajla:

```js
AIZdravo.registerApp({
  id: 'video-kompresor',          // OBAVEZNO, kebab-case, jedinstven
  name: 'Video Kompresor',        // OBAVEZNO, max 40 znakova
  description: 'Smanji video u par sekundi.',  // OBAVEZNO, max 160
  icon: 'video',                  // OBAVEZNO - ime tabler <symbol> ikonice
                                  // iz index.html (bez "icon-tabler-" prefiksa)
  version: '1.0.0',               // OBAVEZNO
  sizes: {                        // OBAVEZNO bar jedna od s/m/l
    s: { col: 8,  row: 6 },       // col/row = broj 28px grid polja (4-40)
    m: { col: 16, row: 10 },
  },
  defaultSize: 's',               // opciono; default = prva postojeća
  resizable: true,                // opciono; false = korisnik ne može
                                  // mijenjati veličinu widgeta (sakrivene
                                  // resize ručke i S/M/L preseti)
  widget(el, ctx) { /* ... */ },  // opciono* - renderuje widget u el
  app(el, ctx) { /* ... */ },     // opciono* - renderuje punu app u el
});                               // * bar JEDNA od dvije forme mora postojati;
                                  //   sizes je obavezan samo uz widget formu
```

`widget()`/`app()` mogu vratiti **cleanup funkciju** (poziva se kad se element uklanja — očisti tajmere/listenere).

### ctx — šta alat dobija

```js
ctx.appId                 // sopstveni id
ctx.storage.get(key, fallback)   // podaci alata - namespaced, ulaze u
ctx.storage.set(key, value)      // backup/export i server sync automatski;
ctx.storage.remove(key)          // alat NIKAD ne dira localStorage direktno
ctx.openApp()             // otvori sopstvenu punu aplikaciju kao tab
ctx.openApp('drugi-id')   // ili tuđu
ctx.toast('Poruka')       // dashboard toast
```

**Limit: 200KB po alatu.** `ctx.storage` živi u localStorage (~5MB ukupno za CIJELI dashboard) i u serverskom sidecar fajlu (1MB cap za sve zajedno) — zato `set()` odbija upis koji bi alat odveo preko 200KB, uz vidljiv toast i `console.warn` (`set`/`remove` vraćaju `false` kad upis ne prođe). Za velike podatke (slike, video, fajlovi) alat treba raditi sa fajl sistemom kroz svoj server endpoint ili download/upload — `ctx.storage` je za podešavanja i mali radni sadržaj.

### Stilovi alata

Alat nosi svoj CSS sam — injektuje `<style id="<app-id>-styles">` jednom iz svog `app.js` (jednom na vrhu funkcije koja ga registruje, sa provjerom `if (!document.getElementById(...))` da se ne duplira na drugi render). Sve klase prefiksuj po alatu (npr. `vk-` za video-kompresor). Boje uvijek preko dashboard varijabli (`var(--accent)`, `var(--border)`, `var(--text)`...) — tako alat automatski prati svih 6 tema + custom temu.

### Komunikacija među alatima (event bus)

Jedan widget može uživo prikazivati ono što drugi objavi:

```js
// alat A (emiter) - ime događaja UVIJEK počinje sopstvenim id-om:
ctx.emit('moj-alat:changed', { count: 5 });

// alat B (slušalac) - ctx.on vraća unsubscribe funkciju;
// pozovi je u cleanup-u da widget ne sluša i poslije uklanjanja:
widget(el, ctx) {
  const stop = ctx.on('moj-alat:changed', data => { el.textContent = data.count; });
  return stop;
}
```

Greška u tuđem listeneru se guta uz `console.warn` — pokvaren slušalac ne obara emitera. Bus je in-memory (ne preživljava reload); trajno stanje ide u `ctx.storage`, bus služi za živo obavještavanje.

### Pravila kojih se svaki alat drži

1. **Bez eksternih zavisnosti** (CDN skripte, fontovi) — alat mora raditi offline i pod file://.
2. **Server je opcion.** Ako alat treba server endpoint (npr. ffmpeg), mora imati jasno degradirano ponašanje bez servera (poruka, ne rušenje). Ako alat zavisi od EKSTERNOG programa na korisnikovoj mašini (ffmpeg, neki drugi CLI alat) koji server samo pretpostavlja da postoji, ne čekaj da korisnik to sazna tek kad mu prvi pokušaj padne poslije cijelog uploada/posla — dodaj server endpoint koji provjerava dostupnost (npr. `shutil.which(...)`) i pozovi ga ČIM se `widget()`/`app()` učita, prije bilo koje korisnikove akcije, sa jasnom porukom + tačnom instalacionom komandom za OS na kom server radi (vidi `apps/video-kompresor/app.js` `vkCheckFfmpegStatus()` + `handle_video_status` u `server.py` kao referentni obrazac). Ako alat treba server dio uopšte (bilo koja nova ruta/handler u `server.py`, ne samo ova provjera), dodaj i `apps/<id>/SERVER-SETUP.md` po istom obrascu — standardni instalacioni prompt niže kopira samo `app.js` + jednu script liniju, pa ništa što zahtijeva izmjenu u `server.py` neće raditi bez eksplicitnog uputstva agentu koji instalira.
3. **Nikad ne diraj tuđe podatke** — samo `ctx.storage`, nikad direktni `localStorage` ključevi.
4. **Greška alata ne smije srušiti dashboard** — host ionako hvata izuzetke iz `widget()`/`app()` i prikaže poruku unutar kartice/taba, ali alat treba i sam biti defanzivan.
5. **Prefiksuj SVE svoje identifikatore po alatu** — CSS klase (`qn-...`), DOM id-jeve ako ih uopšte koristiš (bolje `el.querySelector` po klasi nego `getElementById`), i imena bus događaja (`<app-id>:<naziv>`). Dva alata bez prefiksa mogu tiho pokvariti jedan drugog.
6. **Renderuj fluidno** — widget dobija kontejner sa sopstvenim scrollom, pa loša veličina najgore znači scrollbar; ali alat treba da koristi fleksibilan CSS (flex/grid, %, minmax) da lijepo radi u svakoj veličini koju korisnik razvuče.
7. **Tekst/ikonice unutar widgeta skaliraj prema STVARNOJ veličini sekcije, ne prema jednoj testiranoj veličini.** "Poveži alat..." (vidi "Kako korisnik koristi alat" ispod) prikači widget na POSTOJEĆU sekciju bilo koje veličine koju je korisnik već ručno namjestio — ne mora odgovarati nijednoj `s`/`m`/`l` vrijednosti iz manifesta. Fiksni `px` font/ikonica koji izgleda dobro na `s` (8×6) ostaje sitan i izgubljen u velikoj sekciji, ili prelije malu. Umjesto fiksnih `px` vrijednosti, koristi CSS container query jedinice: postavi `container-type:size` na korijenski element widgeta, pa `font-size`/`width`/`height` u `cqh`/`cqw` (ili `min(Xcqh,Ycqw)` za kontrolu po oba pravca) obavezno unutar `clamp(min, ..., max)` da se ne izgubi na ekstremnim omjerima. Primjer (skraćeno, cijeli obrazac u `apps/vremenska-prognoza/app.js` ako je instaliran preko epizode 1):
   ```css
   .moj-widget { container-type:size; }
   .moj-widget .broj { font-size:clamp(18px, min(20cqh,15cqw), 88px); }
   .moj-widget .ikonica { width:clamp(20px, min(22cqh,16cqw), 96px); }
   ```
   Prije nego prijaviš alat gotovim, testiraj vizuelno na bar dvije različite veličine sekcije (npr. default `s` i `l` preset iz menija sekcije), ne samo onu na kojoj si prvo probao.

## Šta se dešava kad je manifest pokvaren

`registerApp` validira sve. Nevalidan manifest (nedostaje polje, loš id, nevaljane veličine...) se **odbija uz `console.warn`** i završi u `AIZdravo.rejected` — alat se ne pojavi u katalogu, a **ostatak dashboarda radi normalno**. Loše zalijepljen alat nikad ne ruši postojeći dashboard. Isto važi za grešku u toku rada: widget/tab tog alata pokaže "Alat je javio grešku", sve ostalo netaknuto.

Widget sekcija čiji alat više nije prisutan (obrisana script linija) prikazuje "Alat nije dostupan" — **podaci sekcije i alata se NE brišu**, ponovna instalacija sve vraća.

## Uklanjanje alata

1. **Katalog (dugme "Alati" dole desno) → hover na alat → × → potvrdi** — TRAJNO briše `apps/<app-id>/` folder sa diska, uklanja script liniju iz `index.html`, i odjavljuje alat iz živog registra istog trena (bez reloada). Nije reverzibilno kroz UI — jedini povratak je ponovna instalacija (isti alat opet u `apps/`).
2. **Fizičko uklanjanje** — isti efekat ručno: obriši `apps/<app-id>/` folder i njegovu script liniju iz `index.html`.

Widget instance ostavljene na boardu poslije brisanja prikazuju "Alat nije dostupan" (vidi gore) dok se alat eventualno ne instalira ponovo.

## Instalacioni prompt (kopiraj u opis videa)

Šablon koji gledalac zalijepi u Claude Code / Codex otvoren u svom dashboard folderu. Zamijeni `<APP-ID>` i `<LINK-DO-FAJLA>`:

```
U ovom folderu je AI Zdravo Dashboard. Instaliraj alat "<APP-ID>":

1. Napravi folder apps/<APP-ID>/ i u njega sačuvaj fajl app.js sa
   ovog linka: <LINK-DO-FAJLA>
   (ili: kod alata je zalijepljen ispod ove poruke - sačuvaj ga kao
   apps/<APP-ID>/app.js)
2. U index.html, unutar bloka "APLIKACIJE (alati)", dodaj liniju:
   <script src="apps/<APP-ID>/app.js?v=1"></script>
3. Ne diraj ništa drugo. Pravila i kontrakt su u APPS_AND_WIDGETS.md.
4. Osvježi dashboard u browseru i potvrdi da se alat vidi u katalogu
   (dugme dole desno -> Alati).
```

Za alat koji se distribuira kao čist kod (bez linka), Ognjen u objavu stavi kod + isti prompt sa opcijom iz zagrade.

## Prompt za AŽURIRANJE postojećeg alata

Kad kasnija epizoda donese novu verziju alata iz ranije epizode (podigni `version` u manifestu!), gledalac zalijepi ovo:

```
U ovom folderu je AI Zdravo Dashboard. Ažuriraj alat "<APP-ID>" na novu
verziju:

1. Zamijeni SAV sadržaj fajla apps/<APP-ID>/app.js novom verzijom sa
   ovog linka: <LINK-DO-FAJLA>
   (ili: nova verzija koda je zalijepljena ispod ove poruke)
2. U index.html, u script liniji tog alata, podigni ?v= broj za jedan
   (npr. ?v=1 -> ?v=2) da browser ne kešira staru verziju.
3. Ne diraj ništa drugo - podaci alata (ctx.storage) ostaju i važe za
   novu verziju.
4. Osvježi dashboard i potvrdi da katalog (dugme dole desno -> Alati)
   prikazuje novu verziju alata.
```

Podaci alata prežive ažuriranje automatski (žive pod `aizdravo:app:<id>`, ne u fajlu alata). Ako nova verzija mijenja FORMAT svojih podataka, alat sam u `widget()`/`app()` migrira staro→novo pri prvom čitanju — dashboard se u to ne miješa.

## Kako korisnik koristi alat

- **+ dugme (dole desno) → Alati** — otvara katalog sa pretragom, default prikaz "Aplikacije". "Aplikacije" prikaz otvara alat kao tab; "Widgeti" prikaz dodaje widget na trenutno aktivan tab (izbor veličine ako alat nudi više).
- **Nova sekcija → tip "Folder"** — sekcija sa quick-launch pločicama izabranih aplikacija; lista se kasnije mijenja kroz meni sekcije ("Aplikacije foldera").
- **Nova sekcija → tip "Prazna (custom)"** — imenovana prazna sekcija BEZ veze sa registrom, za sadržaj koji korisnik gradi direktno kroz Claude/Codex.
- **Prazna sekcija → njen meni (•••) → "Poveži alat..."** — pretvara TU POSTOJEĆU sekciju u izabrani alat NA LICU MJESTA: ista pozicija, ista veličina (koju je korisnik već ručno podesio) - umjesto dodavanja nove, odvojene kartice iz kataloga na alat-ov default preset. Ovo je standardni put za instalaciju alata iz epizode: prvo instalacioni prompt (ispod) u folderu dashboarda doda alat u apps/ + registruje ga u index.html, alat se odmah pojavi u katalogu, pa se veže na već pripremljenu/imenovanu/podešenu sekciju kroz ovu opciju. Dostupno samo za "Prazna (custom)" sekcije koje još nisu povezane ni sa jednim alatom.
- **Katalog → hover na alat → ×** — trajno brisanje (vidi "Uklanjanje alata" iznad).

## Referentni primjer

Dashboard kreće prazan — nema instaliranog alata na disku da posluži kao živ šablon. Manifest primjer iznad ("Manifest (registerApp)") je namjerno potpun i samodovoljan: pokriva obje forme, `ctx` API, event bus i pravila stilova — dovoljan je kao polazna tačka za nov alat bez potrebe da se gleda tuđi kod. Prvi alat koji se instalira (bilo koji, prompt ili gotov folder) postaje živ primjer za sve sljedeće.
