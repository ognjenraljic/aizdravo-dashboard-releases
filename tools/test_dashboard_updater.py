#!/usr/bin/env python3
"""Regresioni test za dashboard_updater.py.

Simulira tačno ono što smo ranije ručno provjeravali uživo (instaliran
alat + prilagođen raspored + eventualna server.py dopuna preživljavaju
core update) - ali sad ponovljivo, preko `python3 tools/test_dashboard_updater.py`,
bez da neko mora ručno ponoviti simulaciju pri svakoj budućoj izmjeni
update mehanike ili core fajlova.
"""

import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
import dashboard_updater as du


def _make_fixture_from_repo(dest):
    """Kopira core fajlove iz OVOG repoa u dest - test radi protiv
    stvarne index.html/server.py strukture, ne izmišljene."""
    dest.mkdir(parents=True, exist_ok=True)
    for rel in du.CORE_FILES:
        src = REPO_ROOT / rel
        if not src.exists():
            continue
        target = dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, target)
    (dest / 'apps').mkdir(exist_ok=True)


class DashboardUpdaterTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='aizdravo-updater-test-'))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def _install_fake_app(self, current_dir):
        app_dir = current_dir / 'apps' / 'test-app'
        app_dir.mkdir(parents=True, exist_ok=True)
        (app_dir / 'app.js').write_text(
            "AIZdravo.registerApp({id:'test-app', icon:'tool'});", encoding='utf-8'
        )
        index_path = current_dir / 'index.html'
        html = index_path.read_text(encoding='utf-8')
        content_start, _ = du._content_bounds(html, 'test fixture')
        marker_line = '<script src="apps/test-app/app.js"></script>\n'
        html = html[:content_start] + marker_line + html[content_start:]
        index_path.write_text(html, encoding='utf-8')

    def _write_state(self, current_dir, values):
        (current_dir / 'dashboard-state.json').write_text(
            json.dumps({'updated_at': 'test', 'values': values}, ensure_ascii=False),
            encoding='utf-8',
        )

    def test_installed_app_and_layout_survive_normal_update(self):
        current_dir = self.tmp / 'current'
        staging_dir = self.tmp / 'staging'
        _make_fixture_from_repo(current_dir)
        _make_fixture_from_repo(staging_dir)

        self._install_fake_app(current_dir)
        self._write_state(current_dir, {'aizdravo:tabs': 'moj-prilagodjen-raspored'})

        (current_dir / 'VERSION').write_text('1.0.2\n', encoding='utf-8')
        (staging_dir / 'VERSION').write_text('1.0.3\n', encoding='utf-8')

        report = du.apply_update(current_dir, staging_dir)

        self.assertEqual((current_dir / 'VERSION').read_text().strip(), '1.0.3')
        self.assertTrue((current_dir / 'apps' / 'test-app' / 'app.js').exists())
        self.assertIn(
            'apps/test-app/app.js',
            (current_dir / 'index.html').read_text(encoding='utf-8'),
        )
        state = json.loads((current_dir / 'dashboard-state.json').read_text(encoding='utf-8'))
        self.assertEqual(state['values']['aizdravo:tabs'], 'moj-prilagodjen-raspored')
        self.assertFalse(report['server_update_skipped'])
        self.assertEqual(report['server_customization_detected'], [])
        self.assertTrue(Path(report['backup_dir']).exists())
        # backup mora imati STARU (predupdate) registraciju alata sačuvanu
        self.assertIn(
            'apps/test-app/app.js',
            (Path(report['backup_dir']) / 'index.html').read_text(encoding='utf-8'),
        )

    def test_custom_server_endpoint_is_preserved_not_overwritten(self):
        current_dir = self.tmp / 'current'
        staging_dir = self.tmp / 'staging'
        _make_fixture_from_repo(current_dir)
        _make_fixture_from_repo(staging_dir)
        self._install_fake_app(current_dir)
        self._write_state(current_dir, {})

        server_path = current_dir / 'server.py'
        text = server_path.read_text(encoding='utf-8')
        insert_marker = 'class Handler(http.server.SimpleHTTPRequestHandler):\n'
        idx = text.find(insert_marker)
        self.assertNotEqual(idx, -1, 'test fixture pretpostavlja da server.py ima Handler klasu')
        idx += len(insert_marker)
        custom_method = '    def handle_test_custom_tool(self):\n        pass\n\n'
        text = text[:idx] + custom_method + text[idx:]
        server_path.write_text(text, encoding='utf-8')
        original_server_text = server_path.read_text(encoding='utf-8')

        report = du.apply_update(current_dir, staging_dir)

        self.assertTrue(report['server_update_skipped'])
        self.assertIn('handle_test_custom_tool', report['server_customization_detected'])
        self.assertEqual(server_path.read_text(encoding='utf-8'), original_server_text)
        # ostatak core-a se i dalje primijenio uprkos preskočenom server.py
        self.assertIn(
            'apps/test-app/app.js',
            (current_dir / 'index.html').read_text(encoding='utf-8'),
        )

    def test_stale_manifest_json_is_refreshed_on_disk(self):
        # 28.7.2026 fix: MANIFEST.json je ranije bio SAMO parsiran u
        # memoriju za hash provjeru, nikad primijenjen na disk - lokalna
        # kopija je ostajala trajno zastarjela poslije svakog update-a.
        current_dir = self.tmp / 'current'
        staging_dir = self.tmp / 'staging'
        _make_fixture_from_repo(current_dir)
        _make_fixture_from_repo(staging_dir)
        self._write_state(current_dir, {})

        (current_dir / 'MANIFEST.json').write_text('{"stara": "verzija"}', encoding='utf-8')
        (staging_dir / 'MANIFEST.json').write_text('{"nova": "verzija"}', encoding='utf-8')

        du.apply_update(current_dir, staging_dir)

        self.assertEqual(
            (current_dir / 'MANIFEST.json').read_text(encoding='utf-8'),
            '{"nova": "verzija"}',
        )

    def test_relative_current_dir_via_cli_produces_correctly_placed_backup(self):
        # 28.7.2026 bug: main() nikad nije rjesavao current_dir u apsolutnu
        # putanju, a SKILL.md instruira TACNO `cd <folder> && python3
        # tools/dashboard_updater.py .` - Path('.').name je prazan string i
        # Path('.').parent je Path('.') sam, pa je backup_folder() (i
        # staging_dir u main()) zavrsavao UNUTAR current_dir-a ("./-backup-
        # <ts>") umjesto kao sibling folder. Otkriveno uzivo na
        # ai-zdravo-dashboard-serijal. Ovaj test poziva du.main() bas kao
        # sto ce ga SKILL.md pozvati - relativna tacka, iz tog foldera.
        current_dir = self.tmp / 'my-dashboard'
        staging_dir = self.tmp / 'staging'
        _make_fixture_from_repo(current_dir)
        _make_fixture_from_repo(staging_dir)
        self._write_state(current_dir, {})
        (current_dir / 'VERSION').write_text('1.0.2\n', encoding='utf-8')
        (staging_dir / 'VERSION').write_text('1.0.3\n', encoding='utf-8')
        # fixture kopira i MANIFEST.json iz OVOG repoa (dio CORE_FILES) -
        # njegov hash za VERSION bi odgovarao STAROM sadržaju, ne '1.0.3\n'
        # koji test upravo upisuje. main() sa --source-dir učita manifest
        # SAMO ako fajl postoji - obriši ga da test ide offline-bez-manifest
        # putanjom (isto sto i ostali testovi rade preko apply_update() bez
        # manifest argumenta).
        (staging_dir / 'MANIFEST.json').unlink(missing_ok=True)

        old_cwd = os.getcwd()
        old_argv = sys.argv
        try:
            os.chdir(current_dir)
            sys.argv = ['dashboard_updater.py', '.', '--source-dir', str(staging_dir)]
            du.main()
        finally:
            os.chdir(old_cwd)
            sys.argv = old_argv

        sibling_backups = list(self.tmp.glob('my-dashboard-backup-*'))
        self.assertEqual(
            len(sibling_backups), 1,
            'backup mora biti sibling folder sa punim imenom (npr. "my-dashboard-backup-..."), ne "-backup-..."',
        )
        self.assertFalse(
            list(current_dir.glob('*backup*')),
            'backup ne smije zavrsiti UNUTAR current_dir-a samog',
        )

    def test_never_touch_paths_are_not_in_core_files(self):
        overlap = du.NEVER_TOUCH & set(du.CORE_FILES)
        self.assertEqual(overlap, set(), 'NEVER_TOUCH putanje se ne smiju naći u CORE_FILES')

    def test_manifest_hash_mismatch_aborts_before_any_write(self):
        current_dir = self.tmp / 'current'
        staging_dir = self.tmp / 'staging'
        _make_fixture_from_repo(current_dir)
        _make_fixture_from_repo(staging_dir)
        self._write_state(current_dir, {'aizdravo:tabs': 'netaknuto'})

        bad_manifest = {'VERSION': 'ovo-nije-tacan-sha256-hash'}
        with self.assertRaises(du.UpdateError):
            du.apply_update(current_dir, staging_dir, manifest=bad_manifest)

        # ništa se nije promijenilo - state je i dalje netaknut, nema backupa
        state = json.loads((current_dir / 'dashboard-state.json').read_text(encoding='utf-8'))
        self.assertEqual(state['values']['aizdravo:tabs'], 'netaknuto')
        self.assertFalse(list(current_dir.parent.glob('current-backup-*')))


if __name__ == '__main__':
    unittest.main(verbosity=2)
