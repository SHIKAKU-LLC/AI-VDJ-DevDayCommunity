#!/usr/bin/env python3
"""Cloudflareに配信する画面を許可リストから構築する。配備は行わない。"""
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parent.parent
DESTINATION = ROOT / 'cloud/cloudflare/.cloudflare/assets'


def build(destination=DESTINATION):
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    # A fixed, generated directory only. Never copy the repository wholesale.
    for child in destination.iterdir():
        shutil.rmtree(child) if child.is_dir() else child.unlink()
    # Ship only the cloud interface. The historical owner/native setup pages
    # remain source history, never public assets in the Cloudflare service.
    names = ['judge-room.html', 'judge-room.css', 'judge-room.mjs', 'judge-player.mjs',
             'judge-meter.mjs', 'judge-vj.mjs', 'qr-encoder.mjs', 'LICENSE.qr.txt']
    files = {name: (ROOT / 'room-web' / name).read_bytes() for name in names}
    for name, content in files.items():
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    return len(files)


if __name__ == '__main__':
    print(f'画面ファイル {build()} 件を構築しました。配備は行っていません。')
