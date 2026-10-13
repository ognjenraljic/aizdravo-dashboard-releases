#!/bin/bash
# Dvoklik pokretač za Mac - ne treba Terminal ni komande.
# Prvi put macOS može tražiti potvrdu (desni klik -> Otvori) jer je
# skripta preuzeta sa interneta, ovo je normalno za sve ovakve fajlove.
#
# 24.7.2026 - server se sad pokreće DETACHED (nohup + disown): zatvaranje
# ovog prozora više ne gasi dashboard. Prije ovog fixa je server bio u
# foreground-u, pa je zatvoren Terminal prozor = ugašen server = sledeći
# put "Safari ne može da se poveže na server" bez ijednog jasnog razloga.
cd "$(dirname "$0")"
if ! command -v python3 >/dev/null 2>&1; then
  echo ""
  echo "Python 3 nije pronađen. Instaliraj ga (python.org ili 'xcode-select --install') pa probaj ponovo."
  echo ""
  [ -t 0 ] && read -p "Pritisni Enter da zatvoriš ovaj prozor..."
  exit 1
fi
nohup python3 server.py > /dev/null 2>&1 &
disown
echo ""
# 1.7.1 - ispiši STVARNU adresu (port nije uvijek 8100: ako je zauzet,
# server pređe na sljedeći). AI asistent čita ovu liniju.
if URL="$(python3 tools/dashboard_url.py --wait 8)"; then
  echo "AI Zdravo Dashboard -> $URL"
  echo "AI Zdravo Dashboard je pokrenut u pozadini."
  echo "Možeš slobodno zatvoriti ovaj prozor - dashboard ostaje živ."
  echo "Da ga zaustaviš, dvaput klikni na stop-mac.command."
else
  echo "Dashboard se nije pokrenuo. Pokreni 'python3 server.py' u ovom folderu da vidiš poruku o grešci."
fi
echo ""
# Interaktivno (dvoklik) čeka Enter; kad skriptu pokreće AI asistent, ne čeka.
if [ -t 0 ]; then
  read -p "Pritisni Enter da zatvoriš ovaj prozor..."
fi
exit 0
