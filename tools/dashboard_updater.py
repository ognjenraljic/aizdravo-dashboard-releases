#!/usr/bin/env python3
"""Deterministička mehanika core update-a za AI Zdravo Dashboard.

Radi TAČNO ono što .claude/skills/update-dashboard/SKILL.md Korak 2-6
opisuje proznim uputstvom - ali kao pravi kod, ne kao tekst koji AI agent
mora svaki put ponovo protumačiti. Skill i dalje odlučuje KADA se ovo
pokreće i objašnjava korisniku šta se dešava; ovaj fajl radi mehaniku:
backup, merge index.html APLIKACIJE bloka, detekcija server.py
customizacije, atomska primjena. Nikad ne dira dashboard-state.json,
apps/, .aizdravo-welcomed, dashboard.pid, dashboard-autostart.log,
errors.jsonl.
"""

import argparse
import ast
import hashlib
import json
import shutil
import sys
import time
import urllib.request
from pathlib import Path

CORE_FILES = [
    'index.html', 'app.js', 'apps-core.js', 'style.css', 'server.py',
    'APPS_AND_WIDGETS.md', 'CLAUDE.md', 'AGENTS.md', 'README.md', 'VERSION',
    'vendor/sortable.min.js',
    'assets/logo.png',
    'start-mac.command', 'start-windows.bat', 'stop-mac.command', 'stop-windows.bat',
    'install-autostart-mac.command', 'install-autostart-windows.bat',
    'uninstall-autostart-mac.command', 'uninstall-autostart-windows.bat',
    '.claude/skills/install-app/SKILL.md',
    '.claude/skills/update-dashboard/SKILL.md',
    'tools/dashboard_updater.py',
]

# Nikad ne ulaze u CORE_FILES - ovdje samo radi dokumentacije/testova,
# da svaka buduća izmjena CORE_FILES-a mora eksplicitno proći pored ovog seta.
NEVER_TOUCH = {
    'dashboard-state.json', 'apps',
    '.aizdravo-welcomed', 'dashboard.pid',
    'dashboard-autostart.log', 'errors.jsonl',
}

# Kratke, stabilne podniske - otporne na promjenu broja "=" znakova ili
# preformulisan tekst komentara, dok god ove dvije fraze ostanu u njemu.
# STAR marker je VIŠELINIJSKI komentar (vidi index.html ~780-785) koji se
# zatvara sopstvenim "-->" prije nego što instalirani-alati sadržaj počne.
APLIKACIJE_START = 'APLIKACIJE (alati)'
APLIKACIJE_END = 'KRAJ APLIKACIJA'


class UpdateError(Exception):
    pass


def sha256_of(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify_manifest(staging_dir, manifest):
    for rel, expected_hash in manifest.items():
        f = staging_dir / rel
        if not f.exists():
            raise UpdateError(f'nedostaje fajl u staging-u: {rel}')
        actual = sha256_of(f)
        if actual != expected_hash:
            raise UpdateError(
                f'hash ne odgovara za {rel}: očekivano {expected_hash}, dobijeno {actual}'
            )


def _content_bounds(html_text, label):
    """Vrati (content_start, content_end) - raspon TEKSTA IZMEĐU START
    komentara (koji se zatvara sopstvenim '-->') i END markera, gdje žive
    instaliranih-alata <script> linije. Radi bez obzira na broj "="
    znakova ili preformulisan tekst unutar komentara."""
    start_pos = html_text.find(APLIKACIJE_START)
    end_pos = html_text.find(APLIKACIJE_END)
    if start_pos == -1 or end_pos == -1:
        raise UpdateError(f'APLIKACIJE markeri nisu nađeni u {label} index.html')

    comment_close = html_text.find('-->', start_pos)
    if comment_close == -1 or comment_close > end_pos:
        raise UpdateError(f'START komentar nije ispravno zatvoren u {label} index.html')
    content_start = html_text.find('\n', comment_close) + 1

    end_line_start = html_text.rfind('\n', 0, end_pos) + 1
    return content_start, end_line_start


def merge_index_html(old_html_text, new_html_text):
    """Vrati sadržaj novog (staged) index.html sa STARIM APLIKACIJE
    sadržajem (instaliranih alata <script> linije) ubačenim umjesto
    novog - to su korisnikove instalacije, ne core sadržaj koji se
    prepisuje pri update-u."""
    old_start, old_end = _content_bounds(old_html_text, 'starog (trenutnog)')
    old_block = old_html_text[old_start:old_end]

    new_start, new_end = _content_bounds(new_html_text, 'novog (staged)')
    return new_html_text[:new_start] + old_block + new_html_text[new_end:]


def _handler_method_names(source_text):
    """Imena svih metoda unutar `class Handler` - koristi se za
    prepoznavanje customizacije (npr. alat koji je preko install-app
    skilla dodao sopstveni handle_ endpoint u server.py)."""
    tree = ast.parse(source_text)
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef) and node.name == 'Handler':
            for item in node.body:
                if isinstance(item, ast.FunctionDef):
                    names.add(item.name)
    return names


def detect_server_customization(old_server_text, new_server_text):
    """Vrati set imena metoda koje postoje u STAROM server.py a NE u
    novom (staged) core server.py."""
    return _handler_method_names(old_server_text) - _handler_method_names(new_server_text)


def backup_folder(current_dir):
    ts = time.strftime('%Y-%m-%d-%H%M')
    backup_dir = current_dir.parent / f'{current_dir.name}-backup-{ts}'
    if backup_dir.exists():
        # dvije primjene u istom minutu (npr. test suite) - dodaj sufiks
        n = 2
        while (current_dir.parent / f'{current_dir.name}-backup-{ts}-{n}').exists():
            n += 1
        backup_dir = current_dir.parent / f'{current_dir.name}-backup-{ts}-{n}'
    shutil.copytree(current_dir, backup_dir)
    return backup_dir


def fetch_remote_staging(base_url, staging_dir):
    """Skida MANIFEST.json + svaki core fajl sa raw GitHub URL-a u
    staging_dir. Vraća učitan manifest (dict) za Korak 3 hash provjeru."""
    staging_dir.mkdir(parents=True, exist_ok=True)
    manifest_url = base_url.rstrip('/') + '/MANIFEST.json'
    with urllib.request.urlopen(manifest_url, timeout=10) as resp:
        manifest = json.loads(resp.read().decode('utf-8'))
    for rel in manifest:
        dest = staging_dir / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        url = base_url.rstrip('/') + '/' + rel
        with urllib.request.urlopen(url, timeout=10) as resp:
            dest.write_bytes(resp.read())
    return manifest


def apply_update(current_dir, staging_dir, manifest=None, auto_merge_server=False):
    """Primijeni core update iz staging_dir na current_dir. Ako je
    `manifest` dat, provjerava SHA-256 svakog fajla PRIJE bilo čega.
    Nikad ne dira NEVER_TOUCH putanje. index.html se uvijek spaja
    (Korak 4), server.py se preskače ako ima customizaciju i
    auto_merge_server nije eksplicitno True.

    Vraća izvještaj dict: backup_dir, applied_files,
    server_customization_detected, server_update_skipped.
    """
    current_dir = Path(current_dir)
    staging_dir = Path(staging_dir)

    if manifest is not None:
        verify_manifest(staging_dir, manifest)

    old_index = (current_dir / 'index.html').read_text(encoding='utf-8')
    new_index = (staging_dir / 'index.html').read_text(encoding='utf-8')
    merged_index = merge_index_html(old_index, new_index)

    server_customizations = set()
    skip_server = False
    old_server_path = current_dir / 'server.py'
    new_server_path = staging_dir / 'server.py'
    if old_server_path.exists() and new_server_path.exists():
        server_customizations = detect_server_customization(
            old_server_path.read_text(encoding='utf-8'),
            new_server_path.read_text(encoding='utf-8'),
        )
        if server_customizations and not auto_merge_server:
            skip_server = True

    backup_dir = backup_folder(current_dir)

    applied = []
    for rel in CORE_FILES:
        src = staging_dir / rel
        if not src.exists():
            continue
        if rel == 'index.html':
            (current_dir / rel).write_text(merged_index, encoding='utf-8')
            applied.append(rel)
            continue
        if rel == 'server.py' and skip_server:
            continue
        dest = current_dir / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dest)
        applied.append(rel)

    return {
        'backup_dir': str(backup_dir),
        'applied_files': applied,
        'server_customization_detected': sorted(server_customizations),
        'server_update_skipped': skip_server,
    }


def main():
    parser = argparse.ArgumentParser(description='AI Zdravo Dashboard - core update mehanika')
    parser.add_argument('current_dir', help='folder dashboarda koji se ažurira')
    parser.add_argument('--source-url', help='raw GitHub base URL (npr. https://raw.githubusercontent.com/.../main)')
    parser.add_argument('--source-dir', help='lokalni folder sa novom verzijom core-a (umjesto --source-url, za test/offline upotrebu)')
    parser.add_argument('--auto-merge-server', action='store_true', help='primijeni server.py i ako ima customizaciju (default: preskoči i prijavi)')
    args = parser.parse_args()

    current_dir = Path(args.current_dir)

    if args.source_dir:
        staging_dir = Path(args.source_dir)
        manifest_path = staging_dir / 'MANIFEST.json'
        manifest = json.loads(manifest_path.read_text(encoding='utf-8')) if manifest_path.exists() else None
    elif args.source_url:
        staging_parent = current_dir.parent / '.aizdravo-update-staging'
        if staging_parent.exists():
            shutil.rmtree(staging_parent)
        manifest = fetch_remote_staging(args.source_url, staging_parent)
        staging_dir = staging_parent
    else:
        print('Treba --source-url ili --source-dir.', file=sys.stderr)
        sys.exit(1)

    try:
        report = apply_update(current_dir, staging_dir, manifest=manifest, auto_merge_server=args.auto_merge_server)
    except UpdateError as exc:
        print(f'Update prekinut: {exc}', file=sys.stderr)
        sys.exit(1)

    print(json.dumps(report, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
