#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

if command -v python3.11 >/dev/null 2>&1; then
  PYTHON_BIN="$(command -v python3.11)"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="$(command -v python3)"
else
  echo 'Python 3.11 is required in the cloud base environment.' >&2
  exit 1
fi
"$PYTHON_BIN" -c 'import sys; assert sys.version_info[:2] == (3, 11), "Python 3.11 is required"'

if ! command -v ffmpeg >/dev/null 2>&1; then
  if ! command -v apt-get >/dev/null 2>&1; then
    echo 'ffmpeg is missing. This setup installs it only on Debian/Ubuntu.' >&2
    exit 1
  fi
  APT_PREFIX=()
  if [[ "$(id -u)" != 0 ]]; then
    if ! command -v sudo >/dev/null 2>&1; then
      echo 'Installing ffmpeg requires root or sudo in the cloud environment.' >&2
      exit 1
    fi
    APT_PREFIX=(sudo -n)
  fi
  "${APT_PREFIX[@]}" apt-get update
  "${APT_PREFIX[@]}" apt-get install -y --no-install-recommends ffmpeg
fi

if [[ ! -d .venv ]]; then
  "$PYTHON_BIN" -m venv .venv
fi
.venv/bin/python -c 'import sys; assert sys.version_info[:2] == (3, 11), "Recreate .venv with Python 3.11"'
.venv/bin/python -m pip install --disable-pip-version-check -r requirements-analysis.txt
.venv/bin/python -m pip check

export MPLBACKEND=Agg
.venv/bin/python -c 'import numpy, matplotlib; print("numpy", numpy.__version__); print("matplotlib", matplotlib.__version__)'
ffmpeg -version
# Generated sine only: no input media is read or written.
ffmpeg -hide_banner -loglevel error -f lavfi -i sine=frequency=440:duration=0.05 -f null -
.venv/bin/python -m unittest discover -s tests -v
.venv/bin/python scripts/check_repository.py
