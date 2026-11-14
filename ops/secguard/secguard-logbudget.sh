#!/bin/bash
# secguard の記録の容量を守る(毎日)。合計 2GB・90 日:
#   Caddy のアクセス記録 1.4GB / journald 400MB(60-secguard-journald.conf) / auditd 100MB(20MB×5) / secguard 25MB
# Caddy は 20MB ごとに gzip へ回し 90 日で消す。ここでは「90 日より古い回転済み」と「1.4GB を超えた分(古い順)」を消す。
set -eu
DIR=/home/debian/saas/caddy/data/logs
BUDGET_MB=${SECGUARD_CADDY_BUDGET_MB:-1400}
find "$DIR" -maxdepth 1 -name '*.log.gz' -mtime +90 -print -delete
total() { du -sm "$DIR" | cut -f1; }
n=0
while [ "$(total)" -gt "$BUDGET_MB" ]; do
  oldest=$(find "$DIR" -maxdepth 1 -name '*.log.gz' -printf '%T@ %p\n' | sort -n | head -1 | cut -d' ' -f2-)
  [ -n "$oldest" ] || break
  rm -f -- "$oldest"; n=$((n+1))
done
echo "caddy logs $(total)MB (budget ${BUDGET_MB}MB, removed $n over budget) / journald $(journalctl --disk-usage 2>/dev/null | grep -o '[0-9.]*[MG]') / audit $(du -sm /var/log/audit | cut -f1)MB"
