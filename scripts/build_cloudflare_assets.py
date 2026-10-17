#!/usr/bin/env python3
"""Cloudflareに配信する画面を許可リストから構築する。配備は行わない。"""
from pathlib import Path
import shutil

from build_room_candidate import ROOM, PLAYER

ROOT = Path(__file__).resolve().parent.parent
DESTINATION = ROOT / 'cloud/cloudflare/.cloudflare/assets'


def build(destination=DESTINATION):
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    # A fixed, generated directory only. Never copy the repository wholesale.
    for child in destination.iterdir():
        shutil.rmtree(child) if child.is_dir() else child.unlink()
    legacy = {'mac-owner-bridge.mjs', 'mac-companion-bridge.mjs', 'owner-link.mjs',
              'owner-return.html', 'owner-return.mjs'}
    files = {name: (ROOT / 'room-web' / name).read_bytes() for name in ROOM if name not in legacy}
    files.update({name: (ROOT / source).read_bytes() for name, source in PLAYER.items()})
    html = files['room-entry.html'].decode()
    html = html.replace('<meta name="vdj-mac-guide" content="2026-10-15-companion-3">', '')
    html = html.replace("connect-src 'self' http://127.0.0.1:54414;", "connect-src 'self';")
    html = html.replace("media-src blob:;", "media-src 'self' blob:;")
    files['room-entry.html'] = html.encode()
    for name, content in files.items():
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    return len(files)


if __name__ == '__main__':
    print(f'画面ファイル {build()} 件を構築しました。配備は行っていません。')
