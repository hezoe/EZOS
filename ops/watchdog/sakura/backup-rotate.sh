#!/bin/sh
# さくら側の後片付けと www の週ごとの写し(2026-11-16)。~/bin/backup-rotate に置き、さくらの cron で毎日動かす。
# VPS の鍵には削除させない(backup-recv)ので、古い写しはここでだけ消す(DB 14 日・秘密情報 30 日・git 60 日)。
# www は VPS の鍵(rrsync)で書き換えられうるので、さくらの中に週 1 回の写しを残す(VPS からは届かない)。
set -u
umask 077
B=$HOME/backups
KEEP_DB_DAYS=14
KEEP_SECRETS_DAYS=30
KEEP_WWW=3
KEEP_GIT_DAYS=60
find "$B/vps-db" -type f -name '*.sql.gz' -mtime +"$KEEP_DB_DAYS" -exec rm -f {} + 2>/dev/null
find "$B/vps-secrets" -type f -name '*.gpg' -mtime +"$KEEP_SECRETS_DAYS" -exec rm -f {} + 2>/dev/null
# git の全履歴: リポジトリごとに最新の 1 つは期限を過ぎても残す(変わらないリポジトリの唯一の写しなので)
if [ -d "$B/vps-git" ]; then
  for id in $(ls "$B/vps-git" | sed -n 's/-[0-9]\{8\}-[0-9]\{6\}\.bundle$//p' | sort -u); do
    ls -1t "$B/vps-git/$id"-*.bundle | tail -n +2 | while read -r f; do
      [ -n "$(find "$f" -mtime +"$KEEP_GIT_DAYS")" ] && rm -f "$f"
    done
  done
fi
if [ "$(date +%u)" = 1 ] || [ -z "$(ls "$B"/www-snap/*.tar.gz 2>/dev/null)" ]; then
  mkdir -p "$B/www-snap"
  snap="$B/www-snap/www-snap-$(date +%Y%m%d).tar.gz"
  if nice -n 15 tar -czf "$snap.tmp" -C "$HOME" www 2>>"$B/rotate.log"; then
    chmod 400 "$snap.tmp"; mv -f "$snap.tmp" "$snap"
    echo "$(date '+%F %T') www-snap $(basename "$snap") $(stat -f %z "$snap")" >> "$B/rotate.log"
    ls -1t "$B"/www-snap/www-snap-*.tar.gz | tail -n +$((KEEP_WWW + 1)) | xargs rm -f
  else
    rm -f "$snap.tmp"; echo "$(date '+%F %T') www-snap 失敗" >> "$B/rotate.log"
  fi
fi
# 記録は 1MB を超えたら後ろ半分だけ残す
for l in "$B/recv.log" "$B/rotate.log"; do
  [ -f "$l" ] && [ "$(stat -f %z "$l")" -gt 1048576 ] && tail -c 524288 "$l" > "$l.tmp" && mv -f "$l.tmp" "$l"
done
exit 0
