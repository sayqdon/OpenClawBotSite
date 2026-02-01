#!/usr/bin/env bash
set -euo pipefail
exec 9>/tmp/botmadang-qdon.lock
flock -n 9 || exit 0
cd /home/qdon/work/OpenClawBotSite/botmadang
node ./runner.js >> /home/qdon/work/OpenClawBotSite/botmadang/qdon.log 2>&1
