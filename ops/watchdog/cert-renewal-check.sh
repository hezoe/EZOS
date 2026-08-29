#!/bin/bash
# 設定した CERTRENEW_HOST の証明書が、予定した更新窓の間に更新されたかを確認して ntfy 通知する。
# CERTRENEW_* を service-watchdog.conf で設定し、更新窓は cert-renewal-check.timer(OnCalendar)で指定する。
#  - notAfter が基準(更新前の期限。install時に記録)より先に進めば「更新成功」を1回通知して以後no-op。
#  - 窓の最終日(CERTRENEW_LASTDAY)まで未更新なら「要確認」を高優先で通知。
# ntfy 設定は service-watchdog.conf を再利用。
set -u
CONF="${1:-/etc/service-watchdog.conf}"
[ -r "$CONF" ] && . "$CONF"
: "${NTFY_URL:=https://ntfy.sh}"
: "${NTFY_TOPIC:?NTFY_TOPIC 未設定}"
HOSTC="${CERTRENEW_HOST:-}"
[ -z "$HOSTC" ] && exit 0     # CERTRENEW_HOST 未設定なら無効
SD="${STATE_DIR:-/var/lib/service-watchdog}"
BASE="$SD/certrenew_${HOSTC}.baseline"
DONE="$SD/certrenew_${HOSTC}.done"
LASTDAY="${CERTRENEW_LASTDAY:-09-13}"    # 窓最終日(MM-DD)
HS="$(hostname -s 2>/dev/null || hostname)"
stamp(){ date '+%F %T %Z'; }
notify(){ curl -s -m 8 -H "Title: $1" -H "Priority: ${3:-default}" -H "Tags: ${4:-lock}" --data-binary "$2" "$NTFY_URL/$NTFY_TOPIC" >/dev/null 2>&1; }

mkdir -p "$SD"
[ -f "$DONE" ] && exit 0      # 既に更新確認済み

end="$(echo | timeout 10 openssl s_client -servername "$HOSTC" -connect "$HOSTC:443" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
if [ -z "$end" ]; then
  notify "cert-renew: $HOSTC 取得失敗" "⚠ $HOSTC の証明書/接続の取得に失敗しました。手動確認してください。
$(stamp) $HS" high rotating_light
  exit 0
fi
now_end="$(date -d "$end" +%s 2>/dev/null || echo 0)"
[ -f "$BASE" ] || echo "$now_end" > "$BASE"      # 未記録なら現在値を基準に(フォールバック)
base="$(cat "$BASE" 2>/dev/null || echo 0)"

if [ "$now_end" -gt "$base" ]; then
  days=$(( (now_end - $(date +%s)) / 86400 ))
  notify "cert-renew: $HOSTC ✅更新確認" \
"✅ $HOSTC の証明書が更新されました。新しい有効期限: $end (残り約${days}日)。
Caddy の自動更新は正常に動作しています。
$(stamp) $HS" default white_check_mark
  touch "$DONE"
  exit 0
fi

# 未更新: 窓最終日なら要確認を通知(それ以外の日はまだ更新待ちなので静か)
if [ "$(date +%m-%d)" = "$LASTDAY" ]; then
  days=$(( (now_end - $(date +%s)) / 86400 ))
  notify "cert-renew: $HOSTC ⚠未更新" \
"⚠ 更新窓を過ぎても $HOSTC の証明書更新が確認できません。現行の期限は $end (残り約${days}日)。
Caddy のログ(docker logs saas-caddy | grep -i acme)を確認してください。
$(stamp) $HS" high rotating_light
fi
exit 0
