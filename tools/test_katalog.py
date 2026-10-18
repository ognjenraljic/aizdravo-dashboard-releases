#!/usr/bin/env python3
"""Testovi za tools/katalog.py (AI Zdravo katalog, v1.7.0).

Bez mreže: preuzimanje se zamjenjuje kopiranjem lokalnog zipa, sve ostalo
(provjera linka, pregled zipa, keš, SHA-256, instalacija, arhiva) radi
pravi kod. Pokretanje: python3 -m unittest tools/test_katalog.py
"""
import json
import shutil
import stat
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import katalog  # noqa: E402

HOST = 'https://ujtzjpgmjauwmlmcqikk.supabase.co/storage/v1/object/public/ai-sistem-files/resources/'


def app_js(app_id, version='1.0.0', forms=('widget',)):
    form_lines = ''.join(f'  {f}(el, ctx) {{ el.textContent = "{app_id}"; }},\n' for f in forms)
    return (
        "const helper = { id: 'nije-ovo', name: 'Pogrešno' };\n"
        "AIZdravo.registerApp({\n"
        f"  id: '{app_id}',\n"
        f"  name: 'Alat {app_id}',\n"
        "  description: 'Test alat.',\n"
        "  icon: 'tool',\n"
        f"  version: '{version}',\n"
        f"{form_lines}"
        "});\n"
    )


def make_zip(path, files, symlinks=()):
    with zipfile.ZipFile(path, 'w') as zf:
        for name, data in files.items():
            zf.writestr(name, data)
        for name, target in symlinks:
            info = zipfile.ZipInfo(name)
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            zf.writestr(info, target)
    return path


class KatalogTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.base = self.tmp / 'dash'
        (self.base / 'apps').mkdir(parents=True)
        self.src = self.tmp / 'src'
        self.src.mkdir()
        self.local = {}  # url -> lokalni zip
        self._orig_download = katalog.download_zip

        def fake_download(url, dest):
            katalog.check_download_url(url)
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(self.local[url], dest)
            self.downloads.append(url)
            return dest

        self.downloads = []
        katalog.download_zip = fake_download

    def tearDown(self):
        katalog.download_zip = self._orig_download
        shutil.rmtree(self.tmp, ignore_errors=True)

    def resource(self, rid, zip_path, name=None, marked=True, subtype='alati'):
        url = HOST + (name or rid) + '.zip'
        self.local[url] = zip_path
        text = '# ' + rid + '\n\nOpis alata.\n'
        if marked:
            text = 'Kompatibilno sa: AI Zdravo Dashboard\n\n' + text
        return {
            'id': 'resource:' + rid, 'title': rid, 'url': 'https://www.aizdravo.com/ai-sistem/alati/' + rid,
            'published_at': '2026-10-01T10:00:00Z', 'text': text,
            'metadata': {'subtype': subtype, 'download': {'url': url}},
        }

    def test_bez_oznake_se_ipak_pregleda(self):
        # Od v1.7.3: alat bez oznake u opisu ulazi u katalog (odlučuje zip),
        # izvještaj samo javi da mu fali oznaka.
        alat = make_zip(self.src / 'a.zip', {'qr/app.js': app_js('qr')})
        summary = katalog.sync([self.resource('a', alat, marked=False)], self.base)
        self.assertEqual(summary['alat_bez_oznake'], ['a'])
        self.assertEqual([t['id'] for t in katalog.load_katalog(self.base)['tools']], ['qr'])

    def test_samo_oznaceni_ne_skida_neoznacene(self):
        alat = make_zip(self.src / 'a.zip', {'qr/app.js': app_js('qr')})
        summary = katalog.sync([self.resource('a', alat, marked=False)], self.base, check_unmarked=False)
        self.assertEqual(self.downloads, [])
        self.assertEqual(summary['bez_oznake'], ['a'])
        self.assertEqual(katalog.load_katalog(self.base)['tools'], [])

    def test_neoznacen_skill_se_ne_skida(self):
        skill = make_zip(self.src / 's.zip', {'moj-skill/SKILL.md': '# skill'})
        summary = katalog.sync([self.resource('s', skill, marked=False, subtype='skill')], self.base)
        self.assertEqual(self.downloads, [])
        self.assertEqual(summary['greske'], [])
        self.assertEqual(katalog.load_katalog(self.base)['tools'], [])

    def test_oznacen_a_nije_alat_je_greska(self):
        skill = make_zip(self.src / 's.zip', {'moj-skill/SKILL.md': '# skill'})
        summary = katalog.sync([self.resource('s', skill)], self.base)
        self.assertEqual(len(summary['greske']), 1)
        self.assertEqual(katalog.load_katalog(self.base)['tools'], [])

    def test_prepoznaje_samo_alate_za_dashboard(self):
        alat = make_zip(self.src / 'a.zip', {'qr/app.js': app_js('qr', forms=('widget', 'app')), 'qr/server_ext.py': 'ROUTES = {}'})
        skill = make_zip(self.src / 's.zip', {'moj-skill/SKILL.md': '# skill'})
        cio = make_zip(self.src / 'd.zip', {'dash/app.js': app_js('home'), 'dash/server.py': '', 'dash/index.html': ''})
        dva = make_zip(self.src / 't.zip', {'x1/app.js': app_js('x1'), 'x2/app.js': app_js('x2', forms=('app',))})
        summary = katalog.sync([self.resource('a', alat), self.resource('s', skill, marked=False),
                                self.resource('d', cio, marked=False), self.resource('t', dva)], self.base, check_unmarked=True)
        data = katalog.load_katalog(self.base)
        ids = sorted(t['id'] for t in data['tools'])
        self.assertEqual(ids, ['qr', 'x1', 'x2'])
        qr = next(t for t in data['tools'] if t['id'] == 'qr')
        self.assertTrue(qr['widget'] and qr['app'] and qr['server'])
        self.assertEqual(qr['name'], 'Alat qr')  # manifest, ne raniji { id: 'nije-ovo' }
        self.assertEqual(summary['nije_dashboard'], 2)
        # keš čuva samo zipove alata
        self.assertEqual(len(list((self.base / '.katalog' / 'cache').glob('*.zip'))), 2)

    def test_manifest_u_jednom_redu(self):
        src = "AIZdravo.registerApp({ id: 'mini', name: 'Ana\\'s alat', version: '1.2.0', icon: 'tool', description: 'x', widget(el) { el.textContent = 1; } });"
        m = katalog._manifest_from_source(src)
        self.assertEqual((m['id'], m['name'], m['version'], m['widget'], m['app']), ('mini', "Ana's alat", '1.2.0', True, False))

    def test_odbija_link_van_platforme_bez_preuzimanja(self):
        bad = {'id': 'resource:bad', 'title': 'x', 'text': 'Kompatibilno sa: AI Zdravo Dashboard',
               'metadata': {'download': {'url': 'https://example.com/storage/v1/object/public/ai-sistem-files/x.zip'}}}
        summary = katalog.sync([bad], self.base)
        self.assertEqual(self.downloads, [])
        self.assertEqual(len(summary['greske']), 1)
        self.assertEqual(katalog.load_katalog(self.base)['tools'], [])

    def test_odbija_zip_slip_i_simlink(self):
        slip = make_zip(self.src / 'slip.zip', {'ok/app.js': app_js('ok'), 'ok/../../evil.txt': 'x'})
        link = make_zip(self.src / 'link.zip', {'ok/app.js': app_js('ok')}, symlinks=[('ok/secret', '/etc/passwd')])
        summary = katalog.sync([self.resource('slip', slip), self.resource('link', link)], self.base)
        self.assertEqual(len(summary['greske']), 2)
        self.assertEqual(katalog.load_katalog(self.base)['tools'], [])
        self.assertFalse((self.tmp / 'evil.txt').exists())

    def test_diferencijalno_ne_skida_ponovo(self):
        z = make_zip(self.src / 'a.zip', {'qr/app.js': app_js('qr')})
        res = self.resource('a', z)
        katalog.sync([res], self.base)
        katalog.sync([res], self.base)
        self.assertEqual(len(self.downloads), 1)

    def test_isti_alat_dvaput_prikazuje_noviju_verziju(self):
        old = make_zip(self.src / 'o.zip', {'vk-1.0.0/app.js': app_js('vk', '1.0.0')})
        new = make_zip(self.src / 'n.zip', {'vk-1.1.0/app.js': app_js('vk', '1.1.0')})
        katalog.sync([self.resource('o', old), self.resource('n', new)], self.base)
        tools = katalog.load_katalog(self.base)['tools']
        self.assertEqual([(t['id'], t['version']) for t in tools], [('vk', '1.1.0')])

    def test_instalacija_i_arhiva_stare_verzije(self):
        z = make_zip(self.src / 'a.zip', {'qr-2/app.js': app_js('qr', '2.0.0'), 'qr-2/data/x.json': '{}'})
        katalog.sync([self.resource('a', z)], self.base)
        (self.base / 'apps' / 'qr').mkdir()
        (self.base / 'apps' / 'qr' / 'app.js').write_text(app_js('qr', '1.0.0'))
        manifest, archived = katalog.install('resource:a', 'qr', self.base)
        self.assertEqual(manifest['version'], '2.0.0')
        self.assertTrue((self.base / 'apps' / 'qr' / 'data' / 'x.json').exists())
        self.assertIn("version: '2.0.0'", (self.base / 'apps' / 'qr' / 'app.js').read_text())
        self.assertTrue(archived and (archived / 'app.js').exists())
        self.assertEqual(list((self.base / '.katalog').glob('staging-*')), [])

    def test_azuriranje_zadrzi_korisnikove_fajlove(self):
        """Paket nosi .env sa placeholderom: korisnikov pravi ključ i fajlovi
        koje je dodao (npr. paket ikonica) moraju preživjeti ažuriranje."""
        z = make_zip(self.src / 'a.zip', {
            'tts/app.js': app_js('tts', '2.0.0'),
            'tts/.env': 'API_KEY=upisi-svoj-kljuc\n',
            'tts/.env.example': 'API_KEY=primjer-novi\n',
            'tts/packs/osnovni/meta.json': '{"v": 2}',
        })
        katalog.sync([self.resource('a', z)], self.base)
        old = self.base / 'apps' / 'tts'
        (old / 'packs' / 'moj').mkdir(parents=True)
        (old / 'packs' / 'moj' / 'meta.json').write_text('{"moj": true}')
        (old / 'packs' / 'osnovni').mkdir(parents=True)
        (old / 'packs' / 'osnovni' / 'meta.json').write_text('{"v": 1}')
        (old / 'app.js').write_text(app_js('tts', '1.0.0'))
        (old / '.env').write_text('API_KEY=pravi-kljuc\n')
        (old / '.env.example').write_text('API_KEY=primjer-stari\n')
        katalog.install('resource:a', 'tts', self.base)
        new = self.base / 'apps' / 'tts'
        self.assertEqual((new / '.env').read_text(), 'API_KEY=pravi-kljuc\n')
        self.assertEqual((new / '.env.example').read_text(), 'API_KEY=primjer-novi\n')
        self.assertTrue((new / 'packs' / 'moj' / 'meta.json').exists())
        self.assertEqual((new / 'packs' / 'osnovni' / 'meta.json').read_text(), '{"v": 2}')
        self.assertIn("version: '2.0.0'", (new / 'app.js').read_text())

    def test_instalacija_odbija_promijenjen_zip(self):
        z = make_zip(self.src / 'a.zip', {'qr/app.js': app_js('qr')})
        katalog.sync([self.resource('a', z)], self.base)
        cached = next((self.base / '.katalog' / 'cache').glob('*.zip'))
        make_zip(cached, {'qr/app.js': app_js('qr') + '// podmetnuto'})
        with self.assertRaises(katalog.KatalogError):
            katalog.install('resource:a', 'qr', self.base)
        self.assertFalse((self.base / 'apps' / 'qr').exists())

    def test_instalacija_samo_alata_iz_kataloga(self):
        with self.assertRaises(katalog.KatalogError):
            katalog.install('resource:nema', 'qr', self.base)
        with self.assertRaises(katalog.KatalogError):
            katalog.install('resource:a', '../izlaz', self.base)


class FakeResponse:
    def __init__(self, url, body, length):
        self.url, self.body, self.headers = url, body, {'Content-Length': str(length)}

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def geturl(self):
        return self.url

    def read(self, n):
        chunk, self.body = self.body[:n], self.body[n:]
        return chunk


class DownloadRetryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.zip_bytes = make_zip(self.tmp / 'z.zip', {'qr/app.js': app_js('qr')}).read_bytes()
        self._orig_urlopen = katalog.urllib.request.urlopen
        self._orig_sleep = katalog.time.sleep
        katalog.time.sleep = lambda s: None
        self.calls = 0

    def tearDown(self):
        katalog.urllib.request.urlopen = self._orig_urlopen
        katalog.time.sleep = self._orig_sleep
        shutil.rmtree(self.tmp, ignore_errors=True)

    def serve(self, bodies):
        def fake(req, timeout=None):
            body = bodies[min(self.calls, len(bodies) - 1)]
            self.calls += 1
            return FakeResponse(req.full_url, body, len(self.zip_bytes))
        katalog.urllib.request.urlopen = fake

    def test_skracen_prenos_pokusava_ponovo(self):
        self.serve([self.zip_bytes[:200], self.zip_bytes])
        dest = self.tmp / 'cache' / 'a.zip'
        katalog.download_zip(HOST + 'a.zip', dest)
        self.assertEqual(self.calls, 2)
        self.assertEqual(dest.read_bytes(), self.zip_bytes)
        self.assertFalse(dest.with_suffix('.part').exists())

    def test_stalno_skracen_prenos_je_greska_bez_ostatka(self):
        self.serve([self.zip_bytes[:200]])
        dest = self.tmp / 'cache' / 'a.zip'
        with self.assertRaises(katalog.KatalogError):
            katalog.download_zip(HOST + 'a.zip', dest)
        self.assertEqual(self.calls, katalog.DOWNLOAD_ATTEMPTS)
        self.assertFalse(dest.exists())
        self.assertFalse(dest.with_suffix('.part').exists())


if __name__ == '__main__':
    unittest.main()
