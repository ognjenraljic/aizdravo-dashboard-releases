#!/usr/bin/env python3
"""Ispiše stvarnu adresu OVOG dashboard foldera (npr. http://localhost:8101).

Port nije uvijek 8100: ako je zauzet (drugi dashboard folder, druga
aplikacija), server sam pređe na sljedeći slobodan. Ova skripta nađe server
baš ovog foldera (pid fajl + /api/instance, upoređuje putanju foldera), pa
je koriste start skripte i AI asistent umjesto pogađanja porta.

    python3 tools/dashboard_url.py            # odmah; exit 1 ako ne radi
    python3 tools/dashboard_url.py --wait 8   # čekaj do 8 s da se digne
"""
import argparse
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DEFAULT_PORT = 8100
MAX_PORT_ATTEMPTS = 10


def _instance(port):
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/instance', timeout=0.5) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            return data if isinstance(data, dict) else None
    except Exception:
        return None


def _candidate_ports():
    ports = []
    try:
        data = json.loads((BASE_DIR / 'dashboard.pid').read_text(encoding='utf-8'))
        if isinstance(data, dict) and data.get('port'):
            ports.append(int(data['port']))
    except (OSError, ValueError, TypeError):
        pass
    ports += [p for p in range(DEFAULT_PORT, DEFAULT_PORT + MAX_PORT_ATTEMPTS) if p not in ports]
    return ports


def find_url():
    mine = os.path.realpath(str(BASE_DIR))
    for port in _candidate_ports():
        info = _instance(port)
        if info and os.path.realpath(str(info.get('base_dir', ''))) == mine:
            return f'http://localhost:{port}'
    return None


def main():
    parser = argparse.ArgumentParser(description='Adresa ovog AI Zdravo Dashboard foldera')
    parser.add_argument('--wait', type=float, default=0, help='sekundi čekanja da se server digne')
    args = parser.parse_args()
    deadline = time.time() + max(0.0, args.wait)
    while True:
        url = find_url()
        if url:
            print(url)
            return 0
        if time.time() >= deadline:
            print('Dashboard ovog foldera trenutno ne radi.', file=sys.stderr)
            return 1
        time.sleep(0.3)


if __name__ == '__main__':
    sys.exit(main())
