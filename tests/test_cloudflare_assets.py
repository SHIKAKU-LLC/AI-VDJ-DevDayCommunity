import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
SPEC = importlib.util.spec_from_file_location('cloudflare_assets', SCRIPTS / 'build_cloudflare_assets.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class CloudflareAssetsTests(unittest.TestCase):
    def test_allowlisted_bundle_has_no_legacy_connection_pages_or_loopback_policy(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory)
            frontend = destination / 'input'
            (frontend / 'console-assets').mkdir(parents=True)
            (frontend / 'index.html').write_text('<script type="module" src="/console-assets/app.js"></script>')
            (frontend / 'console-assets/app.js').write_text('export {};')
            (frontend / 'console-assets/app.css').write_text('body {}')
            (frontend / 'console-assets/font.woff2').write_bytes(b'fixture')
            MODULE.build(destination / 'output', frontend)
            destination = destination / 'output'
            files = {str(path.relative_to(destination)) for path in destination.rglob('*') if path.is_file()}
            self.assertIn('console-assets/app.js', files)
            self.assertIn('judge-meter.mjs', files)
            self.assertIn('console-assets/font.woff2', files)
            self.assertIn('LICENSE.qr.txt', files)
            self.assertNotIn('mac-owner-bridge.mjs', files)
            self.assertNotIn('owner-return.html', files)
            self.assertNotIn('room-entry.html', files)
            self.assertNotIn('owner-setup.mjs', files)
            self.assertFalse(any(path.startswith('.') or path.endswith(('.sql', '.env', '.py')) for path in files))
            html = (destination / 'judge-room.html').read_text()
            self.assertNotIn('127.0.0.1', html)
            self.assertNotIn('vdj-mac-guide', html)
            self.assertIn('/console-assets/app.js', html)

    def test_rejects_source_maps_secrets_and_unbuilt_sources(self):
        for unsafe in ['app.js.map', '.env', 'main.tsx', 'judge-room.mjs']:
            with self.subTest(unsafe=unsafe), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / 'index.html').write_text('test')
                (root / 'console-assets').mkdir()
                (root / 'console-assets' / unsafe).write_text('test')
                with self.assertRaises(ValueError):
                    MODULE.build(root / 'output', root)


if __name__ == '__main__':
    unittest.main()
