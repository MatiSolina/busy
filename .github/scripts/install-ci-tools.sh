#!/bin/sh
set -eu
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
tools="$repo_root/.vercel-ci-tools"
mkdir -p "$tools"
curl -fsSL --retry 2 https://github.com/krallin/tini/releases/download/v0.19.0/tini-static-amd64 -o "$tools/tini"
printf '%s  %s\n' c5b0666b4cb676901f90dfcb37106783c5fe2077b04590973b885950611b30ee "$tools/tini" | sha256sum -c -
chmod 755 "$tools/tini"
