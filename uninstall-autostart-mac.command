#!/bin/bash
# Uklanja auto-pokretanje instalirano preko install-autostart-mac.command.
PLIST_PATH="$HOME/Library/LaunchAgents/com.aizdravo.dashboard.plist"

if [ -f "$PLIST_PATH" ]; then
  launchctl bootout "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null || launchctl unload "$PLIST_PATH" 2>/dev/null
  rm -f "$PLIST_PATH"
  echo "Auto-pokretanje uklonjeno. Dashboard se više neće sam pokretati pri prijavi."
else
  echo "Auto-pokretanje nije bilo instalirano - nema šta da se ukloni."
fi

echo ""
read -p "Pritisni Enter da zatvoriš ovaj prozor..."
