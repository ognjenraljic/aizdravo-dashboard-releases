#!/usr/bin/env python3
"""AI Zdravo katalog alata (v1.7.0, 13.10.2026; v1.7.4 ugrađena baza).

Spaja AI Zdravo platformu (aizdravo.com, AI Sistem resursi) sa ovim
dashboardom: katalog alata koji se mogu instalirati jednim klikom iz
panela Katalog -> "AI Zdravo".

Podjela posla:
- AI asistent (Claude Code / Codex) preko AI Zdravo MCP-a nađe resurse sa
  platforme i preda ih ovoj skripti (skill `.claude/skills/katalog/`).
  Dashboard sam ne priča sa MCP-om - MCP prijava (OAuth) je vezana za AI
  klijenta, ne za lokalni server.
- Ugrađena baza (tools/katalog_baza.json, v1.7.4): alati sa platforme čiji
  je zip već provjeren (SHA-256). Katalog ih prikazuje odmah, i prije prvog
  osvježavanja preko AI-a; zip se skida tek pri instalaciji.
- `sync` skida i pregleda samo NOVE resurse koji u opisu imaju red
  "Kompatibilno sa: AI Zdravo Dashboard" (MARKER_RE), i poznate alate iz
  baze kad dobiju novi zip (novi link = nova verzija). Keš je po download
  linku, pa se ništa ne skida dvaput.
- Zip se uvijek provjeri: u katalog ide samo folder sa app.js koji poziva
  registerApp() (odatle i id, verzija, forma). Označen resurs čiji zip
  nije alat = greška u izvještaju, ne ulazi u katalog.
  `--provjeri-sve` pregleda i neoznačene alate i pluginove.
- `install` (poziva ga server.py) raspakuje alat iz provjerenog zipa
  (SHA-256 iz sync-a) u apps/<id>/. Postojeća verzija ide u
  _apps_archive/, nikad se ne briše.

Samo standardna biblioteka. CLI:
  python3 tools/katalog.py sync --input kandidati.json [--full]
  python3 tools/katalog.py list
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
import time
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

BASE_DIR = Path(__file__).resolve().parent.parent
KATALOG_DIR_NAME = '.katalog'
KATALOG_FILE_NAME = 'katalog.json'

# Zipovi se skidaju SAMO iz AI Zdravo skladišta fajlova. Link stiže od AI
# asistenta (koji ga je dobio od MCP-a), pa je ovo zadnja odbrana da
# katalog nikad ne skine i ne instalira kod sa proizvoljne adrese.
ALLOWED_DOWNLOAD_HOSTS = {'ujtzjpgmjauwmlmcqikk.supabase.co'}
ALLOWED_DOWNLOAD_PREFIX = '/storage/v1/object/public/ai-sistem-files/'
PAGE_URL_PREFIX = 'https://www.aizdravo.com/'

MAX_ZIP_BYTES = 80 * 1024 * 1024
MAX_UNPACKED_BYTES = 300 * 1024 * 1024
MAX_ENTRIES = 10000
MAX_FILE_BYTES = 50 * 1024 * 1024  # isto kao APP_INSTALL_MAX_FILE_BYTES u server.py
DOWNLOAD_TIMEOUT = 60

# Oznaka u opisu resursa na platformi (autorova odluka 13.10.2026): nov
# alat za dashboard u opisu ima red "Kompatibilno sa: AI Zdravo Dashboard".
# Samo takvi novi resursi se skidaju; alati objavljeni prije oznake su u
# ugrađenoj bazi (BAZA_PATH). Zip se i dalje provjerava.
MARKER_RE = re.compile(r'kompatibilno\s+sa\s*:?\s*ai\s+zdravo\s+dashboard', re.I)
MARKER_TEXT = 'Kompatibilno sa: AI Zdravo Dashboard'

# Neoznačeni resursi ovih vrsta nikad nisu alati za dashboard, pa se njihov
# zip ne skida ni uz --provjeri-sve.
NON_TOOL_SUBTYPES = {'skill', 'prompt', 'workflow'}

APP_ID_RE = re.compile(r'^[a-z0-9]+(-[a-z0-9]+)*$')
RESOURCE_ID_RE = re.compile(r'^resource:[A-Za-z0-9_-]{1,80}$')
SKIP_PARTS = {'__MACOSX', '.DS_Store'}


class KatalogError(Exception):
    pass


def now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def katalog_dir(base_dir=BASE_DIR):
    return Path(base_dir) / KATALOG_DIR_NAME


def katalog_path(base_dir=BASE_DIR):
    return katalog_dir(base_dir) / KATALOG_FILE_NAME


def cache_dir(base_dir=BASE_DIR):
    return katalog_dir(base_dir) / 'cache'


# Ugrađena baza poznatih alata (ide uz dashboard, osvježava se updateom).
BAZA_PATH = Path(__file__).resolve().with_name('katalog_baza.json')


def load_baza():
    """{resource_id: zapis} iz ugrađene baze. Zapis bez ispravnog id-a,
    linka sa AI Zdravo skladišta, SHA-256 ili alata se preskače."""
    try:
        data = json.loads(BAZA_PATH.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}, None
    if not isinstance(data, dict):
        return {}, None
    out = {}
    for r in data.get('resources', []):
        if not isinstance(r, dict) or not RESOURCE_ID_RE.match(str(r.get('resource_id', ''))):
            continue
        try:
            check_download_url(r.get('download_url'))
        except KatalogError:
            continue
        tools = [t for t in r.get('tools') or [] if isinstance(t, dict) and APP_ID_RE.match(str(t.get('id', '')))]
        if not tools or not re.fullmatch(r'[0-9a-f]{64}', str(r.get('sha256', ''))):
            continue
        rec = dict(r)
        rec.update({'status': 'dashboard', 'tools': tools, 'baza': True})
        out[rec['resource_id']] = rec
    return out, data.get('built_at')


def load_katalog(base_dir=BASE_DIR):
    """Katalog iz .katalog/katalog.json; dok ga AI još nije osvježio,
    ugrađena baza (source 'baza'), da se poznati alati vide odmah."""
    path = katalog_path(base_dir)
    if not path.exists():
        baza, built_at = load_baza()
        if not baza:
            return None
        resources = sorted(baza.values(), key=lambda r: r.get('published_at', ''), reverse=True)
        return {'version': 1, 'source': 'baza', 'synced_at': built_at,
                'resources': resources, 'tools': build_tools(resources)}
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def save_katalog(data, base_dir=BASE_DIR):
    path = katalog_path(base_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix('.json.tmp')
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    tmp.replace(path)


# ---------------- Download ----------------

def check_download_url(url):
    if not isinstance(url, str):
        raise KatalogError('link za preuzimanje nedostaje')
    parts = urlsplit(url)
    if parts.scheme != 'https' or parts.hostname not in ALLOWED_DOWNLOAD_HOSTS:
        raise KatalogError(f'link nije sa AI Zdravo skladišta: {url}')
    if not parts.path.startswith(ALLOWED_DOWNLOAD_PREFIX) or '..' in parts.path:
        raise KatalogError(f'link nije u AI Sistem folderu: {url}')
    if not parts.path.endswith('.zip'):
        raise KatalogError('resurs nije zip')
    return url


def cache_name(url):
    return hashlib.sha256(url.encode('utf-8')).hexdigest()[:24] + '.zip'


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


DOWNLOAD_ATTEMPTS = 3


def download_zip(url, dest):
    """Skini u tmp pa atomski preimenuj - prekinut download nikad ne ostavi
    pola zipa pod pravim imenom u kešu. Skraćen prenos (manje bajtova od
    Content-Length ili neispravan zip) pokušava se ponovo, do DOWNLOAD_ATTEMPTS."""
    check_download_url(url)
    dest.parent.mkdir(parents=True, exist_ok=True)
    last = None
    for attempt in range(DOWNLOAD_ATTEMPTS):
        try:
            _download_once(url, dest)
            return dest
        except KatalogError as exc:
            if not getattr(exc, 'retry', False):
                raise
            last = exc
            if attempt + 1 < DOWNLOAD_ATTEMPTS:
                time.sleep(0.5 * (attempt + 1))
    raise KatalogError(f'preuzimanje nije uspjelo ni iz {DOWNLOAD_ATTEMPTS}. pokušaja: {last}')


def _retryable(msg):
    exc = KatalogError(msg)
    exc.retry = True
    return exc


def _download_once(url, dest):
    req = urllib.request.Request(url, headers={'User-Agent': 'AIZdravoDashboard-Katalog/1'})
    tmp = dest.with_suffix('.part')
    total = 0
    try:
        with urllib.request.urlopen(req, timeout=DOWNLOAD_TIMEOUT) as resp:
            # Preusmjerenje van dozvoljenog hosta se ne prati tiho.
            check_download_url(resp.geturl())
            expected = resp.headers.get('Content-Length')
            with open(tmp, 'wb') as out:
                while True:
                    chunk = resp.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > MAX_ZIP_BYTES:
                        raise KatalogError('zip je veći od dozvoljenog')
                    out.write(chunk)
        if expected and expected.isdigit() and total != int(expected):
            raise _retryable(f'skraćen prenos ({total} od {expected} bajtova)')
        if not zipfile.is_zipfile(tmp):
            raise _retryable('preuzet fajl nije ispravan zip')
        tmp.replace(dest)
    except KatalogError:
        tmp.unlink(missing_ok=True)
        raise
    except Exception as exc:
        tmp.unlink(missing_ok=True)
        raise _retryable(f'preuzimanje nije uspjelo: {exc}') from exc


# ---------------- Pregled zipa ----------------

def _clean_entries(zf):
    """Sigurnosni pregled SVIH stavki prije bilo kakvog raspakivanja:
    apsolutne putanje, '..', simlinkovi, broj i veličina fajlova."""
    infos = zf.infolist()
    if len(infos) > MAX_ENTRIES:
        raise KatalogError('zip ima previše fajlova')
    total = 0
    clean = []
    for info in infos:
        name = info.filename.replace('\\', '/')
        parts = [p for p in name.split('/') if p]
        if name.startswith('/') or re.match(r'^[A-Za-z]:', name) or '..' in parts:
            raise KatalogError(f'nebezbjedna putanja u zipu: {info.filename}')
        mode = (info.external_attr >> 16) & 0o170000
        if mode == 0o120000:
            raise KatalogError(f'zip sadrži simlink: {info.filename}')
        if info.file_size > MAX_FILE_BYTES:
            raise KatalogError(f'fajl je prevelik: {info.filename}')
        total += info.file_size
        if total > MAX_UNPACKED_BYTES:
            raise KatalogError('raspakovan zip bi bio prevelik')
        if any(p in SKIP_PARTS for p in parts) or info.is_dir() or not parts:
            continue
        clean.append((info, '/'.join(parts)))
    return clean


def _manifest_from_source(source):
    """Čita registerApp({...}) manifest regexom, od SAMOG poziva
    registerApp naprijed (ne prvo pojavljivanje 'id:' u fajlu - alat koji
    prije manifesta ima npr. { id: 'klasik' } bi inače dobio pogrešan id).
    Forme (widget/app) se traže samo na nivou uvlačenja manifest polja."""
    pos = source.find('registerApp(')
    if pos == -1:
        return None
    block = source[pos:pos + 40000]

    def field(name, limit):
        # Polje na početku reda (uobičajen višeredni manifest) ili iza { / ,
        # (manifest u jednom redu). Navodnik sa escape-om (\') je dio teksta.
        pattern = (r'(^[ \t]*|[{,][ \t]*)' + name +
                   r"\s*:\s*(['\"])((?:\\.|(?!\2)[^\\\n]){0," + str(limit) + r"})\2")
        m = re.search(pattern, block, re.M)
        if not m:
            return None, None
        value = re.sub(r'\\(.)', r'\1', m.group(3))
        indent = m.group(1) if not m.group(1).lstrip().startswith(('{', ',')) else None
        return value, indent

    app_id, indent = field('id', 80)
    if not app_id or not APP_ID_RE.match(app_id):
        return None
    name, _ = field('name', 60)
    version, _ = field('version', 20)
    description, _ = field('description', 400)
    icon, _ = field('icon', 40)

    def has_form(form):
        if indent is not None:
            # Višeredni manifest: forma samo na nivou uvlačenja manifest polja
            # (ne neka istoimena funkcija dublje u kodu).
            return re.search(r'^' + re.escape(indent) + form + r'\s*(\(|:)', block, re.M) is not None
        # Manifest u jednom redu: forma u istom redu kao id.
        line_end = block.find('\n', block.find('registerApp('))
        first_line = block[:line_end if line_end != -1 else len(block)]
        return re.search(r'[{,]\s*' + form + r'\s*(\(|:)', first_line) is not None

    return {
        'id': app_id,
        'name': (name or app_id)[:60],
        'version': (version or '0.0.0')[:20],
        'description': (description or '')[:400],
        'icon': icon if icon and APP_ID_RE.match(icon) else '',
        'widget': has_form('widget'),
        'app': has_form('app'),
    }


def inspect_zip(path):
    """Vrati listu alata za dashboard u zipu (prazna = nije dashboard alat).
    Alat = folder (ili korijen zipa) sa app.js koji poziva registerApp().
    Cio dashboard (app.js + server.py + index.html zajedno) nije alat."""
    try:
        zf = zipfile.ZipFile(path)
    except zipfile.BadZipFile as exc:
        raise KatalogError('fajl nije ispravan zip') from exc
    with zf:
        entries = _clean_entries(zf)
        names = {n for _, n in entries}
        by_name = {n: info for info, n in entries}
        tools = []
        roots = []
        for n in sorted(names, key=lambda x: (x.count('/'), x)):
            if not (n == 'app.js' or n.endswith('/app.js')):
                continue
            prefix = n[:-len('app.js')]
            if prefix.count('/') > 2:
                continue
            if any(prefix.startswith(r) for r in roots):
                continue  # app.js unutar već nađenog alata
            if prefix + 'server.py' in names and prefix + 'index.html' in names:
                continue  # cio dashboard, ne alat
            source = zf.read(by_name[n]).decode('utf-8', 'replace')
            manifest = _manifest_from_source(source)
            if not manifest:
                continue
            files = [x for x in names if x.startswith(prefix)]
            manifest.update({
                'folder': prefix,
                'files': len(files),
                'bytes': sum(by_name[x].file_size for x in files),
                'server': (prefix + 'server_ext.py') in names,
            })
            roots.append(prefix)
            tools.append(manifest)
        return tools


# ---------------- Sync ----------------

def normalize_candidate(raw):
    """Prima ili sirov MCP `fetch` rezultat ili već sveden zapis."""
    if not isinstance(raw, dict):
        raise KatalogError('kandidat nije objekat')
    meta = raw.get('metadata') if isinstance(raw.get('metadata'), dict) else {}
    download = meta.get('download') if isinstance(meta.get('download'), dict) else {}
    rid = raw.get('resource_id') or raw.get('id')
    if not isinstance(rid, str) or not RESOURCE_ID_RE.match(rid):
        raise KatalogError(f'nevažeći id resursa: {rid!r}')
    page = raw.get('page_url') or raw.get('url') or ''
    if not isinstance(page, str) or not page.startswith(PAGE_URL_PREFIX):
        page = ''
    title = raw.get('title') if isinstance(raw.get('title'), str) else rid
    locked = bool(raw.get('locked', meta.get('locked', False)))
    text = raw.get('text') if isinstance(raw.get('text'), str) else ''
    return {
        'marked': bool(MARKER_RE.search(text)),
        'resource_id': rid,
        'title': title[:120],
        'page_url': page,
        'subtype': str(raw.get('subtype') or meta.get('subtype') or '')[:40],
        'access_level': str(raw.get('access_level') or meta.get('access_level') or '')[:20],
        'locked': locked,
        'published_at': str(raw.get('published_at') or '')[:40],
        'download_url': raw.get('download_url') or download.get('url') or '',
        'size': raw.get('bytes') or download.get('bytes') or 0,
    }


def _version_key(v):
    nums = [int(x) for x in re.findall(r'\d+', v or '')[:4]]
    return nums + [0] * (4 - len(nums))


def build_tools(resources):
    """Ravna lista alata za UI. Isti alat (isti id) objavljen više puta
    (npr. Video kompresor 1.0.0 i 1.1.0 kao dva resursa) se prikazuje
    jednom - najnovija verzija, pa najnoviji datum objave."""
    best = {}
    for res in resources:
        if res.get('status') != 'dashboard':
            continue
        for tool in res.get('tools', []):
            entry = dict(tool)
            entry.update({
                'resource_id': res['resource_id'],
                'resource_title': res.get('title', ''),
                'page_url': res.get('page_url', ''),
                'published_at': res.get('published_at', ''),
                'access_level': res.get('access_level', ''),
            })
            key = (_version_key(entry['version']), entry['published_at'])
            cur = best.get(entry['id'])
            if cur is None or key > (_version_key(cur['version']), cur['published_at']):
                best[entry['id']] = entry
    return sorted(best.values(), key=lambda t: t['published_at'], reverse=True)


def sync(candidates, base_dir=BASE_DIR, full=False, check_unmarked=False, log=print):
    """Skida samo nove označene resurse i poznate alate (baza) sa novim
    zipom. check_unmarked=True pregleda i neoznačene alate i pluginove."""
    base_dir = Path(base_dir)
    baza, _ = load_baza()
    old = load_katalog(base_dir) or {}
    old_by_id = {r['resource_id']: r for r in old.get('resources', []) if isinstance(r, dict) and 'resource_id' in r}
    cdir = cache_dir(base_dir)
    cdir.mkdir(parents=True, exist_ok=True)

    result = dict(old_by_id) if not full else {}
    if not full:
        # Poznati alati ostaju u katalogu i kad ih AI ovaj put nije predao.
        for rid, rec in baza.items():
            if result.get(rid, {}).get('status') != 'dashboard':
                result[rid] = dict(rec)
    summary = {'novo': [], 'promijenjeno': [], 'nije_dashboard': 0, 'zakljucano': 0,
               'bez_oznake': [], 'alat_bez_oznake': [], 'greske': []}
    seen = set()

    for raw in candidates:
        try:
            cand = normalize_candidate(raw)
        except KatalogError as exc:
            summary['greske'].append(str(exc))
            continue
        rid = cand['resource_id']
        if rid in seen:
            continue
        seen.add(rid)
        prev = old_by_id.get(rid)
        record = dict(cand)

        if cand['locked'] or not cand['download_url']:
            record.update({'status': 'zakljucano' if cand['locked'] else 'bez-fajla', 'tools': []})
            if cand['locked']:
                summary['zakljucano'] += 1
            result[rid] = record
            continue

        known = baza.get(rid)
        if known and known['download_url'] == cand['download_url']:
            # Poznat alat, isti zip: podaci iz baze, bez preuzimanja.
            record.update({k: known[k] for k in ('status', 'tools', 'sha256')})
            record['baza'] = True
            result[rid] = record
            continue
        prev_tool = bool(prev and prev.get('status') == 'dashboard'
                         and prev.get('download_url') == cand['download_url'])
        if (not cand['marked'] and not known and not prev_tool
                and (not check_unmarked or cand['subtype'].lower() in NON_TOOL_SUBTYPES)):
            # Nov resurs bez oznake: ne skida se ništa.
            record.update({'status': 'bez-oznake', 'tools': []})
            summary['bez_oznake'].append(cand['title'])
            result[rid] = record
            continue

        try:
            check_download_url(cand['download_url'])
        except KatalogError as exc:
            record.update({'status': 'greska', 'error': str(exc), 'tools': []})
            summary['greske'].append(f"{cand['title']}: {exc}")
            result[rid] = record
            continue

        zip_path = cdir / cache_name(cand['download_url'])
        same_file = prev and prev.get('download_url') == cand['download_url'] and prev.get('sha256')
        # Diferencijalno: isti link = isti fajl (platforma pravi novi link
        # za svaki upload), pa se ne skida ni ne pregleda ponovo.
        reusable = prev.get('status') in ('dashboard', 'nije-dashboard') if prev else False
        if same_file and reusable and (prev.get('status') != 'dashboard' or zip_path.exists()):
            record.update({k: prev[k] for k in ('status', 'tools', 'sha256') if k in prev})
            if record.get('status') == 'nije-dashboard' and cand['marked']:
                record.update({'status': 'greska', 'error': 'označen kao alat za dashboard, a zip nema app.js sa registerApp()'})
                summary['greske'].append(f"{cand['title']}: {record['error']}")
            elif record.get('status') == 'nije-dashboard':
                summary['nije_dashboard'] += 1
            elif not cand['marked'] and not known:
                summary['alat_bez_oznake'].append(cand['title'])
            result[rid] = record
            continue

        try:
            log(f'  preuzimam: {cand["title"]}')
            download_zip(cand['download_url'], zip_path)
            digest = sha256_file(zip_path)
            tools = inspect_zip(zip_path)
        except KatalogError as exc:
            zip_path.unlink(missing_ok=True)
            summary['greske'].append(f"{cand['title']}: {exc}")
            # Nova verzija poznatog alata nije stigla: ostaje stara, provjerena.
            fallback = known or (prev if prev and prev.get('status') == 'dashboard' else None)
            if fallback:
                result[rid] = dict(fallback)
                continue
            record.update({'status': 'greska', 'error': str(exc), 'tools': []})
            result[rid] = record
            continue

        record['sha256'] = digest
        record['tools'] = tools
        if tools:
            record['status'] = 'dashboard'
            (summary['promijenjeno'] if prev else summary['novo']).append(
                ', '.join(f"{t['name']} v{t['version']}" for t in tools))
            if not cand['marked'] and not known:
                summary['alat_bez_oznake'].append(cand['title'])
        else:
            zip_path.unlink(missing_ok=True)  # čuvamo samo zipove alata
            if cand['marked'] or known:
                record.update({'status': 'greska', 'error': 'označen kao alat za dashboard, a zip nema app.js sa registerApp()'})
                summary['greske'].append(f"{cand['title']}: {record['error']}")
            else:
                record['status'] = 'nije-dashboard'
                summary['nije_dashboard'] += 1
        result[rid] = record

    # Keš čuva samo zipove koje katalog stvarno koristi.
    keep = {cache_name(r['download_url']) for r in result.values() if r.get('status') == 'dashboard' and r.get('download_url')}
    for f in cdir.glob('*.zip'):
        if f.name not in keep:
            f.unlink(missing_ok=True)

    resources = sorted(result.values(), key=lambda r: r.get('published_at', ''), reverse=True)
    data = {
        'version': 1,
        'source': 'aizdravo-mcp',
        'synced_at': now_iso(),
        'full_synced_at': now_iso() if full else old.get('full_synced_at') or (now_iso() if not old else None),
        'resources': resources,
        'tools': build_tools(resources),
    }
    save_katalog(data, base_dir)
    summary['alata_u_katalogu'] = len(data['tools'])
    return summary


# ---------------- Instalacija ----------------

def _is_user_secret(name):
    """.env, .env.local... (ne .env.example) - korisnikov ključ/podešavanje."""
    return name == '.env' or (name.startswith('.env.') and not name.endswith(('.example', '.sample', '.template')))


def carry_over_user_files(old_dir, new_dir):
    """Pri zamjeni verzije alata zadrži korisnikove podatke iz stare verzije:
    fajlove kojih nema u novom paketu (dodati paketi ikonica, podaci) i
    korisnikove .env fajlove (paket često nosi .env sa placeholderom koji
    bi inače pregazio pravi API ključ). Sve ostalo dolazi iz nove verzije.
    Vraća listu prenesenih relativnih putanja."""
    old_dir, new_dir = Path(old_dir), Path(new_dir)
    carried = []
    if not old_dir.is_dir():
        return carried
    for src in sorted(old_dir.rglob('*')):
        if src.is_symlink() or not src.is_file():
            continue
        rel = src.relative_to(old_dir)
        if '__pycache__' in rel.parts or rel.name == '.DS_Store':
            continue
        dst = new_dir / rel
        if dst.exists() and not _is_user_secret(rel.name):
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        carried.append(rel.as_posix())
    return carried

def find_tool(data, resource_id, tool_id):
    for res in (data or {}).get('resources', []):
        if res.get('resource_id') == resource_id and res.get('status') == 'dashboard':
            for tool in res.get('tools', []):
                if tool.get('id') == tool_id:
                    return res, tool
    return None, None


def install(resource_id, tool_id, base_dir=BASE_DIR):
    """Raspakuj jedan alat iz provjerenog zipa u apps/<id>/. Vraća
    (manifest alata, putanja arhive stare verzije ili None). Upis script
    linije u index.html radi server.py (isti kod kao "Učitaj alat")."""
    base_dir = Path(base_dir)
    if not isinstance(resource_id, str) or not RESOURCE_ID_RE.match(resource_id):
        raise KatalogError('nevažeći id resursa')
    if not isinstance(tool_id, str) or not APP_ID_RE.match(tool_id):
        raise KatalogError('nevažeći id alata')
    data = load_katalog(base_dir)
    res, tool = find_tool(data, resource_id, tool_id)
    if not tool:
        raise KatalogError('alat nije u katalogu - osvježi katalog')

    zip_path = cache_dir(base_dir) / cache_name(res['download_url'])
    if not zip_path.exists():
        download_zip(res['download_url'], zip_path)
    if sha256_file(zip_path) != res.get('sha256'):
        zip_path.unlink(missing_ok=True)
        raise KatalogError('zip se promijenio od zadnjeg osvježavanja kataloga - osvježi katalog')

    apps_root = (base_dir / 'apps').resolve()
    target = (apps_root / tool_id).resolve()
    if target.parent != apps_root:
        raise KatalogError('nevažeća putanja alata')

    prefix = tool['folder']
    staging_root = Path(tempfile.mkdtemp(prefix='staging-', dir=katalog_dir(base_dir)))
    try:
        staging = staging_root / tool_id
        staging.mkdir()
        with zipfile.ZipFile(zip_path) as zf:
            for info, name in _clean_entries(zf):
                if not name.startswith(prefix):
                    continue
                rel = name[len(prefix):]
                out = (staging / rel).resolve()
                out.relative_to(staging.resolve())  # ValueError = bijeg iz foldera
                out.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(info) as src, open(out, 'wb') as dst:
                    shutil.copyfileobj(src, dst)
        source = (staging / 'app.js').read_text(encoding='utf-8', errors='replace')
        manifest = _manifest_from_source(source)
        if not manifest or manifest['id'] != tool_id:
            raise KatalogError('app.js u zipu ne odgovara katalogu - osvježi katalog')

        archived = None
        if target.exists():
            carry_over_user_files(target, staging)
            archive_root = base_dir / '_apps_archive'
            archive_root.mkdir(exist_ok=True)
            archived = archive_root / f'{tool_id}_{time.strftime("%Y%m%d%H%M%S")}'
            # Jedan rename (isti disk): na Windowsu zaključan fajl tada
            # obori cijelu zamjenu umjesto da ostavi polu-obrisan alat.
            try:
                os.rename(str(target), str(archived))
            except OSError as exc:
                raise KatalogError('ne mogu zamijeniti alat - neki fajl u njemu je možda otvoren '
                                   f'(alat radi ili ga drži drugi program); zatvori ga pa probaj ponovo ({exc})') from exc
        os.rename(str(staging), str(target))
        return manifest, archived
    finally:
        shutil.rmtree(staging_root, ignore_errors=True)


# ---------------- CLI ----------------

def _cli():
    parser = argparse.ArgumentParser(description='AI Zdravo katalog alata za dashboard')
    sub = parser.add_subparsers(dest='cmd', required=True)
    p_sync = sub.add_parser('sync', help='osvježi katalog iz kandidata koje je AI asistent dobio preko MCP-a')
    p_sync.add_argument('--input', required=True, help='JSON lista resursa (MCP fetch rezultati); "-" = standardni ulaz')
    p_sync.add_argument('--full', action='store_true', help='pun prolaz: resursi kojih nema u ulazu se brišu iz kataloga')
    p_sync.add_argument('--provjeri-sve', action='store_true',
                        help=f'pregledaj i zipove alata i pluginova bez oznake "{MARKER_TEXT}" u opisu')
    # v1.7.3 je imao ovu opciju; sada je to podrazumijevano ponašanje.
    p_sync.add_argument('--samo-oznaceni', action='store_true', help=argparse.SUPPRESS)
    sub.add_parser('list', help='ispiši alate u katalogu')
    args = parser.parse_args()

    if args.cmd == 'sync':
        text = sys.stdin.read() if args.input == '-' else Path(args.input).read_text(encoding='utf-8')
        raw = json.loads(text)
        if isinstance(raw, dict):
            raw = raw.get('resources') or raw.get('results') or []
        summary = sync(raw, full=args.full, check_unmarked=args.provjeri_sve)
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 0
    data = load_katalog()
    if not data:
        print('Katalog još nije osvježen.')
        return 0
    if data.get('source') == 'baza':
        print(f"Ugrađena baza ({data.get('synced_at')}), još nije osvježeno preko AI-a.")
    else:
        print(f"Osvježen: {data.get('synced_at')}")
    for t in data.get('tools', []):
        forms = '+'.join(f for f in ('widget', 'app') if t.get(f)) or '?'
        print(f"- {t['name']} v{t['version']} ({forms}{', server' if t.get('server') else ''}) [{t['resource_id']}]")
    return 0


if __name__ == '__main__':
    # Windows pipe (AI asistent pokreće skriptu) je često cp1252 bez č/ć/đ.
    for _stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            _stream.reconfigure(encoding='utf-8', errors='replace')
        except (AttributeError, ValueError):
            pass
    sys.exit(_cli())
