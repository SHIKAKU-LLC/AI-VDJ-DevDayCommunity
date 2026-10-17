import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('builder', ROOT / 'scripts/build_room_candidate.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)

class RoomCandidateTests(unittest.TestCase):
    def test_exact_git_allowlist_and_routing_only(self):
        # A disposable committed fixture makes pre-commit checks meaningful even
        # when a new allowlisted source has not been committed to the real repo.
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            for prefix, names in [('web', builder.BASE), ('room-web', builder.ROOM)]:
                for name in names:
                    path = repo / prefix / name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes((ROOT / prefix / name).read_bytes())
            (repo / 'private-evidence.txt').write_text('excluded test fixture')
            for source in builder.PLAYER.values():
                path = repo / source
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes((ROOT / source).read_bytes())
            subprocess.run(['git', 'init', '-q', str(repo)], check=True)
            subprocess.run(['git', '-C', str(repo), 'add', '.'], check=True)
            subprocess.run(['git', '-C', str(repo), '-c', 'user.name=Synthetic QA',
                            '-c', 'user.email=qa@example.test', 'commit', '-qm', 'fixture'], check=True)
            commit = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip()
            (repo / 'web/index.html').write_text('uncommitted change must be excluded')
            payload = builder.build(repo, commit, 'a' * 20)
            prepared = builder.build(repo, commit, 'a' * 20, 'https://worker.example.test')
            judge = builder.build(repo, commit, 'a' * 20, 'https://worker.example.test', judge_cloud=True)
            judge_config = json.loads(judge['vercel.json'])
            self.assertIn({'source': '/api/judge/:path*', 'destination': 'https://worker.example.test/api/judge/:path*'}, judge_config['rewrites'])
            self.assertIn({'source': '/', 'destination': '/room-entry.html'}, judge_config['rewrites'])
            self.assertNotIn('127.0.0.1', judge['vercel.json'].decode())
            with self.assertRaises(ValueError):
                builder.build(repo, commit, 'a' * 20, judge_cloud=True)
            routes = json.loads(prepared['vercel.json'])['rewrites']
            self.assertEqual(routes[0], {'source': '/api/room-capabilities',
                                        'destination': 'https://worker.example.test/api/room-capabilities'})
            self.assertTrue(any(r['source'] == '/api/rooms/:roomId/player/:path*' for r in routes))
            self.assertTrue(any(r['source'] == '/api/rooms/:roomId/events' for r in routes))
            self.assertTrue(any(r['source'] == '/api/owner/:path*' and 'supabase.co/' in r['destination'] for r in routes))
            self.assertEqual(prepared['room-entry.html'], payload['room-entry.html'])
            for invalid in ['http://worker.example.test', 'https://worker.example.test/private',
                            'https://worker.example.test?example=1', 'https://' + 'example_user' + '@' + 'worker.example.test']:
                with self.assertRaises(ValueError):
                    builder.build(repo, commit, 'a' * 20, invalid)
            # Even a header-only deployment has a fresh HTML body/ETag, so a
            # validator from an old self-only CSP cannot elicit the same 304.
            (repo / 'private-evidence.txt').write_text('new excluded fixture revision')
            subprocess.run(['git', '-C', str(repo), 'add', 'private-evidence.txt'], check=True)
            subprocess.run(['git', '-C', str(repo), '-c', 'user.name=Synthetic QA',
                            '-c', 'user.email=qa@example.test', 'commit', '-qm', 'header-only fixture'], check=True)
            next_commit = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip()
            next_payload = builder.build(repo, next_commit, 'a' * 20)
            self.assertNotEqual(payload['room-entry.html'], next_payload['room-entry.html'])
            self.assertEqual(payload['vercel.json'], next_payload['vercel.json'])
            self.assertEqual(payload['mac-owner-bridge.mjs'], next_payload['mac-owner-bridge.mjs'])

            self.assertNotIn(b'uncommitted change', payload['index.html'])
            with self.assertRaises(ValueError):
                builder.build(repo, 'main', 'a' * 20)
            with self.assertRaises(ValueError):
                builder.build(repo, commit, 'unverified')
        self.assertEqual(set(payload), set(builder.BASE + builder.ROOM) | set(builder.PLAYER) | {'room-release.json'})
        self.assertFalse(any(name.startswith(('cloud/', 'snapshot/', 'qa/')) for name in payload))
        config = json.loads(payload['vercel.json'])
        original = json.loads((ROOT / 'web/vercel.json').read_text())
        strict = next(h['value'] for h in original['headers'][0]['headers']
                      if h['key'] == 'Content-Security-Policy')
        import re
        for path in ['/room', '/', '/join/test-room', '/room/auth-return',
                     '/room-entry.html', '/room/', '/rooms', '/room/other', '/api/rooms']:
            applied = [h['value'] for rule in config['headers']
                       if re.fullmatch(rule['source'], path)
                       for h in rule['headers'] if h['key'] == 'Content-Security-Policy']
            expected = strict.replace("connect-src 'self';", "connect-src 'self' http://127.0.0.1:54414;") if path == '/room' else strict
            self.assertEqual(applied, [expected], path)
            self.assertNotIn('127.0.0.1:*', applied[0])
            self.assertNotIn('localhost', applied[0])
        room_headers = next(rule['headers'] for rule in config['headers'] if rule['source'] == '/room')
        self.assertEqual(next(h['value'] for h in room_headers if h['key'] == 'Cache-Control'), 'no-store')
        self.assertIn(f'<meta name="vdj-room-build" content="{commit}">'.encode(), payload['room-entry.html'])
        self.assertIn(b'<meta name="vdj-mac-guide" content="2026-10-15-companion-3">', payload['room-entry.html'])
        self.assertEqual(len(config['rewrites']), 7)
        self.assertTrue(all('supabase.co/functions/v1/ai-vdj-room' in r['destination']
                            for r in config['rewrites'][:4]))
        release = json.loads(payload['room-release.json'])
        self.assertEqual(release['commit'], commit)
        self.assertFalse(release['providerGeneration'])
        self.assertTrue(release['cloudFirstPrepared'])
        self.assertFalse(release['browserPlayerActivated'])
        self.assertEqual(release['macConnectionGuide'], '2026-10-15-companion-3')
        self.assertEqual(config['rewrites'][5], {'source': '/room/auth-return',
                                                'destination': '/owner-return.html'})

    def test_unknown_global_policy_fails_closed(self):
        config = {'headers': [{'source': '/(.*)', 'headers': [
            {'key': 'Content-Security-Policy', 'value': "connect-src *;"}]}]}
        with self.assertRaises(ValueError):
            builder.allow_approved_mac_for_room(config)
