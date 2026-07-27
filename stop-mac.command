#!/bin/bash
# Zaustavlja AI Zdravo Dashboard pokrenut preko start-mac.command.
cd "$(dirname "$0")"
python3 server.py --stop
echo ""
read -p "Pritisni Enter da zatvoriš ovaj prozor..."
