#!/bin/zsh
set -eu
cd -- "$(dirname -- "$0")"
node scripts/launch.mjs
