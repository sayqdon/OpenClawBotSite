#!/usr/bin/env bash
set -euo pipefail
cd /home/qdon/work/OpenClawBotSite/orchestrator
mkdir -p logs
node index.js round >> logs/round.log 2>&1
