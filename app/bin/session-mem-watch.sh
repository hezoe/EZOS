#!/usr/bin/env bash
# EZOS セッション・メモリ早期警告
# ------------------------------------------------------------------
# 目的: EZOS(ezos.service cgroup)内で動く Claude Code セッションが
#   肥大化して cgroup ハードキャップ(MemoryMax)で強制終了される「前」に、
#   肥大セッションを ntfy で通知し、/next での圧縮やセッション終了を促す。
#   (2026-09-10 の OOM: 1本のセッションが 2.7GB まで膨張し全体枯渇→OOM した件の再発防止 #3)
#
# 監視:
#   (A) 単一 claude セッションの RSS が THRESHOLD_MB 超
#   (B) ezos.service cgroup の memory.current が memory.max の CGROUP_PCT% 超
# 通知はPID/種別ごとに COOLDOWN 秒に1回まで(スパム防止)。
# ntfy設定は /etc/vps-healthcheck.conf を再利用(NTFY_URL / NTFY_TOPIC)。root(cron)で実行。
set -u

THRESHOLD_MB=${THRESHOLD_MB:-1600}     # 単一セッション警告閾値(MB)。MemoryMax=2.5GBより十分手前
CGROUP_PCT=${CGROUP_PCT:-88}           # cgroup使用率警告閾値(%)
COOLDOWN=${COOLDOWN:-21600}            # 同一対象の再通知間隔(秒) 6h
CONF=/etc/vps-healthcheck.conf
STATE_DIR=/var/lib/ezos
STATE=$STATE_DIR/session-mem-watch.state
CG=/sys/fs/cgroup/system.slice/ezos.service

mkdir -p "$STATE_DIR"; touch "$STATE" 2>/dev/null

# --- ntfy 設定読込 ---
NTFY_URL="https://ntfy.sh"; NTFY_TOPIC=""
if [ -r "$CONF" ]; then
  v=$(grep -E '^NTFY_URL=' "$CONF" | tail -1 | cut -d= -f2- | tr -d '"'"'"' ' ); [ -n "$v" ] && NTFY_URL="$v"
  NTFY_TOPIC=$(grep -E '^NTFY_TOPIC=' "$CONF" | tail -1 | cut -d= -f2- | tr -d '"'"'"' ' )
fi

now=$(date +%s)

# 対象キーが COOLDOWN 内に通知済みなら 1 を返す
recently_notified() {
  local key=$1 last
  last=$(grep -E "^${key}=" "$STATE" 2>/dev/null | tail -1 | cut -d= -f2)
  [ -n "$last" ] && [ $(( now - last )) -lt "$COOLDOWN" ]
}
mark_notified() {
  local key=$1
  grep -vE "^${key}=" "$STATE" 2>/dev/null > "$STATE.tmp" || true
  echo "${key}=${now}" >> "$STATE.tmp"; mv "$STATE.tmp" "$STATE"
}

send_ntfy() {  # $1=title $2=tags $3=priority $4=body
  if [ -z "$NTFY_TOPIC" ]; then
    echo "[session-mem-watch] NTFY_TOPIC未設定→送信スキップ:"; echo "$4"; return
  fi
  curl -s -m 15 \
    -H "Title: $1" -H "Tags: $2" -H "Priority: $3" \
    --data-binary "$4" "$NTFY_URL/$NTFY_TOPIC" >/dev/null \
    && echo "[session-mem-watch] ntfy送信: $1" \
    || echo "[session-mem-watch] ntfy送信失敗: $1"
}

# --- (A) 単一セッションの肥大検知 ---
# ps: pid rss(KB) etimes(s) comm  ／ comm が正確に "claude" のもの
while read -r pid rss etimes comm; do
  [ "$comm" = "claude" ] || continue
  mb=$(( rss / 1024 ))
  if [ "$mb" -ge "$THRESHOLD_MB" ]; then
    key="pid${pid}"
    recently_notified "$key" && continue
    days=$(( etimes / 86400 )); hours=$(( (etimes % 86400) / 3600 ))
    body=$(printf 'EZOSのClaudeセッションが肥大化しています。\n\nPID: %s\nRSS: %d MB (閾値 %d MB)\n経過: %d日%d時間\n\nMemoryMax=2.5GB に達すると EZOS内でOOM強制終了されます。\n該当セッションで /next による圧縮、または不要なら終了をご検討ください。' \
      "$pid" "$mb" "$THRESHOLD_MB" "$days" "$hours")
    send_ntfy "⚠ EZOSセッション肥大 ${mb}MB (PID ${pid})" "warning,brain" "4" "$body"
    mark_notified "$key"
  fi
done < <(ps -eo pid=,rss=,etimes=,comm= 2>/dev/null)

# --- (B) cgroup 全体の逼迫検知 ---
cur=$(cat "$CG/memory.current" 2>/dev/null); max=$(cat "$CG/memory.max" 2>/dev/null)
if [ -n "${cur:-}" ] && [ -n "${max:-}" ] && [ "$max" != "max" ]; then
  pct=$(( cur * 100 / max ))
  if [ "$pct" -ge "$CGROUP_PCT" ]; then
    key="cgroup"
    if ! recently_notified "$key"; then
      body=$(printf 'EZOS(ezos.service)のメモリ使用が上限に接近しています。\n\n使用: %d MB / 上限 %d MB (%d%%)\n\n上限到達で EZOS内のプロセスがOOM強制終了されます(他サービスは保護)。不要セッションの終了/圧縮をご検討ください。' \
        "$(( cur/1048576 ))" "$(( max/1048576 ))" "$pct")
      send_ntfy "⚠ EZOSメモリ逼迫 ${pct}%" "warning" "4" "$body"
      mark_notified "$key"
    fi
  fi
fi
