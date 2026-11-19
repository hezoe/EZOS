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
read -r -a RTARGETS <<< "${BACKUP_REMOTE_TARGETS:-}"
if [ "${#TARGETS[@]}" -eq 0 ] && [ "${#RTARGETS[@]}" -eq 0 ]; then echo "BACKUP_TARGETS 未設定: 何もしない"; exit 0; fi

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

# 2026-11-19: 別ホストの DB(BACKUP_REMOTE_TARGETS、空白区切りの "名前|user@host|鍵")。
# 相手側で鍵を command= の出力専用に絞り、gzip した SQL を受け取る。中身は VPS で開けないよう
# 受け取りながら公開鍵で暗号化して <名前>-日時.sql.gz.gpg に置く(offsite-backup がさくらへ送る)。
PUB=/etc/offsite-backup/secrets.pub.asc
for t in "${RTARGETS[@]}"; do
  IFS='|' read -r c dest key <<< "$t"
  f="$OUT/${c}-${DATE}.sql.gz.gpg"
  if [ ! -r "$PUB" ]; then echo "FAIL $c (暗号化の公開鍵がない)"; rc=1; continue; fi
  gh=$(mktemp -d /run/db-backup-gpg.XXXXXX)
  ssh -i "$key" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=20 \
      -o UserKnownHostsFile=/home/debian/.ssh/known_hosts "$dest" </dev/null 2>/dev/null \
    | gpg --homedir "$gh" --batch --quiet --trust-model always --recipient-file "$PUB" --encrypt -o "$f.tmp"
  st=("${PIPESTATUS[@]}"); rm -rf "$gh"
  # 暗号化前の大きさは分からないので、空の出力(数百バイトの暗号文)を失敗とみなす
  if [ "${st[0]}" -eq 0 ] && [ "${st[1]}" -eq 0 ] && [ "$(stat -c %s "$f.tmp" 2>/dev/null || echo 0)" -gt 1024 ]; then
    mv -f "$f.tmp" "$f"; chmod 600 "$f"
    echo "OK   $c -> $(basename "$f") ($(du -h "$f" | cut -f1))"
  else
    rm -f "$f.tmp"; echo "FAIL $c (ssh=${st[0]} gpg=${st[1]})"; rc=1
  fi
  find "$OUT" -maxdepth 1 -name "${c}-*.sql.gz.gpg" -mtime +"$KEEP_DAYS" -delete 2>/dev/null
done
exit $rc
