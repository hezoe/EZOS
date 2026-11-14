#!/bin/bash
# secguard のインストーラ(要 root)。EZOS/ops/secguard の正本を system パスへ設置して有効化する。
# 防火壁の記録(SECGUARD-*)と遮断リスト(ipset secguard-ban)は catvpn-hub-firewall.sh 側にある。
# Caddy のアクセス記録の共通設定は saas/caddy/sites/00-access-log.caddy。
set -eu
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ "$(id -u)" -eq 0 ] || { echo "root で実行してください: sudo $0" >&2; exit 1; }
for p in ipset auditd; do dpkg -s "$p" >/dev/null 2>&1 || DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$p"; done

install -m 0755 "$SRC/secguard.py"            /usr/local/sbin/secguard.py
install -m 0755 "$SRC/secguard-release"       /usr/local/sbin/secguard-release
install -m 0755 "$SRC/secguard-logbudget.sh"  /usr/local/sbin/secguard-logbudget.sh
for u in secguard.service secguard-logbudget.service secguard-logbudget.timer; do
  install -m 0644 "$SRC/$u" "/etc/systemd/system/$u"
done
sed -i "s|^Documentation=file:.*|Documentation=file:$SRC/README.md|" /etc/systemd/system/secguard.service

# auditd: 公開サービスの専用ユーザーと docker の flightlog(1001)/postgres(70)の実行・管理者の設定の書き換え
rules=""
for who in ogn navlog notam takikawa 1001 70; do
  uid=$(id -u "$who" 2>/dev/null || echo "$who"); [ "$uid" -eq "$uid" ] 2>/dev/null || continue
  rules+="-a always,exit -F arch=b64 -S execve,execveat -F uid=$uid -k sg_exec"$'\n'
  rules+="-a always,exit -F arch=b32 -S execve,execveat -F uid=$uid -k sg_exec"$'\n'
done
awk -v r="$rules" '{ if ($0=="@SG_EXEC_RULES@") printf "%s", r; else print }' "$SRC/50-secguard.rules" > /etc/audit/rules.d/50-secguard.rules
chmod 0640 /etc/audit/rules.d/50-secguard.rules
install -m 0640 "$SRC/99-secguard-enable.rules" /etc/audit/rules.d/99-secguard-enable.rules
sh "$SRC/auditd-secguard.sh"
augenrules --load >/dev/null
kill -HUP "$(pidof auditd)" 2>/dev/null || true   # auditd.conf を読み直す(auditd は systemctl restart を拒む)

# journald: 400MB・90 日
install -d /etc/systemd/journald.conf.d
install -m 0644 "$SRC/zz-secguard-journald.conf" /etc/systemd/journald.conf.d/zz-secguard.conf
systemctl restart systemd-journald

# 隔離中は起動しない(ConditionPathExists)。group=隔離の名前
add_cond() { d="/etc/systemd/system/$1.service.d"; install -d "$d"; sed "s|@GROUP@|$2|" "$SRC/90-secguard.conf" > "$d/90-secguard.conf"; }
for u in ogn-web ogn-collect ogn-web-drone ogn-web-dropzones ogn-web-amedas ogn-web-wind ogn-notify-receivers; do add_cond "$u" ogn; done
add_cond navlog navlog; add_cond notam notam; add_cond takikawa-web takikawa

install -d -m 0711 /var/lib/secguard; install -d -m 0755 /var/lib/secguard/quarantine
if [ ! -f /etc/secguard.conf ]; then
  sed "s|^LEARN_UNTIL=0|LEARN_UNTIL=$(( $(date +%s) + 48*3600 ))|" "$SRC/secguard.conf.example" > /etc/secguard.conf
  chmod 0600 /etc/secguard.conf
fi
systemctl daemon-reload
systemctl enable --now secguard.service secguard-logbudget.timer
systemctl restart secguard.service
echo "有効化完了:"; systemctl --no-pager -n 0 status secguard.service | head -3; auditctl -l | grep -c sg_ | sed 's/^/auditd 規則 sg_*: /'
