#!/bin/bash
# secwatch のインストーラ(要 root)。EZOS/ops/secwatch の正本を system パスへ設置し timer を有効化する。
set -eu
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ "$(id -u)" -eq 0 ] || { echo "root で実行してください: sudo $0" >&2; exit 1; }
command -v debsecan >/dev/null || { echo "debsecan を入れます"; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq debsecan; }
# debsecan 既定の日次メール(root 宛・配送先なし)は止める。照合は secwatch が行う
[ -f /etc/default/debsecan ] && sed -i 's/^REPORT=true/REPORT=false/' /etc/default/debsecan
install -m 0755 "$SRC/secwatch.py"      /usr/local/bin/secwatch.py
install -m 0644 "$SRC/secwatch.service" /etc/systemd/system/secwatch.service
install -m 0644 "$SRC/secwatch.timer"   /etc/systemd/system/secwatch.timer
sed -i "s|^Documentation=file:.*|Documentation=file:$SRC/README.md|" /etc/systemd/system/secwatch.service
install -d -m 0755 -o debian -g debian /var/lib/secwatch
[ -f /etc/secwatch.env ] || cat > /etc/secwatch.env <<'EOF'
# secwatch の設定(無ければ既定)。SECWATCH_AUTO_APT=0 で自動 apt を止める、SECWATCH_CLAUDE=0 で無人調査を止める
SECWATCH_AUTO_APT=1
SECWATCH_CLAUDE=1
EOF
systemctl daemon-reload
systemctl enable --now secwatch.timer
echo "有効化完了:"; systemctl list-timers 'secwatch*' --no-pager | head -3
