#!/bin/sh
# pvcount の設置(2026-11-19)。sudo sh /home/debian/EZOS/ops/pvcount/install.sh
# 1) 本体と systemd を置いて起動  2) Caddy のコンテナ(172.18.0.250)から 3105 に届くよう INPUT を許可
# Caddy の stats.caddy は DNS(stats.ezoe.net の A レコード)ができてから別に置く(README)。
set -eu
[ "$(id -u)" -eq 0 ] || { echo "sudo で実行してください" >&2; exit 1; }
D=$(cd "$(dirname "$0")" && pwd)

install -m 755 -o root -g root "$D/pvcount.py" /usr/local/bin/pvcount.py
install -m 644 -o root -g root "$D/pvcount.service" /etc/systemd/system/pvcount.service
systemctl daemon-reload
systemctl enable --now pvcount.service

# 起動時のファイアウォール(catvpn-hub-firewall.sh)の Caddy→ホストの許可ポートに 3105 を足す
FW=/usr/local/sbin/catvpn-hub-firewall.sh
if [ -f "$FW" ] && ! grep -q '3104,3105' "$FW"; then
  cp -p "$FW" "$FW.bak-$(date +%Y%m%d-%H%M%S)"
  sed -i 's/--dports 3002,3101,3102,3103,3104,18080/--dports 3002,3101,3102,3103,3104,3105,18080/' "$FW"
fi
# 今動いている規則にも足す(再起動を待たない)
if ! iptables -C INPUT -i br-+ -s 172.18.0.250 -p tcp --dport 3105 -j ACCEPT 2>/dev/null; then
  n=$(iptables -L INPUT --line-numbers -n | awk '/172.18.0.250/ && /3104/ {print $1; exit}')
  iptables -I INPUT "${n:-1}" -i br-+ -s 172.18.0.250 -p tcp --dport 3105 -j ACCEPT
fi

sleep 1
systemctl is-active pvcount.service
curl -s -o /dev/null -w 'healthz %{http_code}\n' http://127.0.0.1:3105/healthz
echo "設置しました。DNS ができたら README の手順で stats.caddy を置いてください。"
