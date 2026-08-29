#!/bin/bash
# EZOS サーバ状態ダッシュボード。稼働サービス(systemd active + L7 HTTP) と CPU/メモリ/スワップ/ディスク/ロードを
# 1画面の見やすい一覧で出力する。依存: coreutils/systemctl/curl のみ。非root想定(docker psは可能な時だけ使用)。
# 監視対象は service-watchdog の設定を再利用(DRY)。ANSIカラーは使わず絵文字＋整列テキスト(Claude経由の再表示でも崩れない)。
set -u
WD_CONF="/etc/service-watchdog.conf"
HOST="$(hostname -s 2>/dev/null || hostname)"
NOW="$(date '+%F %H:%M %Z')"
CORES="$(nproc 2>/dev/null || echo 1)"

# CPU計測スナップショット1(この後の各種チェックが自然な計測区間になる=sleep不要)
cpu_snap() {
  local cpu user nice sys idle iowait irq softirq steal rest
  read -r cpu user nice sys idle iowait irq softirq steal rest < /proc/stat
  echo "$((idle+iowait)) $((user+nice+sys+idle+iowait+irq+softirq+steal))"
}
CS1=($(cpu_snap))

# --- 監視対象サービスの読み込み(無ければ既定) ---
if [ -r "$WD_CONF" ]; then . "$WD_CONF"; fi
if ! declare -p SERVICES >/dev/null 2>&1 || [ "${#SERVICES[@]}" -eq 0 ]; then
  SERVICES=(
    "ezos|http|http://127.0.0.1:3101/|200|200|EZOS|systemctl restart ezos"
    "navlog|http|http://127.0.0.1:3102/|200|200|NAVLOG|systemctl restart navlog"
    "feeldscope|http|http://127.0.0.1:3000/|200|200|FEELDSCOPE|systemctl restart feeldscope-webapp"
    "takikawa|http|http://127.0.0.1:3002/|200|200||systemctl restart takikawa-web"
    "adsb-poller|systemd|adsb-poller|0|0||systemctl restart adsb-poller"
  )
fi

# --- 各サービスの systemd 状態と L7 応答を採取(この処理時間がCPU計測区間になる) ---
rows=""
okc=0; ngc=0
for rec in "${SERVICES[@]}"; do
  IFS='|' read -r nm kd tg mn mx sb rs <<< "$rec"
  unit=""; dtype=""
  case "$rs" in
    "systemctl restart "*) unit="${rs#systemctl restart }"; dtype="systemd";;
    "docker restart "*)    unit="${rs#docker restart }";   dtype="docker";;
  esac
  sd="-"
  [ "$dtype" = systemd ] && sd="$(systemctl is-active "$unit" 2>/dev/null || echo unknown)"
  [ "$dtype" = docker ]  && sd="docker"
  l7="-"; healthy=1
  if [ "$kd" = http ]; then
    code="$(curl -s -o /tmp/.ezstatus.$$ -m 3 -w '%{http_code}' "$tg" 2>/dev/null)"; code=$((10#${code:-0}))
    l7="$code"
    { [ "$code" -ge "${mn:-0}" ] && [ "$code" -le "${mx:-0}" ]; } || healthy=0
    if [ -n "$sb" ] && ! grep -qF -- "$sb" /tmp/.ezstatus.$$ 2>/dev/null; then healthy=0; l7="$code!"; fi
    rm -f /tmp/.ezstatus.$$
  else
    [ "$sd" = active ] || healthy=0
  fi
  [ "$dtype" = systemd ] && [ "$sd" != active ] && healthy=0
  if [ "$healthy" = 1 ]; then mark="✅"; okc=$((okc+1)); else mark="🔴"; ngc=$((ngc+1)); fi
  rows+="$(printf ' %s  %-18s %-10s %s\n' "$mark" "$nm" "$sd" "$l7")"$'\n'
done

# CPU計測スナップショット2 → 使用率%
CS2=($(cpu_snap))
di=$(( ${CS2[0]} - ${CS1[0]} )); dt=$(( ${CS2[1]} - ${CS1[1]} ))
cpu=0; [ "$dt" -gt 0 ] && cpu=$(( (100*(dt-di))/dt )); [ "$cpu" -lt 0 ] && cpu=0

# --- メモリ / スワップ / ロード / uptime ---
memline="$(free -m | awk '/^Mem:/{printf "%.1fG / %.1fG  (%d%%)", $3/1024, $2/1024, ($3/$2)*100+0.5}')"
mempct="$(free | awk '/^Mem:/{printf "%d", ($3/$2)*100+0.5}')"
swapline="$(free -m | awk '/^Swap:/{ if($2==0){print "なし"} else {printf "%.1fG / %.1fG (%d%%)", $3/1024,$2/1024,($3/$2)*100+0.5} }')"
load="$(cut -d' ' -f1-3 /proc/loadavg)"
up="$(uptime -p 2>/dev/null | sed 's/^up //')"; [ -z "$up" ] && up="?"

# 使用率バー(幅20, 絵文字なし)
bar() { local p="$1" w=20 f i s=""; f=$(( p*w/100 )); [ "$f" -gt "$w" ] && f=$w; [ "$f" -lt 0 ] && f=0
  for ((i=0;i<w;i++)); do [ "$i" -lt "$f" ] && s+="█" || s+="·"; done; printf '%s' "$s"; }

# --- ディスク(/ と主要マウント) ---
disk="$(df -h --output=target,size,used,avail,pcent -x tmpfs -x devtmpfs -x overlay 2>/dev/null \
  | awk 'NR>1 && ($1=="/" || $1 ~ /^\/(data|var|home|mnt|srv)/) {printf "   %-8s %s/%s 使用 (%s, 残%s)\n",$1,$3,$2,$5,$4}')"

# --- watchdog 未解決インシデント ---
inc=""
if ls /var/lib/service-watchdog/*.incident >/dev/null 2>&1; then
  for f in /var/lib/service-watchdog/*.incident; do inc+=" $(basename "$f" .incident)"; done
fi

# ================= 出力 =================
line="────────────────────────────────────────────────"
printf '%s\n'   "══════════════════════════════════════════════════"
printf '  🖥  EZOS サーバ状態   %s   %s\n' "$HOST" "$NOW"
printf '%s\n'   "══════════════════════════════════════════════════"
printf '  Uptime  %s\n' "$up"
printf '  Load    %s   (%s cores)\n' "$load" "$CORES"
printf '  CPU     %s %3d%%\n' "$(bar "$cpu")" "$cpu"
printf '  Mem     %s %3d%%   %s\n' "$(bar "$mempct")" "$mempct" "$memline"
printf '  Swap    %s\n' "$swapline"
printf '  Disk\n%s\n' "$disk"
printf '%s\n' "$line"
printf '  サービス (%d OK / %d NG)          systemd     L7\n' "$okc" "$ngc"
printf '%s' "$rows"
if [ -n "$inc" ]; then printf '%s\n  ⚠ watchdog未解決:%s\n' "$line" "$inc"; fi
printf '%s\n' "══════════════════════════════════════════════════"
