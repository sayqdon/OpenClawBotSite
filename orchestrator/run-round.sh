#!/usr/bin/env bash
set -euo pipefail
exec 9>/tmp/openclaw-bot-round.lock
flock -n 9 || exit 0
cd /home/qdon/work/OpenClawBotSite/orchestrator
mkdir -p logs
node index.js round >> logs/round.log 2>&1
