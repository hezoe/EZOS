#!/bin/bash
# EZOS 追加策 A (2026-11-13): Node.js 本体が更新されたあと、古い node で動き続けているサービスを
# 夜間(node-refresh.timer・04:30)にまとめて再起動する。unattended-upgrades は nodejs を入れ替えるだけで
# 動いているプロセスは古いバイナリのままなので、これが無いと更新が効かない。
#  - /usr/bin/node の更新時刻より前に起動したサービスだけを再起動する(毎晩の無駄な再起動はしない)
#  - ezos は KillMode=process なので tmux の中の作業は残る(ブラウザは自動で再接続)
#  - ogn-web は日中の再起動を避ける運用のため、この時刻(日の出前)に限って行う
# ntfy 設定は service-watchdog.conf を再利用。
set -u
CONF="${1:-/etc/service-watchdog.conf}"
[ -r "$CONF" ] && . "$CONF"
: "${NTFY_URL:=https://ntfy.sh}"
: "${NTFY_TOPIC:=}"
UNITS="${NODE_REFRESH_UNITS:-ezos navlog notam navlog-swim-recv ogn-web takikawa-web}"
HS="$(hostname -s 2>/dev/null || hostname)"
notify(){ [ -n "$NTFY_TOPIC" ] || return 0; curl -s -m 8 -H "Title: $1" -H "Priority: ${3:-default}" -H "Tags: ${4:-arrows_counterclockwise}" --data-binary "$2" "$NTFY_URL/$NTFY_TOPIC" >/dev/null 2>&1; }

NODE="$(readlink -f /usr/bin/node 2>/dev/null)"
[ -x "$NODE" ] || { echo "node が見つかりません"; exit 0; }
nmt="$(stat -c %Y "$NODE")"
restarted=(); failed=()
for u in $UNITS; do
  systemctl is-active -q "$u" || continue
  ts="$(systemctl show -p ActiveEnterTimestamp --value "$u" 2>/dev/null)"
  st="$(date -d "$ts" +%s 2>/dev/null || echo 0)"
  [ "$nmt" -gt "$st" ] || continue
  if systemctl restart "$u"; then restarted+=("$u"); else failed+=("$u"); fi
done
if [ ${#restarted[@]} -eq 0 ] && [ ${#failed[@]} -eq 0 ]; then
  echo "node $("$NODE" --version): 再起動が要るサービスはありません"
  exit 0
fi
msg="Node.js $("$NODE" --version) への切り替えのため再起動: ${restarted[*]:-なし}"
[ ${#failed[@]} -gt 0 ] && msg="$msg
⚠ 再起動に失敗: ${failed[*]}"
echo "$msg"
if [ ${#failed[@]} -gt 0 ]; then notify "node-refresh: 要確認" "$msg
$(date '+%F %T %Z') $HS" high rotating_light
else notify "node-refresh: 再起動" "$msg
$(date '+%F %T %Z') $HS"; fi
