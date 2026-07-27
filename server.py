#!/usr/bin/env python3
import argparse
import atexit
import http.server
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
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
# apps/video-kompresor - sirov video bajt-tok, ne JSON, pa sopstveni,
# mnogo veći cap (ne dijeli MAX_STATE_BYTES sa /api/state).
MAX_VIDEO_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024
# Trajno brisanje alata (27.7.2026, katalog "Ukloni trajno") - isti id
# oblik koji apps-core.js registerApp() zahtijeva, provjeren PRIJE
# ijednog file-system poziva da putanja ne može pobjeći iz apps/.
APP_ID_RE = re.compile(r'^[a-z0-9]+(-[a-z0-9]+)*$')


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
        if path == '/api/video-kompresor/compress':
            self.handle_video_compress()
            return
        if path == '/api/apps/delete':
            self.handle_delete_app()
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

    def handle_video_compress(self):
        """apps/video-kompresor - prima sirov video bajt-tok (NE
        multipart; ime fajla stiže kroz X-Filename header, tijelo
        zahtjeva je fajl 1:1), kompresuje preko ffmpeg-a i upisuje
        rezultat direktno u ~/Desktop korisnika. Prati
        APPS_AND_WIDGETS.md pravilo 2 (server je opcion, mora
        degradirati čisto - poruka, ne rušenje) za slučajeve bez
        ffmpeg-a ili sa prevelikim/praznim fajlom."""
        ffmpeg_path = shutil.which('ffmpeg')
        if not ffmpeg_path:
            self.send_json(503, {
                'ok': False,
                'error': 'ffmpeg_missing',
                'message': 'ffmpeg nije instaliran na ovoj mašini (npr. brew install ffmpeg).',
            })
            return

        length = int(self.headers.get('Content-Length', 0) or 0)
        if length <= 0:
            self.send_json(400, {'ok': False, 'error': 'empty_body', 'message': 'Prazan fajl.'})
            return
        if length > MAX_VIDEO_UPLOAD_BYTES:
            self.send_json(413, {
                'ok': False,
                'error': 'file_too_large',
                'message': f'Fajl je veći od {MAX_VIDEO_UPLOAD_BYTES // (1024 * 1024)}MB limita.',
            })
            return

        raw_name = self.headers.get('X-Filename', 'video')
        try:
            original_name = unquote(raw_name)
        except Exception:
            original_name = 'video'
        original_name = os.path.basename(original_name) or 'video'
        stem = Path(original_name).stem or 'video'
        suffix = Path(original_name).suffix or '.mp4'

        # Upload se piše na disk u komadima (ne u memoriju) - video
        # fajlovi lako pređu par stotina MB, isti princip kao
        # engineering-under-constraint pravilo (streamuj, ne drži sve
        # odjednom u RAM-u).
        tmp_input = Path(tempfile.gettempdir()) / f'aizdravo-vk-{os.getpid()}-{threading.get_ident()}{suffix}'
        written = 0
        try:
            with tmp_input.open('wb') as f:
                remaining = length
                while remaining > 0:
                    chunk = self.rfile.read(min(1024 * 1024, remaining))
                    if not chunk:
                        break
                    f.write(chunk)
                    written += len(chunk)
                    remaining -= len(chunk)
        except OSError as exc:
            tmp_input.unlink(missing_ok=True)
            self.send_json(500, {'ok': False, 'error': 'upload_failed', 'message': str(exc)})
            return

        if written != length:
            tmp_input.unlink(missing_ok=True)
            self.send_json(400, {'ok': False, 'error': 'incomplete_upload', 'message': 'Upload je prekinut.'})
            return

        desktop = Path.home() / 'Desktop'
        try:
            desktop.mkdir(parents=True, exist_ok=True)
        except OSError:
            pass

        # 27.7.2026 (Codex QA) - ffmpeg piše DIREKTNO u jedinstven privremen
        # fajl (isti pid+thread-id obrazac kao tmp_input), ne u konačno
        # Desktop ime. Stari kod je birao Desktop ime PRIJE kompresije
        # (check-then-use race - dva paralelna uploada istog imena mogu
        # izabrati isti slobodan naziv, pa jedan ffmpeg (-y) prepiše izlaz
        # drugog) i ostavljao polovičan fajl na Desktopu ako ffmpeg padne.
        # Sad se konačno ime bira i fajl premješta TEK poslije potvrđenog
        # uspjeha - preostali race prozor (provjera slobodnog imena do
        # rename-a) je trenutna operacija, ne višeminutna kompresija.
        tmp_output = Path(tempfile.gettempdir()) / f'aizdravo-vk-out-{os.getpid()}-{threading.get_ident()}.mp4'

        # preset veryfast/crf 26 - widget prioritizuje brzinu ("odmah
        # krene kompresovanje") nad maksimalnom uštedom; vidi
        # video-output-compression.md, konkretne vrijednosti smiju
        # varirati po alatu.
        cmd = [
            ffmpeg_path, '-y', '-nostdin', '-i', str(tmp_input),
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
            '-c:a', 'aac', '-b:a', '128k',
            '-movflags', '+faststart',
            str(tmp_output),
        ]
        result = None
        try:
            result = subprocess.run(cmd, capture_output=True, timeout=1800)
        except subprocess.TimeoutExpired:
            self.send_json(504, {'ok': False, 'error': 'timeout', 'message': 'Kompresija je predugo trajala.'})
            return
        finally:
            tmp_input.unlink(missing_ok=True)
            if result is None or result.returncode != 0:
                tmp_output.unlink(missing_ok=True)

        if result.returncode != 0 or not tmp_output.exists():
            detail = result.stderr.decode('utf-8', errors='ignore')[-400:] if result.stderr else ''
            tmp_output.unlink(missing_ok=True)
            self.send_json(500, {
                'ok': False,
                'error': 'ffmpeg_failed',
                'message': 'ffmpeg nije uspio da kompresuje fajl.',
                'detail': detail,
            })
            return

        output_name = f'{stem}-kompresovano.mp4'
        output_path = desktop / output_name
        counter = 2
        while output_path.exists():
            output_name = f'{stem}-kompresovano-{counter}.mp4'
            output_path = desktop / output_name
            counter += 1
        try:
            os.replace(tmp_output, output_path)
        except OSError as exc:
            tmp_output.unlink(missing_ok=True)
            self.send_json(500, {'ok': False, 'error': 'move_failed', 'message': str(exc)})
            return

        self.send_json(200, {
            'ok': True,
            'output_name': output_name,
            'input_size': written,
            'output_size': output_path.stat().st_size,
        })

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


def _cleanup_pidfile():
    try:
        PID_FILE.unlink()
    except OSError:
        pass


def _handle_sigterm(signum, frame):
    # Podrazumijevani SIGTERM handler NE poziva atexit/cleanup - registrujemo
    # svoj da --stop (koji šalje SIGTERM) ostavi čist pid fajl iza sebe.
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
        print('\nDashboard zaustavljen.')


if __name__ == '__main__':
    main()
