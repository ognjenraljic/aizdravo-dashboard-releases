#!/bin/bash
# JEDNOKRATNO podešavanje (opciono): dashboard se poslije ovoga sam
# pokreće pri SVAKOJ prijavi na ovaj Mac, čak i poslije restarta računara
# - ne treba više nikad ručno dvoklikati start-mac.command. Bezbjedno je
# pokrenuti ovo više puta (prepisuje isti LaunchAgent).
cd "$(dirname "$0")"
BASE_DIR="$(pwd)"

# 24.7.2026 - macOS TCC ("Fajlovi i folderi" privatnost) blokira procese
# pokrenute preko launchd (auto-start bez GUI konteksta) da čitaju fajlove
# unutar Desktop/Documents/Downloads - otkriveno uživo (isti python3 koji
# savršeno radi iz Terminal-a je pukao sa "Operation not permitted" kad ga
# je launchd pokrenuo). Ne postoji način da skripta sama traži tu dozvolu
# (Apple to namjerno ne dozvoljava programski), pa se folder umjesto toga
# premjesti VAN tih foldera prije nego se auto-start uopšte postavi -
# potpuno zaobilazi problem, bez ijedne ručne dozvole u Sistemskim
# postavkama.
case "$BASE_DIR" in
  "$HOME/Desktop"|"$HOME/Desktop"/*|"$HOME/Documents"|"$HOME/Documents"/*|"$HOME/Downloads"|"$HOME/Downloads"/*)
    echo "Dashboard je trenutno u $BASE_DIR"
    echo "macOS ne dozvoljava auto-pokretanju da čita fajlove unutar Desktop/Documents/Downloads."
    echo "Da bi auto-start radio, folder treba biti premješten van tih foldera (npr. ~/aizdravo)."
    echo ""
    read -p "Premjestiti folder na ~/aizdravo sad? (y/n): " ANSWER
    if [ "$ANSWER" != "y" ] && [ "$ANSWER" != "Y" ]; then
      echo "U redu - auto-start otkazan. Premjesti folder ručno pa ponovo pokreni ovaj skript."
      read -p "Pritisni Enter da zatvoriš ovaj prozor..."
      exit 0
    fi
    TARGET="$HOME/aizdravo"
    SUFFIX=2
    while [ -e "$TARGET" ]; do
      TARGET="$HOME/aizdravo-$SUFFIX"
      SUFFIX=$((SUFFIX + 1))
    done
    mv "$BASE_DIR" "$TARGET"
    BASE_DIR="$TARGET"
    cd "$BASE_DIR"
    echo "Premješteno na $BASE_DIR - koristi OVU lokaciju ubuduće (stara je nestala odatle)."
    echo ""
    ;;
esac

PYTHON3="$(command -v python3)"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/com.aizdravo.dashboard.plist"

if [ -z "$PYTHON3" ]; then
  echo "Python 3 nije pronađen. Instaliraj ga sa python.org pa probaj ponovo."
  read -p "Pritisni Enter da zatvoriš ovaj prozor..."
  exit 1
fi

mkdir -p "$PLIST_DIR"

cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.aizdravo.dashboard</string>
    <key>ProgramArguments</key>
    <array>
        <string>$PYTHON3</string>
        <string>-u</string>
        <string>$BASE_DIR/server.py</string>
        <string>--no-browser</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$BASE_DIR/dashboard-autostart.log</string>
    <key>StandardErrorPath</key>
    <string>$BASE_DIR/dashboard-autostart.log</string>
</dict>
</plist>
EOF

# Aktiviraj odmah (ne treba čekati sljedeću prijavu) - noviji launchctl
# "bootstrap" prvo, "load" kao fallback za starije macOS verzije.
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null || launchctl load "$PLIST_PATH" 2>/dev/null

echo ""
echo "Gotovo! AI Zdravo Dashboard će se sad sam pokretati pri svakoj prijavi na ovaj Mac."
echo "Otvori http://localhost:8100 u browseru i sačuvaj ga u Bookmarks (Cmd+D) -"
echo "odsad samo klikni taj bookmark, dashboard je uvijek spreman."
echo ""
echo "Da ukloniš auto-pokretanje, dvaput klikni uninstall-autostart-mac.command"
echo "(nalazi se u $BASE_DIR ako je folder premješten)."
echo ""
read -p "Pritisni Enter da zatvoriš ovaj prozor..."
