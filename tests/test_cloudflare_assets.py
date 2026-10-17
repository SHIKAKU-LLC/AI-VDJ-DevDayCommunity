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
            MODULE.build(destination)
            files = {str(path.relative_to(destination)) for path in destination.rglob('*') if path.is_file()}
            self.assertIn('judge-room.mjs', files)
            self.assertIn('judge-meter.mjs', files)
            self.assertIn('LICENSE.qr.txt', files)
            self.assertNotIn('mac-owner-bridge.mjs', files)
            self.assertNotIn('owner-return.html', files)
            self.assertNotIn('room-entry.html', files)
            self.assertNotIn('owner-setup.mjs', files)
            self.assertFalse(any(path.startswith('.') or path.endswith(('.sql', '.env', '.py')) for path in files))
            html = (destination / 'judge-room.html').read_text()
            self.assertNotIn('127.0.0.1', html)
            self.assertNotIn('vdj-mac-guide', html)
            self.assertIn('/judge-room.mjs', html)


if __name__ == '__main__':
    unittest.main()
