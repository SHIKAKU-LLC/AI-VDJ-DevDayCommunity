#!/usr/bin/env python3
"""Build an allowlisted static candidate from one immutable Git commit.

This creates local files only. Caller must separately verify the dedicated
Supabase Free project and existing Vercel team/project before deploying.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
from urllib.parse import urlparse

BASE = ('index.html', 'style.css', 'web.css', 'studio.mjs', 'output.html',
        'output.css', 'output.js', 'release.json', 'vercel.json')
ROOM = ('room-entry.html', 'room-host.mjs', 'mac-owner-bridge.mjs', 'mac-companion-bridge.mjs', 'owner-link.mjs', 'owner-return.html', 'owner-return.mjs', 'qr-encoder.mjs', 'LICENSE.qr.txt',
        'rooms/room-ui.css', 'rooms/room-components.mjs', 'rooms/room-ui-model.mjs',
        'rooms/room-api-client.mjs', 'rooms/room-model-port.mjs',
        'rooms/room-contract-view.mjs', 'rooms/join-projection.mjs',
        'cloud-owner-controls.mjs', 'owner-setup.mjs', 'owner-setup-model.mjs', 'cloud-initial-audio.mjs', 'cloud-output.html', 'cloud-output.mjs', 'cloud-output.css',
        'cloud-output-bridge.mjs', 'cloud-output-credit.mjs', 'cloud-playback.mjs', 'cloud-playback-media.mjs',
        'owner-cue-host.mjs', 'playback/commit-playback.mjs', 'playback/cue-contract.mjs',
        'playback/output-lease.mjs', 'playback/worklet-engine.mjs', 'playback/clip-timeline.mjs', 'playback/player-observer.mjs', 'playback/playback.css')
PLAYER = {'room-worklet.mjs': 'snapshot/app/room-worklet.mjs',
          'scene-video-adapter.mjs': 'snapshot/ui/app/scene-video-adapter.mjs',
          'src/motif-contract.mjs': 'snapshot/ui/src/motif-contract.mjs'}

def allow_approved_mac_for_room(config):
    """The approved fixed-port exception applies only to the /room document."""
    rule = config['headers'][0]
    policies = [header for header in rule['headers']
                if header['key'].lower() == 'content-security-policy']
    if rule['source'] != '/(.*)' or len(policies) != 1:
        raise ValueError('Expected one global CSP')
    strict = policies[0]['value']
    if strict.count("connect-src 'self';") != 1:
        raise ValueError('Expected self-only connection policy')
    if strict.count("frame-ancestors 'none'") != 1:
        raise ValueError('Expected a no-embedding frame policy')
    rule['headers'] = [header for header in rule['headers']
                       if header['key'].lower() != 'content-security-policy']
    # Disjoint rules avoid imposing the self-only policy on /room as well.
    config['headers'].extend([
        {'source': '/((?!room$|cloud-output\\.html$).*)', 'headers': [
            {'key': 'Content-Security-Policy', 'value': strict}]},
        # The single-screen show embeds the output in the owner's /room page.
        # Only this same-origin document may be framed, and only by itself.
        {'source': '/cloud-output.html', 'headers': [
            {'key': 'Content-Security-Policy', 'value': strict.replace(
                "frame-ancestors 'none'", "frame-ancestors 'self'")}]},
        {'source': '/room', 'headers': [
            {'key': 'Content-Security-Policy', 'value': strict.replace(
                "connect-src 'self';", "connect-src 'self' http://127.0.0.1:54414;")},
            # A 304 without CSP can preserve an older deployment's cached policy.
            {'key': 'Cache-Control', 'value': 'no-store'}]},
    ])

def build(repo: Path, commit: str, project_ref: str, native_host_origin: str | None = None, judge_cloud: bool = False) -> dict[str, bytes]:
    if not re.fullmatch(r'[a-f0-9]{40}', commit):
        raise ValueError('Exact commit required')
    if not re.fullmatch(r'[a-z]{20}', project_ref):
        raise ValueError('Verified dedicated Supabase project ref required')
    def blob(path):
        return subprocess.run(['git', '-C', str(repo), 'show', f'{commit}:{path}'],
                              check=True, capture_output=True).stdout
    result = {name: blob('web/' + name) for name in BASE}
    result.update({name: blob('room-web/' + name) for name in ROOM})
    result.update({name: blob(source) for name, source in PLAYER.items()})
    # A deployment header fix must also invalidate old cached HTML validators.
    # Only the public commit ID is embedded; credentials remain tab-local.
    html = result['room-entry.html']
    if html.count(b'<head>') != 1 or b'name="vdj-room-build"' in html:
        raise ValueError('Expected an unmarked room document head')
    result['room-entry.html'] = html.replace(
        b'<head>', f'<head><meta name="vdj-room-build" content="{commit}">'.encode(), 1)
    config = json.loads(result['vercel.json'])
    allow_approved_mac_for_room(config)
    backend = f'https://{project_ref}.supabase.co/functions/v1/ai-vdj-room'
    config['rewrites'] = [
        {'source': '/api/owner/:path*', 'destination': backend + '/api/owner/:path*'},
        {'source': '/api/rooms', 'destination': backend + '/api/rooms'},
        {'source': '/api/rooms/:path*', 'destination': backend + '/api/rooms/:path*'},
        {'source': '/api/room-capabilities', 'destination': backend + '/api/room-capabilities'},
        {'source': '/join/:roomId', 'destination': '/room-entry.html'},
        {'source': '/room/auth-return', 'destination': '/owner-return.html'},
        {'source': '/room/:path*', 'destination': '/room-entry.html'},
    ]
    if judge_cloud and native_host_origin is None:
        raise ValueError('Reviewed judge server origin required')
    if native_host_origin is not None:
        host = urlparse(native_host_origin)
        if (host.scheme != 'https' or not host.hostname or host.username or host.password
                or host.path or host.query or host.fragment or host.port
                or not re.fullmatch(r'[a-zA-Z0-9.-]+', host.hostname)):
            raise ValueError('Reviewed HTTPS native host origin required')
        # Same-origin proxy routing changes no browser CSP or owner capability.
        # Existing login/room writes remain on the original Supabase entry.
        prepared = [
            '/api/room-capabilities', '/api/rooms/:roomId/operator/:path*', '/api/rooms/:roomId/player/:path*',
            '/api/rooms/:roomId/source/:path*', '/api/rooms/:roomId/jobs/:path*',
            '/api/rooms/:roomId/cues/:path*', '/api/rooms/:roomId/cloud/media/:path*',
            '/api/rooms/:roomId/playback/preload',
            '/api/rooms/:roomId/media/:path*', '/api/rooms/:roomId/submissions/:submissionId',
            '/api/rooms/:roomId/events',
            '/api/rooms/:roomId',
        ]
        config['rewrites'] = [{'source': route, 'destination': native_host_origin + route}
                              for route in prepared] + config['rewrites']
        if judge_cloud:
            config['rewrites'].insert(0, {'source': '/', 'destination': '/room-entry.html'})
            config['rewrites'].insert(0, {'source': '/api/judge/:path*', 'destination': native_host_origin + '/api/judge/:path*'})
            config['rewrites'].insert(1, {'source': '/api/rooms/:roomId/native/:path*', 'destination': native_host_origin + '/api/rooms/:roomId/native/:path*'})
            for rule in config['headers']:
                for header in rule['headers']:
                    if header['key'] == 'Content-Security-Policy':
                        header['value'] = header['value'].replace(" http://127.0.0.1:54414", "")
    config['headers'].append({'source':'/room/auth-return','headers':[{'key':'Cache-Control','value':'no-store'},{'key':'Referrer-Policy','value':'no-referrer'}]})
    result['vercel.json'] = (json.dumps(config, indent=2) + '\n').encode()
    result['room-release.json'] = (json.dumps({
        'status': 'CANDIDATE_NOT_VERIFIED_LIVE', 'commit': commit,
        'mode': 'collect', 'providerGeneration': False, 'actualCredit': False,
        'macConnectionGuide': '2026-10-15-companion-3',
        'cloudFirstPrepared': True, 'cloudJobsActivated': False,
        'cloudQCActivated': False, 'browserPlayerActivated': False,
    }, indent=2) + '\n').encode()
    return result

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--project-ref', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--native-host-origin', help='Reviewed deployed HTTPS native broker; omitted keeps existing routing')
    parser.add_argument('--judge-cloud', action='store_true', help='Use the reviewed temporary judge server without loopback access')
    args = parser.parse_args()
    repo = Path(__file__).resolve().parent.parent
    if args.output.exists() or args.output.with_suffix('.manifest.json').exists():
        parser.error('Use a new output directory; existing files will not be overwritten')
    payload = build(repo, args.commit, args.project_ref, args.native_host_origin, args.judge_cloud)
    args.output.mkdir(parents=True)
    for name, data in payload.items():
        path = args.output / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    manifest = {name: hashlib.sha256(data).hexdigest() for name, data in payload.items()}
    # This manifest is an evidence file beside the candidate, never a public payload.
    args.output.with_suffix('.manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f'Built {len(payload)} allowlisted files; no deployment performed')

if __name__ == '__main__':
    main()
