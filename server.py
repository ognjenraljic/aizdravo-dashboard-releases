#!/usr/bin/env python3
import argparse
import atexit
import http.server
import importlib.util
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import webbrowser
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote, urlsplit

DEFAULT_PORT = 8100
MAX_PORT_ATTEMPTS = 10
BASE_DIR = Path(__file__).parent
# 24.7.2026 - server se sad pokreće detached (vidi start-mac.command/
# start-windows.bat), pa mu treba način da se čisto zaustavi bez da se
# traži proces preko lsof/Task Manager-a. Pid fajl (gitignored, per-
# mašina) omogućava i --stop i (buduću) precizniju "već pokrenut" provjeru.
PID_FILE = BASE_DIR / 'dashboard.pid'
# Build-time-only error log (21.7.2026) - client-side catcher in
# index.html POSTs here best-effort, appends one JSON object per line.
# Not part of the shipped dashboard's actual functionality - a dev-time
# safety net to catch runtime errors while building, before this gets
# handed to other people to download. Gitignored, lives only in this repo.
ERROR_LOG = BASE_DIR / 'errors.jsonl'
STATE_FILE = BASE_DIR / 'dashboard-state.json'
STATE_TMP_FILE = BASE_DIR / 'dashboard-state.json.tmp'
STATE_LOCK = threading.Lock()
MAX_STATE_BYTES = 1024 * 1024
MAX_ERROR_LOG_BYTES = 256 * 1024
MAX_ERROR_LINES = 200
# Trajno brisanje alata (27.7.2026, katalog "Ukloni trajno") - isti id
# oblik koji apps-core.js registerApp() zahtijeva, provjeren PRIJE
# ijednog file-system poziva da putanja ne može pobjeći iz apps/.
APP_ID_RE = re.compile(r'^[a-z0-9]+(-[a-z0-9]+)*$')
# "Učitaj alat" (30.7.2026) - server-side cap po fajlu (odbrana u dubinu,
# klijent već provjerava isto PRIJE upload-a).
APP_INSTALL_MAX_FILE_BYTES = 50 * 1024 * 1024


# --- Plugin sistem za server-zavisne alate (30.7.2026) ---
# Prije ovoga, svaki alat kome je trebao server dio (npr. ffmpeg) je
# zahtijevao RUČNO dodavanje ruta/metoda direktno u OVAJ fajl (SERVER-
# SETUP.md instrukcija za AI agenta koji instalira). Sad svaki takav alat
# nosi SOPSTVENI apps/<id>/server_ext.py sa ROUTES = {(method, path):
# 'ime_funkcije'} i funkcijama koje primaju `handler` (živu Handler
# instancu - send_json/read_json_body/rfile/headers su joj metode) kao
# jedini argument.
#
# Lijeno učitavanje (PO ZAHTJEVU, ne samo pri startu servera) je namjerno
# - ključno svojstvo: alat instaliran DOK je server već pokrenut (najčešći
# slučaj - dashboard je otvoren, korisnik prevuče nov folder) radi ODMAH,
# bez restarta. Keš prati mtime fajla, pa i ručna izmjena server_ext.py
# tokom razvoja radi bez restarta.
_PLUGIN_CACHE = {}
_PLUGIN_CACHE_LOCK = threading.Lock()
_PLUGIN_SHUTDOWN_HOOKS = []


def _windows_known_folder_desktop():
    """Pravi Windows Desktop preko SHGetKnownFolderPath(FOLDERID_Desktop) -
    čita STVARNU, registry-konfigurisanu lokaciju bez obzira na naziv/
    putanju (hvata poslovni OneDrive, ručno preusmjerenu lokaciju, drugi
    disk, lokalizovan naziv foldera). Vraća None na bilo kojoj grešci
    (uvijek ima heuristiku ispod kao fallback)."""
    try:
        import ctypes

        class GUID(ctypes.Structure):
            _fields_ = [
                ('Data1', ctypes.c_ulong), ('Data2', ctypes.c_ushort),
                ('Data3', ctypes.c_ushort), ('Data4', ctypes.c_ubyte * 8),
            ]

        FOLDERID_Desktop = GUID(
            0xB4BFCC3A, 0xDB2C, 0x424C,
            (ctypes.c_ubyte * 8)(0xB0, 0x29, 0x7F, 0xE9, 0x9A, 0x87, 0xC6, 0x41),
        )
        path_ptr = ctypes.c_wchar_p()
        hr = ctypes.windll.shell32.SHGetKnownFolderPath(
            ctypes.byref(FOLDERID_Desktop), 0, 0, ctypes.byref(path_ptr)
        )
        if hr == 0 and path_ptr.value:
            path = Path(path_ptr.value)
            ctypes.windll.ole32.CoTaskMemFree(path_ptr)
            return path
    except Exception:
        pass
    return None


def _resolve_desktop_dir():
    """Desktop folder rezolucija (dijeljena core-utility, ne alat-
    specifična). Na Windowsu prvo pokuša pravi Windows API, pa OneDrive
    heuristiku, pa običnu ~/Desktop. macOS/Linux nemaju ovaj problem."""
    home = Path.home()
    if sys.platform.startswith('win'):
        known = _windows_known_folder_desktop()
        if known and known.is_dir():
            return known
        onedrive_desktop = home / 'OneDrive' / 'Desktop'
        if onedrive_desktop.is_dir():
            return onedrive_desktop
    return home / 'Desktop'


def _safe_popen_kwargs():
    """Belt-and-suspenders kwargs za BILO KOJI dugotrajan/detached
    subprocess (ffmpeg i slično): (1) stdin=DEVNULL - kad je dashboard
    pokrenut detached, dijete bez ovoga može pokušati čitati naslijeđeni
    stdin i suspendovati se (SIGTTOU). (2) nova process grupa/sesija - da
    /cancel-stil rute mogu ubiti CIJELU grupu, ne samo glavni PID."""
    kwargs = {'stdin': subprocess.DEVNULL}
    if sys.platform.startswith('win'):
        kwargs['creationflags'] = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
    else:
        kwargs['start_new_session'] = True
    return kwargs


class PluginAPI:
    """Stabilan skup core utility-ja dostupnih svakom server_ext.py preko
    injektovanog `aizdravo` imena - namjerno malen i generički (Desktop
    rezolucija i sigurni subprocess kwargs su dovoljno česta potreba da ih
    svaki budući alat ponovo koristi umjesto da duplicira Windows/OneDrive
    detekciju)."""
    BASE_DIR = BASE_DIR
    APP_ID_RE = APP_ID_RE

    @staticmethod
    def resolve_desktop_dir():
        return _resolve_desktop_dir()

    @staticmethod
    def safe_popen_kwargs():
        return _safe_popen_kwargs()

    @staticmethod
    def register_shutdown_hook(fn):
        """server_ext.py pozove ovo JEDNOM, pri importu, ako drži
        pozadinske procese/niti koje treba pospremiti pri gašenju servera
        (isti princip kao stari _kill_all_video_jobs, sad generički)."""
        _PLUGIN_SHUTDOWN_HOOKS.append(fn)


def _run_plugin_shutdown_hooks():
    for fn in _PLUGIN_SHUTDOWN_HOOKS:
        try:
            fn()
        except Exception:
            pass


def _load_plugin(app_id):
    """Učitaj (ili vrati keširanu) apps/<app_id>/server_ext.py instancu.
    None ako fajl ne postoji ili ne uspije da se učita - loš/pokvaren
    plugin ne smije srušiti cijeli server, samo ta ruta ostaje 404."""
    apps_root = (BASE_DIR / 'apps').resolve()
    ext_path = (apps_root / app_id / 'server_ext.py').resolve()
    if ext_path.parent.parent != apps_root or not ext_path.is_file():
        return None
    try:
        mtime = ext_path.stat().st_mtime
    except OSError:
        return None
    with _PLUGIN_CACHE_LOCK:
        cached = _PLUGIN_CACHE.get(app_id)
        if cached and cached[0] == mtime:
            return cached[1]
    spec = importlib.util.spec_from_file_location(f'aizdravo_plugin_{app_id}', ext_path)
    module = importlib.util.module_from_spec(spec)
    module.aizdravo = PluginAPI
    try:
        spec.loader.exec_module(module)
    except Exception as exc:
        print(f'[plugin] apps/{app_id}/server_ext.py nije uspio da se učita: {exc}', file=sys.stderr)
        return None
    with _PLUGIN_CACHE_LOCK:
        _PLUGIN_CACHE[app_id] = (mtime, module)
    return module


def _dispatch_plugin_route(handler, method, path):
    """True ako je neki plugin obradio zahtjev (bez obzira na ishod) - u
    tom slučaju pozivalac ne radi svoj fallback (404/static fajl). False
    ako ruta ne pripada nijednom poznatom alatu."""
    parts = path.split('/', 3)
    if len(parts) < 3 or parts[0] != '' or parts[1] != 'api':
        return False
    app_id = parts[2]
    if not APP_ID_RE.match(app_id):
        return False
    module = _load_plugin(app_id)
    if module is None:
        return False
    routes = getattr(module, 'ROUTES', {})
    fn_name = routes.get((method, path))
    if not fn_name:
        return False
    fn = getattr(module, fn_name, None)
    if not callable(fn):
        return False
    try:
        fn(handler)
    except Exception as exc:
        try:
            handler.send_json(500, {'ok': False, 'error': 'plugin_error', 'message': str(exc)})
        except Exception:
            pass
    return True


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(BASE_DIR), **kwargs)

    def end_headers(self):
        # This is a live-build dashboard. Never let the browser keep an
        # older HTML/CSS/JS response while the files are changing.
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, *args):
        pass

    def _host_ok(self):
        # DNS-rebinding/CSRF zaštita (27.7.2026, Codex bezbjednosni audit) - server
        # sluša samo na 127.0.0.1, ali bilo koja stranica koju korisnik otvori u
        # ISTOM browseru može poslati fetch/XHR na http://localhost:8100/api/...
        # (npr. da obriše instaliran alat preko /api/apps/delete). Bez provjere
        # Host headera, taj zahtjev bi tiho prošao. Standardan _host_ok()
        # obrazac za lokalne HTTP servere koji izlažu destruktivne rute.
        host = (self.headers.get('Host') or '').split(':')[0].lower()
        return host in ('localhost', '127.0.0.1')

    def translate_path(self, path):
        # Path-traversal/symlink-escape zaštita (27.7.2026, Codex bezbjednosni
        # audit) - SimpleHTTPRequestHandler prati simlinkove bez provjere. Alat
        # čiji apps/<id>/ folder (ili fajl unutra) simlinkuje na nešto van ovog
        # dashboarda bi inače bio serviran preko HTTP-a. resolve() prati simlink
        # do STVARNE putanje; relative_to baca ValueError ako je van BASE_DIR.
        translated = super().translate_path(path)
        try:
            resolved = Path(translated).resolve()
            resolved.relative_to(BASE_DIR.resolve())
        except (ValueError, OSError):
            return str(BASE_DIR.resolve() / '__blocked_path__')
        return str(resolved)

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json_body(self, max_bytes=MAX_STATE_BYTES):
        length = int(self.headers.get('Content-Length', 0) or 0)
        if length < 0 or length > max_bytes:
            raise ValueError('payload_too_large')
        body = self.rfile.read(length) if length else b'{}'
        return json.loads(body)

    def clean_state_values(self, values):
        clean_values = {}
        for key, value in values.items():
            if not isinstance(key, str) or not key.startswith('aizdravo:'):
                continue
            if key == 'aizdravo:error-log' or not isinstance(value, str):
                continue
            clean_values[key] = value
        return clean_values

    def write_state_values(self, values):
        payload = {
            'version': 1,
            'updated_at': datetime.now(timezone.utc).isoformat(),
            'values': values,
        }
        serialized = json.dumps(payload, ensure_ascii=False, indent=2) + '\n'
        STATE_TMP_FILE.write_text(serialized, encoding='utf-8')
        STATE_TMP_FILE.replace(STATE_FILE)

    def do_GET(self):
        if not self._host_ok():
            self.send_json(403, {'error': 'nedozvoljen host'})
            return
        path = urlsplit(self.path).path
        if path == '/api/instance':
            # 28.7.2026 - koristi ga is_dashboard_already_running() da
            # razlikuje "ovaj isti folder je već pokrenut na ovom portu"
            # od "neki DRUGI dashboard folder slučajno sjedi na ovom
            # portu" - title-tag string je isti za sve foldere (svi se
            # zovu "AI Zdravo Dashboard"), pa sam po sebi ne dokazuje
            # da je riječ o istoj instanci.
            self.send_json(200, {'base_dir': str(BASE_DIR.resolve())})
            return
        if _dispatch_plugin_route(self, 'GET', path):
            return
        if path != '/api/state':
            return super().do_GET()

        if not STATE_FILE.exists():
            self.send_json(200, {'version': 1, 'exists': False, 'values': {}})
            return

        try:
            with STATE_LOCK:
                payload = json.loads(STATE_FILE.read_text(encoding='utf-8'))
            values = payload.get('values', {}) if isinstance(payload, dict) else {}
            if not isinstance(values, dict):
                raise ValueError('invalid_state_values')
            self.send_json(200, {
                'version': 1,
                'exists': True,
                'updated_at': payload.get('updated_at'),
                'values': values,
            })
        except Exception as exc:
            self.send_json(500, {'error': 'state_read_failed', 'detail': str(exc)})

    def do_PUT(self):
        if not self._host_ok():
            self.send_json(403, {'error': 'nedozvoljen host'})
            return
        if urlsplit(self.path).path != '/api/state':
            self.send_json(404, {'error': 'not_found'})
            return

        try:
            incoming = self.read_json_body()
            values = incoming.get('values') if isinstance(incoming, dict) else None
            if not isinstance(values, dict):
                raise ValueError('values_must_be_an_object')

            clean_values = self.clean_state_values(values)
            with STATE_LOCK:
                self.write_state_values(clean_values)
            self.send_json(200, {'ok': True, 'keys': len(clean_values)})
        except ValueError as exc:
            status = 413 if str(exc) == 'payload_too_large' else 400
            self.send_json(status, {'error': str(exc)})
        except Exception as exc:
            self.send_json(500, {'error': 'state_write_failed', 'detail': str(exc)})

    def do_PATCH(self):
        if not self._host_ok():
            self.send_json(403, {'error': 'nedozvoljen host'})
            return
        if urlsplit(self.path).path != '/api/state':
            self.send_json(404, {'error': 'not_found'})
            return

        try:
            incoming = self.read_json_body()
            changes = incoming.get('changes') if isinstance(incoming, dict) else None
            if not isinstance(changes, dict):
                raise ValueError('changes_must_be_an_object')

            with STATE_LOCK:
                if STATE_FILE.exists():
                    current = json.loads(STATE_FILE.read_text(encoding='utf-8'))
                    values = current.get('values', {}) if isinstance(current, dict) else {}
                    if not isinstance(values, dict):
                        values = {}
                else:
                    values = {}

                for key, value in changes.items():
                    if not isinstance(key, str) or not key.startswith('aizdravo:') or key == 'aizdravo:error-log':
                        continue
                    if value is None:
                        values.pop(key, None)
                    elif isinstance(value, str):
                        values[key] = value

                clean_values = self.clean_state_values(values)
                self.write_state_values(clean_values)

            self.send_json(200, {'ok': True, 'keys': len(clean_values), 'changed': len(changes)})
        except ValueError as exc:
            status = 413 if str(exc) == 'payload_too_large' else 400
            self.send_json(status, {'error': str(exc)})
        except Exception as exc:
            self.send_json(500, {'error': 'state_patch_failed', 'detail': str(exc)})

    def do_POST(self):
        if not self._host_ok():
            self.send_json(403, {'error': 'nedozvoljen host'})
            return
        path = urlsplit(self.path).path
        if path == '/api/log-error':
            self.handle_log_error()
            return
        if path == '/api/apps/delete':
            self.handle_delete_app()
            return
        if path == '/api/apps/install/begin':
            self.handle_install_begin()
            return
        if path == '/api/apps/install/file':
            self.handle_install_file()
            return
        if path == '/api/apps/install/finish':
            self.handle_install_finish()
            return
        if _dispatch_plugin_route(self, 'POST', path):
            return
        self.send_response(404)
        self.end_headers()

    def handle_log_error(self):
        try:
            # 64KB cap po zapisu (ne default 1MB) - uz 200-linija rotaciju
            # ispod, fajl je time tvrdo ogranicen na ~13MB u najgorem
            # slucaju umjesto 200MB.
            entry = self.read_json_body(max_bytes=64 * 1024)
        except Exception:
            entry = {'type': 'invalid_error_payload'}
        with ERROR_LOG.open('a', encoding='utf-8') as f:
            f.write(json.dumps(entry, ensure_ascii=False) + '\n')
        # Rotacija (23.7.2026): localStorage strana je oduvijek imala cap
        # od 200 zapisa, ali fajl na disku je rastao neograniceno - ista
        # klasa problema kao jul-2026 disk-space nalazi. Kad fajl predje
        # prag, zadrzi samo posljednjih MAX_ERROR_LINES redova (atomski,
        # preko tmp fajla, isti obrazac kao state upis).
        try:
            if ERROR_LOG.stat().st_size > MAX_ERROR_LOG_BYTES:
                lines = ERROR_LOG.read_text(encoding='utf-8').splitlines(keepends=True)
                tmp = ERROR_LOG.with_suffix('.jsonl.tmp')
                tmp.write_text(''.join(lines[-MAX_ERROR_LINES:]), encoding='utf-8')
                tmp.replace(ERROR_LOG)
        except OSError:
            pass  # rotacija je higijena - njen pad ne smije srusiti logovanje
        self.send_response(204)
        self.end_headers()

    def handle_delete_app(self):
        """Katalog "Ukloni trajno" (27.7.2026) - suprotno od stare 'Ukloni'
        akcije u Podešavanjima (koja je samo dodavala alat na
        disabled-apps listu, fajlovi i ctx.storage podaci su ostajali).
        Ovo STVARNO briše apps/<id>/ folder sa diska i njegovu script
        liniju iz index.html - namjerno nepovratno, korisnik je upozoren
        na klijentskoj strani prije poziva. id se validira PRIJE ijednog
        file-system poziva (isti obrazac kao apps-core.js registerApp())
        i putanja se provjerava da ostane direktno dijete apps/ - nikad
        ../ eskejp iz tog foldera."""
        try:
            payload = self.read_json_body(max_bytes=4096)
        except Exception:
            self.send_json(400, {'ok': False, 'error': 'bad_request'})
            return
        app_id = payload.get('id') if isinstance(payload, dict) else None
        if not isinstance(app_id, str) or not APP_ID_RE.match(app_id):
            self.send_json(400, {'ok': False, 'error': 'invalid_id', 'message': 'Nevažeći id alata.'})
            return

        apps_root = (BASE_DIR / 'apps').resolve()
        app_dir = (apps_root / app_id).resolve()
        if app_dir.parent != apps_root:
            self.send_json(400, {'ok': False, 'error': 'invalid_path', 'message': 'Nevažeća putanja.'})
            return
        if not app_dir.is_dir():
            self.send_json(404, {'ok': False, 'error': 'not_found', 'message': 'Folder alata ne postoji.'})
            return

        try:
            shutil.rmtree(app_dir)
        except OSError as exc:
            self.send_json(500, {'ok': False, 'error': 'delete_failed', 'message': str(exc)})
            return

        # Skini script liniju iz index.html - bez ovoga bi sljedeći load
        # tražio fajl koji više ne postoji (tih 404, ali i dalje smeće u
        # APLIKACIJE bloku). Best-effort: folder je već obrisan bez
        # obzira na ishod ovog koraka.
        script_warning = None
        try:
            index_path = BASE_DIR / 'index.html'
            content = index_path.read_text(encoding='utf-8')
            pattern = re.compile(
                r'[ \t]*<script src="apps/' + re.escape(app_id) + r'/app\.js(\?v=\d+)?"></script>\r?\n?'
            )
            new_content = pattern.sub('', content)
            if new_content != content:
                index_path.write_text(new_content, encoding='utf-8')
            else:
                script_warning = 'script_line_not_found'
        except OSError as exc:
            script_warning = str(exc)

        self.send_json(200, {'ok': True, 'warning': script_warning})

    def handle_install_begin(self):
        """"Učitaj alat" Korak 1 - napravi (ili očisti, ako je zamjena)
        apps/<id>/ folder prije upload-a pojedinačnih fajlova."""
        try:
            payload = self.read_json_body(max_bytes=4096)
        except Exception:
            self.send_json(400, {'ok': False, 'error': 'bad_request'})
            return
        app_id = payload.get('id') if isinstance(payload, dict) else None
        overwrite = bool(payload.get('overwrite')) if isinstance(payload, dict) else False
        if not isinstance(app_id, str) or not APP_ID_RE.match(app_id):
            self.send_json(400, {'ok': False, 'error': 'invalid_id', 'message': 'Nevažeći id alata.'})
            return

        apps_root = (BASE_DIR / 'apps').resolve()
        app_dir = (apps_root / app_id).resolve()
        if app_dir.parent != apps_root:
            self.send_json(400, {'ok': False, 'error': 'invalid_path', 'message': 'Nevažeća putanja.'})
            return

        if app_dir.exists():
            if not overwrite:
                self.send_json(409, {'ok': False, 'error': 'already_exists', 'message': 'Alat sa ovim id-om već postoji.'})
                return
            try:
                shutil.rmtree(app_dir)
            except OSError as exc:
                self.send_json(500, {'ok': False, 'error': 'cleanup_failed', 'message': str(exc)})
                return

        try:
            app_dir.mkdir(parents=True)
        except OSError as exc:
            self.send_json(500, {'ok': False, 'error': 'mkdir_failed', 'message': str(exc)})
            return

        self.send_json(200, {'ok': True})

    def handle_install_file(self):
        """"Učitaj alat" Korak 2 - upiši JEDAN fajl iz izabranog foldera.
        Poziva se jednom po fajlu (isti sirov upload obrazac kao video-
        kompresor: X-header + tijelo = fajl 1:1, ne multipart) - server.py
        ne treba multipart parser samo zbog ovoga."""
        app_id = self.headers.get('X-App-Id', '')
        if not APP_ID_RE.match(app_id):
            self.send_json(400, {'ok': False, 'error': 'invalid_id'})
            return
        apps_root = (BASE_DIR / 'apps').resolve()
        app_dir = (apps_root / app_id).resolve()
        if app_dir.parent != apps_root or not app_dir.is_dir():
            self.send_json(400, {'ok': False, 'error': 'not_begun', 'message': 'Pozovi /install/begin prvo.'})
            return

        raw_rel = self.headers.get('X-Relative-Path', '')
        try:
            rel_path = unquote(raw_rel)
        except Exception:
            rel_path = ''
        if not rel_path:
            self.send_json(400, {'ok': False, 'error': 'missing_path'})
            return
        target = (app_dir / rel_path).resolve()
        try:
            target.relative_to(app_dir)
        except ValueError:
            self.send_json(400, {'ok': False, 'error': 'invalid_path', 'message': 'Putanja bježi iz foldera alata.'})
            return

        length = int(self.headers.get('Content-Length', 0) or 0)
        if length < 0 or length > APP_INSTALL_MAX_FILE_BYTES:
            self.send_json(413, {'ok': False, 'error': 'file_too_large'})
            return

        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open('wb') as f:
                remaining = length
                while remaining > 0:
                    chunk = self.rfile.read(min(1024 * 1024, remaining))
                    if not chunk:
                        break
                    f.write(chunk)
                    remaining -= len(chunk)
        except OSError as exc:
            self.send_json(500, {'ok': False, 'error': 'write_failed', 'message': str(exc)})
            return

        self.send_json(200, {'ok': True})

    def handle_install_finish(self):
        """"Učitaj alat" Korak 3 - upiši (ili zamijeni) script liniju u
        index.html TEK poslije što su svi fajlovi uspješno stigli. Nikad
        ne prepisuje cijeli fajl, samo tu jednu liniju unutar APLIKACIJE
        bloka (isti princip kao update-dashboard-ov index.html merge)."""
        try:
            payload = self.read_json_body(max_bytes=4096)
        except Exception:
            self.send_json(400, {'ok': False, 'error': 'bad_request'})
            return
        app_id = payload.get('id') if isinstance(payload, dict) else None
        if not isinstance(app_id, str) or not APP_ID_RE.match(app_id):
            self.send_json(400, {'ok': False, 'error': 'invalid_id'})
            return

        apps_root = (BASE_DIR / 'apps').resolve()
        app_js = (apps_root / app_id / 'app.js').resolve()
        if app_js.parent.parent != apps_root or not app_js.is_file():
            self.send_json(400, {'ok': False, 'error': 'app_js_missing', 'message': 'app.js nije pronađen - upload nije završen.'})
            return

        script_version = int(time.time())
        try:
            index_path = BASE_DIR / 'index.html'
            content = index_path.read_text(encoding='utf-8')
            pattern = re.compile(
                r'[ \t]*<script src="apps/' + re.escape(app_id) + r'/app\.js(\?v=\d+)?"></script>\r?\n?'
            )
            content = pattern.sub('', content)
            marker = '<!-- =================== KRAJ APLIKACIJA ========================== -->'
            new_line = f'<script src="apps/{app_id}/app.js?v={script_version}"></script>\n'
            if marker not in content:
                self.send_json(500, {'ok': False, 'error': 'marker_missing', 'message': 'index.html nema APLIKACIJE blok marker.'})
                return
            content = content.replace(marker, new_line + marker, 1)
            index_path.write_text(content, encoding='utf-8')
        except OSError as exc:
            self.send_json(500, {'ok': False, 'error': 'index_write_failed', 'message': str(exc)})
            return

        self.send_json(200, {'ok': True, 'script_version': script_version})


def _cleanup_pidfile():
    try:
        PID_FILE.unlink()
    except OSError:
        pass


def _handle_sigterm(signum, frame):
    # Podrazumijevani SIGTERM handler NE poziva atexit/cleanup - registrujemo
    # svoj da --stop (koji šalje SIGTERM) ostavi čist pid fajl iza sebe.
    _run_plugin_shutdown_hooks()
    _cleanup_pidfile()
    sys.exit(0)


def stop_running():
    """--stop: zaustavlja server pokrenut ranije (npr. preko detached
    launchera) preko sačuvanog pid-a - ne treba lsof/Task Manager."""
    if not PID_FILE.exists():
        print('AI Zdravo Dashboard trenutno ne radi (nema pid fajla).')
        return
    try:
        pid = int(PID_FILE.read_text(encoding='utf-8').strip())
    except (OSError, ValueError):
        print('Pid fajl je nevažeći - brišem ga.')
        _cleanup_pidfile()
        return
    try:
        os.kill(pid, signal.SIGTERM)
        print(f'AI Zdravo Dashboard (pid {pid}) zaustavljen.')
    except ProcessLookupError:
        print('Proces više ne postoji - dashboard je već ugašen.')
    except PermissionError:
        print(f'Nemam dozvolu da zaustavim proces {pid}.')
    finally:
        _cleanup_pidfile()


def is_dashboard_already_running(port):
    """Provjerava da li je BAŠ OVAJ FOLDER (ne neki drugi dashboard folder,
    ni neka nepovezana app) već pokrenut na ovom portu. Prije 28.7.2026
    ovo je gledalo samo da li title-tag sadrži 'AI Zdravo Dashboard' -
    pošto svi dashboard folderi (lična kopija, dev, video serijal, itd.)
    dijele isti naslov, dvije RAZLIČITE instance na istom portu bi se
    lažno prepoznale kao 'ista', i druga bi tiho otvorila pogrešan folder
    u browseru umjesto da digne sopstveni server na sljedećem portu.
    Sad se poredi stvaran apsolutni BASE_DIR preko /api/instance rute."""
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/instance', timeout=0.5) as resp:
            data = json.loads(resp.read(2048).decode('utf-8', errors='ignore'))
        return data.get('base_dir') == str(BASE_DIR.resolve())
    except Exception:
        return False


def main():
    # 23.7.2026 - do ovog fixa je zauzet port značio SIROV Python
    # traceback (adresa je već u upotrebi) umjesto ijedne korisne poruke.
    # Za nekoga ko je dashboard skinuo i dvoklikom pokreće start skriptu,
    # to je tačno "ne mogu da se povežem na server" iskustvo bez ijednog
    # traga zašto - najčešći uzrok je stari server.py proces koji je
    # ostao pokrenut iz prošlog puta, ili dvostruki klik na launcher.
    parser = argparse.ArgumentParser(description='AI Zdravo Dashboard - lokalni server')
    parser.add_argument('--port', type=int, default=DEFAULT_PORT, help=f'početni port (default {DEFAULT_PORT})')
    parser.add_argument('--no-browser', action='store_true', help='ne otvaraj browser automatski (za automatizovano testiranje)')
    parser.add_argument('--stop', action='store_true', help='zaustavi dashboard pokrenut ranije (preko sačuvanog pid fajla)')
    args = parser.parse_args()

    if args.stop:
        stop_running()
        return

    server = None
    port = args.port
    for offset in range(MAX_PORT_ATTEMPTS):
        candidate = args.port + offset
        try:
            server = http.server.ThreadingHTTPServer(('127.0.0.1', candidate), Handler)
            port = candidate
            break
        except OSError:
            if is_dashboard_already_running(candidate):
                # Već pokrenut (npr. dupli klik na launcher) - ne diži
                # drugi proces preko istog foldera, samo otvori browser
                # na postojećem i izađi čisto.
                url = f'http://localhost:{candidate}'
                print(f'AI Zdravo Dashboard je već pokrenut -> {url}')
                if not args.no_browser:
                    webbrowser.open(url)
                return
            continue  # port zauzet nečim drugim - probaj sljedeći

    if server is None:
        last_port = args.port + MAX_PORT_ATTEMPTS - 1
        print(f'Nijedan port između {args.port} i {last_port} nije slobodan.')
        print(f'Zatvori druge programe koji ih koriste, ili pokreni: python3 server.py --port 9000')
        sys.exit(1)

    PID_FILE.write_text(str(os.getpid()), encoding='utf-8')
    atexit.register(_cleanup_pidfile)
    signal.signal(signal.SIGTERM, _handle_sigterm)

    url = f'http://localhost:{port}'
    if port != args.port:
        print(f'Port {args.port} je zauzet, prebacujem na {port}.')
    print(f'AI Zdravo Dashboard -> {url}')
    print(f'Da zaustaviš: python3 server.py --stop (ili dvoklik na stop-mac.command/stop-windows.bat)')
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        _run_plugin_shutdown_hooks()
        print('\nDashboard zaustavljen.')


if __name__ == '__main__':
    main()
