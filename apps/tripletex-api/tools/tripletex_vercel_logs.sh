#!/usr/bin/env bash

set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <deployment-url-or-id>" >&2
  echo "Example: $0 https://nmiai26-tripletex.vercel.app" >&2
  exit 1
fi

deployment="$1"
shift || true

npx vercel logs "$deployment" --follow --json "$@" | rg --line-buffered 'tripletex_'
