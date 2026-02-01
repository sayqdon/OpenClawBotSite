#!/usr/bin/env bash
set -euo pipefail
exec 9>/tmp/openclaw-bot-round.lock
flock -n 9 || exit 0

# Ensure openclaw + node from nvm are available in systemd env
export PATH="/home/qdon/.nvm/versions/node/v22.20.0/bin:$PATH"
NODE_BIN="/home/qdon/.nvm/versions/node/v22.20.0/bin/node"

cd /home/qdon/work/OpenClawBotSite/orchestrator
mkdir -p logs
"$NODE_BIN" index.js round >> logs/round.log 2>&1
