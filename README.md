# AI Zdravo Dashboard

Vaš lični, potpuno prilagodljiv operativni sistem — pokreće se lokalno na vašem računaru, bez naloga, bez clouda, bez pretplate.

## ⬇️ Preuzimanje

**[Preuzmi najnoviju verziju](https://github.com/ognjenraljic/aizdravo-dashboard-releases/releases/latest/download/ai-zdravo-dashboard.zip)** — uvijek vodi na najnoviji release, bez obzira kad gledate ovu stranicu.

Raspakujte zip, otvorite folder u Claude Desktop ili ChatGPT desktop aplikaciji i recite mu da pokrene dashboard.

## Šta je ovo

Dashboard je jedan običan folder (bez build koraka, bez npm-a) koji pokrećete lokalno preko Python-a. Radi u browseru, na `http://localhost:8100`. Svi vaši podaci (raspored, teme, instalirani alati) ostaju na vašem disku, u `dashboard-state.json`.

Dolazi potpuno prazan — vi ga gradite alat po alat, onako kako vama odgovara.

## Pokretanje

Otvorite ovaj folder u Claude Desktop (Code tab) ili ChatGPT desktop (Codex) aplikaciji i recite mu da pokrene dashboard — sam prepozna šta treba (provjerava Python, pokreće server, otvara browser). Detalji: `CLAUDE.md` / `AGENTS.md`.

Ako server treba ručno pokrenuti: dvoklik na `start-mac.command` (Mac) ili `start-windows.bat` (Windows). Zaustavljanje: `stop-mac.command` / `stop-windows.bat`.

## Dodavanje alata (aplikacija i widgeta)

Dva puta do novog alata u dashboardu:

1. **Prompt** — opišete Claude-u/Codex-u šta želite, on napiše kod i sam ga registruje.
2. **Gotov folder** — prevučete folder alata u `apps/`, kažete "učitaj ga", automatski se registruje.

Jedan te isti folder pokriva i "aplikaciju" i "widget" formu ako alat ima obje — nema odvojenih foldera po formi. Pun tehnički kontrakt (za autore alata): `APPS_AND_WIDGETS.md`.

## Prenos na drugi računar / backup

Cijeli dashboard je samo ovaj folder. Kopirate ga (USB, cloud, AirDrop) na drugi računar i pokrenete `start-mac.command`/`start-windows.bat` tamo — nosi sve: raspored, teme, instalirane alate.

## Ažuriranje

- **Dashboard core** (novi izgled/funkcije/ispravke) — recite Claude-u/Codex-u "provjeri ima li update za dashboard". Pravi se backup prije primjene, vaš raspored i instalirani alati se ne diraju.
- **Pojedinačni alat** — nova verzija alata se instalira isto kao i prvi put (prompt ili gotov folder za isti alat) — vaši podaci u tom alatu ostaju.
