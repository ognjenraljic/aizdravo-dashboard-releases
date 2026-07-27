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
nohup python3 server.py > /dev/null 2>&1 &
disown
sleep 1
echo ""
echo "AI Zdravo Dashboard je pokrenut u pozadini."
echo "Možeš slobodno zatvoriti ovaj prozor - dashboard ostaje živ."
echo "Da ga zaustaviš, dvaput klikni na stop-mac.command."
echo ""
read -p "Pritisni Enter da zatvoriš ovaj prozor..."
