#!/bin/bash
# service-watchdog インストーラ(要root)。EZOS/ops/watchdog の正本を system パスへ設置し、timerを有効化する。
set -eu
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ "$(id -u)" -eq 0 ] || { echo "root で実行してください: sudo $0" >&2; exit 1; }

install -m 0755 "$SRC/service-watchdog.sh" /usr/local/bin/service-watchdog.sh
# 設定は既存を上書きしない(初回のみ example から生成)。監視対象を編集済みでも壊さないため。
if [ ! -e /etc/service-watchdog.conf ]; then
  install -m 0644 "$SRC/service-watchdog.conf.example" /etc/service-watchdog.conf
  echo "設置(要編集): /etc/service-watchdog.conf ← example から生成。監視対象/ntfy等を実値に編集すること"
else
  echo "既存 /etc/service-watchdog.conf は保持(更新は手動で)"
fi
install -m 0644 "$SRC/service-watchdog.service" /etc/systemd/system/service-watchdog.service
install -m 0644 "$SRC/service-watchdog.timer"   /etc/systemd/system/service-watchdog.timer
mkdir -p /var/lib/service-watchdog

# DBバックアップ(毎晩)
install -m 0755 "$SRC/db-backup.sh" /usr/local/bin/db-backup.sh
install -m 0644 "$SRC/db-backup.service" /etc/systemd/system/db-backup.service
install -m 0644 "$SRC/db-backup.timer"   /etc/systemd/system/db-backup.timer
mkdir -p /var/backups/db && chmod 700 /var/backups/db

# 証明書更新の見届け(任意): CERTRENEW_HOST が設定されていれば有効化し、更新前の期限を基準記録
CRHOST="$( . /etc/service-watchdog.conf 2>/dev/null || true; printf '%s' "${CERTRENEW_HOST:-}" )"
install -m 0755 "$SRC/cert-renewal-check.sh" /usr/local/bin/cert-renewal-check.sh
install -m 0644 "$SRC/cert-renewal-check.service" /etc/systemd/system/cert-renewal-check.service
install -m 0644 "$SRC/cert-renewal-check.timer"   /etc/systemd/system/cert-renewal-check.timer
if [ -n "$CRHOST" ]; then
  BASE="/var/lib/service-watchdog/certrenew_${CRHOST}.baseline"
  if [ ! -f "$BASE" ]; then
    END="$(echo | timeout 10 openssl s_client -servername "$CRHOST" -connect "$CRHOST:443" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
    [ -n "$END" ] && date -d "$END" +%s > "$BASE" && echo "基準期限を記録: $CRHOST $END"
  fi
fi

systemctl daemon-reload
systemctl enable --now service-watchdog.timer
systemctl enable --now db-backup.timer
[ -n "$CRHOST" ] && systemctl enable cert-renewal-check.timer
echo "有効化完了。次のタイマ起動から監視開始:"
systemctl status service-watchdog.timer --no-pager | head -4
systemctl status db-backup.timer --no-pager | head -3
