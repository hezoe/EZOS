#!/bin/bash
# remote-host-watch: 別ホスト(例: JP1)を EZOS の VPS から見張る(2026-11-19)。
#   - VPN(WireGuard)のつながり・SSH で届くか
#   - 相手の入口(authorized_keys の command= で「状態を出す/決めたユニットを再起動する」だけに絞った鍵)で
#     サービス・failed ユニット・ディスク・メモリ・相手側の DB バックアップの鮮度
#   - 公開 URL の L7(HTTP ステータス・本文)
# 連続 FAIL_THRESHOLD 回の異常で ntfy に 1 回知らせ、ユニット/URL に対応するユニットは相手の入口で再起動する
# (同じユニットは相手側で 15 分に 1 回まで)。異常が続けば REMIND_SEC ごとに念押し、戻れば回復を知らせる。
# 設置: /usr/local/bin/remote-host-watch.sh (root) / 設定: /etc/remote-host-watch.conf(実値・非公開)
set -u

CONF="${1:-/etc/remote-host-watch.conf}"
# shellcheck source=/dev/null
[ -r "$CONF" ] && . "$CONF" || { echo "conf読込失敗: $CONF" >&2; exit 1; }
# 通知先は service-watchdog と同じ
# shellcheck source=/dev/null
[ -z "${NTFY_TOPIC:-}" ] && [ -r /etc/service-watchdog.conf ] && . <(grep -E '^NTFY_(URL|TOPIC)=' /etc/service-watchdog.conf)
: "${NTFY_URL:=https://ntfy.sh}"; : "${NTFY_TOPIC:?}"
: "${STATE_DIR:=/var/lib/remote-host-watch}"; : "${FAIL_THRESHOLD:=3}"; : "${REMIND_SEC:=21600}"
: "${CURL_TIMEOUT:=10}"; : "${WG_STALE_SEC:=180}"
: "${DISK_WARN_PCT:=90}"; : "${MEM_AVAIL_WARN_MB:=200}"; : "${BACKUP_MAX_AGE_SEC:=93600}"
mkdir -p "$STATE_DIR"; chmod 700 "$STATE_DIR"
now() { date +%s; }
stamp() { date '+%F %T %Z'; }
log() { echo "[$(stamp)] $*"; }

notify() {
  local title="$1" body="$2" prio="${3:-default}" tags="${4:-warning}"
  curl -s -m 8 -H "Title: $title" -H "Priority: $prio" -H "Tags: $tags" \
    --data-binary "$body" "$NTFY_URL/$NTFY_TOPIC" >/dev/null 2>&1
}

# agent <user@host> <鍵> <コマンド...>: 相手の入口を呼ぶ
agent() {
  local dest="$1" key="$2"; shift 2
  timeout 30 ssh -i "$key" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 \
    -o UserKnownHostsFile=/home/debian/.ssh/known_hosts "$dest" "$*" </dev/null 2>/dev/null
}

# item <名前> <キー> <異常 0/1> <何が> <詳細> [再起動するユニット]
item() {
  local hn="$1" key="$1-$2" bad="$3" what="$4" det="$5" unit="${6:-}"
  local cf="$STATE_DIR/$key.count" af="$STATE_DIR/$key.alert" c last
  if [ "$bad" = 0 ]; then
    echo 0 > "$cf"
    if [ -e "$af" ]; then
      rm -f "$af"; log "RECOVERED $key ($det)"
      notify "remote-watch: $hn $2 OK" "✅ $hn: $what が回復しました。($det)
$(stamp)" default white_check_mark
    fi
    return
  fi
  c=$(( $(cat "$cf" 2>/dev/null || echo 0) + 1 )); echo "$c" > "$cf"
  log "FAIL $key ($det) 連続$c/$FAIL_THRESHOLD"
  [ "$c" -ge "$FAIL_THRESHOLD" ] || return
  if [ -e "$af" ]; then
    last=$(cat "$af" 2>/dev/null || echo 0)
    [ $(( $(now) - last )) -ge "$REMIND_SEC" ] || return
    now > "$af"
    notify "remote-watch: $hn $2 still DOWN" "🔴 $hn: $what がまだ異常です。($det)
$(stamp)" high rotating_light
    return
  fi
  local extra=""
  if [ -n "$unit" ] && [ "$REACH" = 1 ]; then
    extra="
自動で $unit を再起動しました: $(agent "$DEST" "$KEY" restart "$unit" | head -1)"
    log "ACTION $key restart $unit"
  fi
  now > "$af"
  notify "remote-watch: $hn $2 DOWN" "🔴 $hn: $what が異常です($FAIL_THRESHOLD 回連続)。($det)$extra
$(stamp)" high rotating_light
}

wg_age() {   # wg_age <IF> <公開鍵>: 最後のハンドシェイクからの秒数(-1=なし)
  local t; t=$(wg show "$1" latest-handshakes 2>/dev/null | awk -v k="$2" '$1 == k { print $2 }')
  [ -n "$t" ] && [ "$t" != 0 ] && echo $(( $(now) - t )) || echo -1
}

for rec in "${REMOTE_HOSTS[@]}"; do
  IFS='|' read -r HN DEST KEY WGIF WGPUB RESTARTABLE <<< "$rec"
  age=$(wg_age "$WGIF" "$WGPUB")
  wgdet="VPN の最後の通信 ${age}秒前"; [ "$age" -lt 0 ] && wgdet="VPN の通信なし"
  wgbad=0; { [ "$age" -lt 0 ] || [ "$age" -gt "$WG_STALE_SEC" ]; } && wgbad=1
  item "$HN" vpn "$wgbad" "VPN のつながり" "$wgdet"

  st=$(agent "$DEST" "$KEY" status); REACH=0
  grep -q '^uptime ' <<< "$st" && REACH=1
  item "$HN" ssh $(( 1 - REACH )) "SSH(監視の入口)" "$wgdet"

  if [ "$REACH" = 1 ]; then
    while read -r _ u s; do
      r=""; case " $RESTARTABLE " in *" $u "*) r="$u" ;; esac
      item "$HN" "unit-$u" "$([ "$s" = active ] && echo 0 || echo 1)" "サービス $u" "is-active=$s" "$r"
    done < <(grep '^unit ' <<< "$st")
    f=$(awk '/^failed / { $1=""; sub(/^ /,""); print }' <<< "$st")
    item "$HN" failed "$([ "$f" = - ] && echo 0 || echo 1)" "systemd の failed ユニット" "${f}"
    while read -r _ m p; do
      item "$HN" "disk$(tr '/' '_' <<< "$m")" "$([ "$p" -ge "$DISK_WARN_PCT" ] && echo 1 || echo 0)" "ディスク $m" "使用 ${p}%"
    done < <(grep '^disk ' <<< "$st")
    read -r _ ma sw < <(grep '^mem ' <<< "$st")
    item "$HN" mem "$([ "${ma:-9999}" -lt "$MEM_AVAIL_WARN_MB" ] && echo 1 || echo 0)" "空きメモリ" "空き ${ma}MB・スワップ ${sw}%"
    ba=$(awk '/^backup_age / { print $2 }' <<< "$st")
    item "$HN" backup "$({ [ "${ba:--1}" -lt 0 ] || [ "$ba" -ge "$BACKUP_MAX_AGE_SEC" ]; } && echo 1 || echo 0)" \
      "相手側の DB バックアップ" "$([ "${ba:--1}" -lt 0 ] && echo なし || echo "最新は約$(( ba / 3600 ))時間前")"
    # 再起動待ちの更新は異常ではないので、出たときに 1 回だけ知らせる
    rf="$STATE_DIR/$HN-reboot.notified"
    if grep -q '^reboot_required 1' <<< "$st"; then
      [ -e "$rf" ] || { : > "$rf"; notify "remote-watch: $HN reboot pending" "ℹ $HN: 再起動を待っている更新があります(カーネル等)。都合のよい時間に再起動してください。
$(stamp)" low information_source; }
    else rm -f "$rf"; fi
  fi
done

# 公開 URL の L7: "名前|キー|URL|最小|最大|本文に含む文字(空=見ない)|異常時に再起動するユニット"
for rec in "${REMOTE_HTTP[@]}"; do
  IFS='|' read -r HN k url smin smax sub unit <<< "$rec"
  for h in "${REMOTE_HOSTS[@]}"; do
    [ "${h%%|*}" = "$HN" ] && IFS='|' read -r _ DEST KEY _ _ _ <<< "$h"
  done
  REACH=0; [ "$(cat "$STATE_DIR/$HN-ssh.count" 2>/dev/null || echo 1)" = 0 ] && REACH=1
  bf=$(mktemp); code=$(curl -s -o "$bf" -m "$CURL_TIMEOUT" -w '%{http_code}' "$url" 2>/dev/null); code=$((10#${code:-0}))
  ok=1; [ "$code" -ge "$smin" ] && [ "$code" -le "$smax" ] || ok=0
  [ -n "$sub" ] && ! grep -qF -- "$sub" "$bf" && ok=0
  rm -f "$bf"
  item "$HN" "http-$k" $(( 1 - ok )) "$url" "status=$code" "$unit"
done
exit 0
