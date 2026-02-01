#!/usr/bin/env bash
set -euo pipefail
exec 9>/tmp/fmkorea-collector.lock
flock -n 9 || exit 0

export PATH="/home/qdon/.nvm/versions/node/v22.20.0/bin:$PATH"
NODE_BIN="/home/qdon/.nvm/versions/node/v22.20.0/bin/node"

cd /home/qdon/work/OpenClawBotSite/fmkorea
mkdir -p logs
"$NODE_BIN" ./collector.js >> logs/fmkorea.log 2>&1
