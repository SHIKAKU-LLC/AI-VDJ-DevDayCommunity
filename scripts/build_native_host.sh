#!/usr/bin/env bash
set -euo pipefail
# Build code only; this script does not publish an image or start infrastructure.
# Use an exact committed tree so ignored local assets/config never enter Docker.
vdj_commit=${1:?Exact commit required}
vdj_base_image=${2:?Reviewed immutable Node24 Debian image required}
vdj_tag=${3:?Local image tag required}
[[ "$vdj_commit" =~ ^[a-f0-9]{40}$ ]] || exit 2
[[ "$vdj_base_image" =~ ^[a-zA-Z0-9./:-]+@sha256:[a-f0-9]{64}$ ]] || exit 2
[[ "$vdj_tag" =~ ^[a-zA-Z0-9./:_-]+$ ]] || exit 2
vdj_build_dir=$(mktemp -d /tmp/vdj-native-build.XXXXXX)
trap 'rm -rf "$vdj_build_dir"' EXIT
git archive --format=tar "$vdj_commit" | tar -x -C "$vdj_build_dir"
docker build --build-arg "VDJ_NODE_IMAGE=$vdj_base_image" -f "$vdj_build_dir/cloud/worker/native-host.txt" -t "$vdj_tag" "$vdj_build_dir"
