#!/bin/bash
# 各 postgres コンテナを pg_dumpall で毎晩バックアップ(gzip保存＋世代ローテーション)。
# service-watchdog の check_backups が「最新dumpが古い/欠落」を監視する。root/systemd実行想定。
set -uo pipefail
CONF="${1:-/etc/service-watchdog.conf}"
# shellcheck source=/dev/null
[ -r "$CONF" ] && . "$CONF"
OUT="${BACKUP_DIR:-/var/backups/db}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-7}"
DATE="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"; chmod 700 "$OUT"

# 対象は設定の BACKUP_TARGETS(空白区切りの "container|POSTGRES_USER")。未設定なら何もしない。
read -r -a TARGETS <<< "${BACKUP_TARGETS:-}"
if [ "${#TARGETS[@]}" -eq 0 ]; then echo "BACKUP_TARGETS 未設定: 何もしない"; exit 0; fi

rc=0
for t in "${TARGETS[@]}"; do
  IFS='|' read -r c u <<< "$t"
  f="$OUT/${c}-${DATE}.sql.gz"
  if docker exec "$c" pg_dumpall -U "$u" 2>/dev/null | gzip -c > "$f" && [ -s "$f" ]; then
    echo "OK   $c -> $(basename "$f") ($(du -h "$f" | cut -f1))"
  else
    rm -f "$f"; echo "FAIL $c"; rc=1
  fi
  # 世代ローテーション(KEEP_DAYSより古い同コンテナのdumpを削除)
  find "$OUT" -maxdepth 1 -name "${c}-*.sql.gz" -mtime +"$KEEP_DAYS" -delete 2>/dev/null
done
exit $rc
