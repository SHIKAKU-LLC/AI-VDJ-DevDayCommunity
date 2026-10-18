#!/usr/bin/env python3
"""公開用のReactビルドだけを許可リストで取り込む。配備は行わない。"""
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parent.parent
DESTINATION = ROOT / 'cloud/cloudflare/.cloudflare/assets'
FRONTEND = ROOT / 'room-web/console/dist'


def build(destination=DESTINATION, frontend=FRONTEND):
    destination, frontend = Path(destination), Path(frontend)
    if not (frontend / 'index.html').is_file():
        raise ValueError('先に npm run build --prefix room-web/console を実行してください。')
    files = {'judge-room.html': (frontend / 'index.html').read_bytes()}
    for source in frontend.rglob('*'):
        if not source.is_file():
            continue
        name = source.relative_to(frontend)
        if name.as_posix() == 'index.html':
            continue
        if source.is_symlink() or len(name.parts) != 2 or name.parts[0] != 'console-assets' or source.suffix not in {'.js', '.css', '.woff2', '.woff'}:
            raise ValueError('公開用ビルドに許可されていないファイルがあります。')
        files[name.as_posix()] = source.read_bytes()
    for name, source in {
        'judge-meter.mjs': ROOT / 'room-web/judge-meter.mjs',
        'LICENSE.qr.txt': ROOT / 'room-web/LICENSE.qr.txt',
        'LICENSE.audiocn.txt': ROOT / 'room-web/console/LICENSE.audiocn.txt',
        'LICENSE.fonts.txt': ROOT / 'room-web/console/LICENSE.fonts.txt',
    }.items():
        files[name] = source.read_bytes()
    # Validate everything before replacing the previous build.
    destination.mkdir(parents=True, exist_ok=True)
    for child in destination.iterdir():
        shutil.rmtree(child) if child.is_dir() else child.unlink()
    for name, content in files.items():
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    return len(files)


if __name__ == '__main__':
    print(f'画面ファイル {build()} 件を構築しました。配備は行っていません。')
