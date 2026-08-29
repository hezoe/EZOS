#!/bin/bash
# service-watchdog: 各公開サービスを L7(HTTPステータス＋内容照合) / 常駐は systemd active で監視し、
# 連続失敗したサービスだけを個別に再起動する。再起動を実施したら復旧の成否に関わらず ntfy 通知する。
# 既存 vps-healthcheck(インフラ層/OS再起動)とは役割分担: こちらは L7・サービス個別層のみ。OS等には触れない。
#
# 設置: /usr/local/bin/service-watchdog.sh (root実行) / 設定: /etc/service-watchdog.conf
# 起動: systemd timer (1分毎)。状態: $STATE_DIR。
set -u

CONF="${1:-/etc/service-watchdog.conf}"
# shellcheck source=/dev/null
[ -r "$CONF" ] && . "$CONF" || { echo "conf読込失敗: $CONF" >&2; exit 1; }
: "${NTFY_URL:?}"; : "${NTFY_TOPIC:?}"; : "${STATE_DIR:?}"
: "${FAIL_THRESHOLD:=3}"; : "${COOLDOWN_SEC:=900}"; : "${POST_RESTART_WAIT:=8}"
: "${CURL_TIMEOUT:=6}"; : "${SYSTEMIC_THRESHOLD:=3}"
mkdir -p "$STATE_DIR"
HOST="$(hostname -s 2>/dev/null || hostname)"
now() { date +%s; }
stamp() { date '+%F %T %Z'; }
log() { echo "[$(stamp)] $*"; }

# ntfy 通知。Title はASCIIのみ(ヘッダ制約)、本文はUTF-8可。
notify() {
  local title="$1" body="$2" prio="${3:-default}" tags="${4:-warning}"
  curl -s -m 8 -H "Title: $title" -H "Priority: $prio" -H "Tags: $tags" \
    --data-binary "$body" "$NTFY_URL/$NTFY_TOPIC" >/dev/null 2>&1
}

# 健全性チェック。健全=0/異常=1。詳細を CHK_DETAIL に残す。
CHK_DETAIL=""
run_check() {
  local kind="$1" target="$2" smin="$3" smax="$4" substr="$5"
  if [ "$kind" = systemd ]; then
    local st; st="$(systemctl is-active "$target" 2>/dev/null)"
    CHK_DETAIL="is-active=$st"
    [ "$st" = active ] && return 0 || return 1
  fi
  # kind=http
  local bf code sub_ok=1
  bf="$(mktemp)"
  code="$(curl -s -o "$bf" -m "$CURL_TIMEOUT" -w '%{http_code}' "$target" 2>/dev/null)"
  code=$((10#${code:-0}))              # "000"や先頭0を10進で安全に整数化
  if [ -n "$substr" ]; then grep -qF -- "$substr" "$bf" || sub_ok=0; fi
  rm -f "$bf"
  CHK_DETAIL="status=$code"
  [ "$sub_ok" -eq 1 ] || CHK_DETAIL="$CHK_DETAIL,marker-missing"
  if [ "$code" -ge "$smin" ] && [ "$code" -le "$smax" ] && [ "$sub_ok" -eq 1 ]; then return 0; fi
  return 1
}

# ---- 環境アラート: ディスク使用率(通知のみ) ----
check_disk() {
  local mounts
  if [ -n "${DISK_MOUNTS:-}" ]; then mounts="$DISK_MOUNTS"
  else mounts="$(df -P -x tmpfs -x devtmpfs -x overlay 2>/dev/null | awk 'NR>1{print $6}')"; fi
  local warn="${DISK_WARN_PCT:-90}" crit="${DISK_CRIT_PCT:-95}" remind="${DISK_REMIND_SEC:-86400}"
  local m pct level key sf prev plast nowt
  for m in $mounts; do
    pct="$(df -P "$m" 2>/dev/null | awk 'NR==2{gsub("%","",$5); print $5}')"
    [ -z "$pct" ] && continue
    level=ok; [ "$pct" -ge "$warn" ] && level=warn; [ "$pct" -ge "$crit" ] && level=crit
    key="disk_$(printf '%s' "$m" | tr '/ ' '__')"; sf="$STATE_DIR/$key.level"
    prev=ok; plast=0; [ -r "$sf" ] && read -r prev plast < "$sf"
    nowt="$(now)"
    if [ "$level" = ok ]; then
      [ "$prev" != ok ] && { log "DISK $m recovered ${pct}%"; notify "watchdog: disk $m OK" \
"✅ ディスク $m の使用率が ${pct}% に回復しました(閾値未満)。
$(stamp) $HOST" default white_check_mark; }
      echo "ok $nowt" > "$sf"
    else
      if [ "$level" != "$prev" ] || [ $(( nowt - plast )) -ge "$remind" ]; then
        local prio=default tags=warning icon="⚠"; [ "$level" = crit ] && { prio=high; tags=rotating_light; icon="🔴"; }
        log "DISK $m $level ${pct}%"
        notify "watchdog: disk $m $level ${pct}%" \
"$icon ディスク $m 使用率 ${pct}% (閾値 warn=${warn}% / crit=${crit}%)
$(df -h "$m" 2>/dev/null | awk 'NR==2{printf "  %s 中 %s 使用 (残 %s)",$2,$3,$4}')
$(stamp) $HOST" "$prio" "$tags"
        echo "$level $nowt" > "$sf"
      fi
    fi
  done
}

# ---- 環境アラート: HTTPS証明書の残り日数(通知のみ。スキャンは低頻度) ----
check_certs() {
  [ -n "${CERT_HOSTS:-}" ] || return 0
  command -v openssl >/dev/null 2>&1 || return 0
  local gate="$STATE_DIR/_cert.scan" last nowt; nowt="$(now)"
  last="$(cat "$gate" 2>/dev/null || echo 0)"
  [ $(( nowt - last )) -lt "${CERT_SCAN_INTERVAL_SEC:-43200}" ] && return 0
  echo "$nowt" > "$gate"
  local warn="${CERT_WARN_DAYS:-20}" h end ets days sf plast expmsg
  for h in $CERT_HOSTS; do
    end="$(echo | timeout 8 openssl s_client -servername "$h" -connect "$h:443" 2>/dev/null \
          | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
    if [ -z "$end" ]; then days=-1; expmsg="(証明書/接続の取得に失敗)"; else
      ets="$(date -d "$end" +%s 2>/dev/null)"; [ -z "$ets" ] && continue
      days=$(( (ets - nowt) / 86400 )); expmsg="(期限 $end)"
    fi
    sf="$STATE_DIR/cert_$h.days"
    if [ "$days" -lt "$warn" ]; then
      plast="$(cat "$sf" 2>/dev/null || echo 0)"
      if [ $(( nowt - plast )) -ge 86400 ]; then     # 1日1回まで
        local prio=default tags=warning; [ "$days" -lt 7 ] && { prio=high; tags=rotating_light; }
        log "CERT $h days=$days"
        notify "watchdog: cert $h ${days}d" \
"⚠ HTTPS証明書 $h の残り ${days} 日 ${expmsg}。Caddy の自動更新が失敗している可能性があります。確認してください。
$(stamp) $HOST" "$prio" "$tags"
        echo "$nowt" > "$sf"
      fi
    else
      rm -f "$sf" 2>/dev/null    # 十分先: 旗クリア
    fi
  done
}

# ---- systemd 失敗ユニットの総ざらい(列挙外の障害も検知。新規failedのみ通知) ----
check_failed_units() {
  [ "${FAILED_UNITS_CHECK:-1}" = 1 ] || return 0
  local ignore=" ${FAILED_UNITS_IGNORE:-} " u now_set="" newf=""
  for u in $(systemctl list-units --state=failed --plain --no-legend --no-pager 2>/dev/null | awk '{print $1}'); do
    case "$ignore" in *" $u "*) continue ;; esac
    now_set="$now_set $u"
  done
  now_set="$(printf '%s\n' $now_set | sort | tr '\n' ' ')"; now_set="${now_set# }"; now_set="${now_set% }"
  local sf="$STATE_DIR/_failed.set" prev=""; [ -r "$sf" ] && prev="$(cat "$sf")"
  for u in $now_set; do case " $prev " in *" $u "*) ;; *) newf="$newf $u" ;; esac; done
  if [ -n "$newf" ]; then
    log "FAILED-UNITS new:$newf"
    notify "watchdog: systemd failed$newf" \
"🔴 systemd ユニットが failed になりました:$newf
$(for u in $newf; do systemctl status "$u" --no-pager 2>/dev/null | grep -E 'Active:' | head -1 | sed 's/^ */  /'; done)
$(stamp) $HOST" high rotating_light
  fi
  echo "$now_set" > "$sf"
}

# ---- メモリ/スワップ逼迫 + OOM-kill 検知 ----
check_memory() {
  local availmb swappct nowt sf prev plast warn=0 msg=""
  nowt="$(now)"
  availmb="$(free -m | awk '/^Mem:/{print $7}')"
  swappct="$(free | awk '/^Swap:/{ if($2>0) printf "%d",($3/$2)*100; else print 0 }')"
  [ "${availmb:-9999}" -lt "${MEM_AVAIL_WARN_MB:-300}" ] && { warn=1; msg="空きメモリ ${availmb}MB(<${MEM_AVAIL_WARN_MB:-300}MB)"; }
  [ "${swappct:-0}" -ge "${SWAP_USED_WARN_PCT:-60}" ] && { warn=1; msg="$msg スワップ使用 ${swappct}%(≥${SWAP_USED_WARN_PCT:-60}%)"; }
  sf="$STATE_DIR/_mem.level"; prev=ok; plast=0; [ -r "$sf" ] && read -r prev plast < "$sf"
  if [ "$warn" = 1 ]; then
    if [ "$prev" != warn ] || [ $(( nowt - plast )) -ge "${MEM_REMIND_SEC:-21600}" ]; then
      log "MEM warn: $msg"
      notify "watchdog: memory pressure" \
"⚠ メモリ逼迫: ${msg}
$(free -h | awk '/^Mem:/{printf "  Mem 使用%s/%s 空き%s",$3,$2,$7} /^Swap:/{printf "  Swap %s/%s",$3,$2}')
$(stamp) $HOST" high rotating_light
      echo "warn $nowt" > "$sf"
    fi
  else
    [ "$prev" = warn ] && { log "MEM recovered"; notify "watchdog: memory OK" "✅ メモリ逼迫が解消しました(空き ${availmb}MB, swap ${swappct}%)。$(stamp) $HOST" default white_check_mark; }
    echo "ok $nowt" > "$sf"
  fi
  # OOM-kill イベント(前回チェック以降の新規のみ)
  [ "${OOM_CHECK:-1}" = 1 ] || return 0
  command -v journalctl >/dev/null 2>&1 || return 0
  local osf="$STATE_DIR/_oom.since" since hits
  since="$(cat "$osf" 2>/dev/null)"
  hits="$(journalctl -k --since "${since:--6 min}" --no-pager 2>/dev/null | grep -iE 'Out of memory|oom-kill|Killed process' | tail -5)"
  date '+%Y-%m-%d %H:%M:%S' > "$osf"
  if [ -n "$hits" ]; then
    log "OOM detected"
    notify "watchdog: OOM-kill 検知" \
"🔴 カーネルがメモリ不足でプロセスを停止しました:
$(printf '%s\n' "$hits" | sed 's/^.*: /  /' | head -5)
$(stamp) $HOST" high rotating_light
  fi
}

# ---- DBバックアップ鮮度(最新dumpが古い/無ければ通知。日次dedup) ----
check_backups() {
  [ -n "${BACKUP_DBS:-}" ] || return 0
  local dir="${BACKUP_DIR:-/var/backups/db}" maxage="${BACKUP_MAX_AGE_SEC:-93600}" nowt db newest age sf plast d
  nowt="$(now)"
  for db in $BACKUP_DBS; do
    newest="$(ls -t "$dir/${db}"-*.sql.gz 2>/dev/null | head -1)"
    sf="$STATE_DIR/backup_${db}.warn"
    if [ -z "$newest" ]; then age=-1; else age=$(( nowt - $(stat -c %Y "$newest" 2>/dev/null || echo 0) )); fi
    if [ "$age" -lt 0 ] || [ "$age" -ge "$maxage" ]; then
      plast="$(cat "$sf" 2>/dev/null || echo 0)"
      if [ $(( nowt - plast )) -ge 86400 ]; then
        [ "$age" -lt 0 ] && d="バックアップが存在しません" || d="最新バックアップが約$(( age/3600 ))時間前"
        log "BACKUP stale $db ($d)"
        notify "watchdog: backup $db 古い/欠落" \
"⚠ DB $db の${d} ($dir)。毎晩のバックアップジョブ(db-backup.timer)を確認してください。
$(stamp) $HOST" high rotating_light
        echo "$nowt" > "$sf"
      fi
    else
      rm -f "$sf" 2>/dev/null
    fi
  done
}

# 環境アラートはサービス状態と独立に毎巡回で評価(systemic早期exitより前に実施)
# 外部死活監視: 生存pingを最初に打つ(=このホスト＋watchdog＋外向き通信が生きている印)
[ -n "${DEADMAN_URL:-}" ] && curl -fsS -m 8 "$DEADMAN_URL" >/dev/null 2>&1
check_disk
check_certs
check_failed_units
check_memory
check_backups

# ---- Phase 1: 全サービスを評価 ----
declare -a NAME KIND TARGET SMIN SMAX SUBSTR RESTART OKV DET
n=0; failing=()
for rec in "${SERVICES[@]}"; do
  IFS='|' read -r nm kd tg mn mx sb rs <<< "$rec"
  NAME[n]="$nm"; KIND[n]="$kd"; TARGET[n]="$tg"; SMIN[n]="${mn:-0}"; SMAX[n]="${mx:-0}"; SUBSTR[n]="$sb"; RESTART[n]="$rs"
  if run_check "$kd" "$tg" "${mn:-0}" "${mx:-0}" "$sb"; then OKV[n]=1; else OKV[n]=0; failing+=("$n"); fi
  DET[n]="$CHK_DETAIL"
  n=$((n+1))
done

# ---- 同時多発ガード: 多数同時失敗は基盤障害の疑い → 個別再起動を抑止し1本だけ通知 ----
if [ "${#failing[@]}" -ge "$SYSTEMIC_THRESHOLD" ]; then
  # 各失敗のカウンタは進めておく(基盤復帰後に個別対応できるように)
  for i in "${failing[@]}"; do
    f="$STATE_DIR/${NAME[i]}.fails"; echo $(( $(cat "$f" 2>/dev/null || echo 0) + 1 )) > "$f"
  done
  names=""; for i in "${failing[@]}"; do names="$names ${NAME[i]}(${DET[i]})"; done
  last="$(cat "$STATE_DIR/_systemic.last" 2>/dev/null || echo 0)"
  log "SYSTEMIC suspected: ${#failing[@]} services failing:$names (個別再起動を抑止)"
  if [ $(( $(now) - last )) -ge "$COOLDOWN_SEC" ]; then
    date +%s > "$STATE_DIR/_systemic.last"
    notify "watchdog: systemic outage?" \
"同時に ${#failing[@]} 件のサービスが L7 異常です。基盤障害(Caddy/docker/ネット/OS)の疑いが高いため、個別サービスの自動再起動は抑止しました(vps-healthcheck に委譲)。
対象:$names
$(stamp) $HOST" high rotating_light
  fi
  exit 0
fi

# ---- Phase 2: 個別対応 ----
for ((i=0; i<n; i++)); do
  fF="$STATE_DIR/${NAME[i]}.fails"
  aF="$STATE_DIR/${NAME[i]}.last_action"
  iF="$STATE_DIR/${NAME[i]}.incident"

  if [ "${OKV[i]}" -eq 1 ]; then
    echo 0 > "$fF"
    # 直前にwatchdogが手を入れて「まだ異常」だったサービスが自然/事後復旧したら復旧通知して締める
    if [ -f "$iF" ]; then
      rm -f "$iF"
      log "RECOVERED ${NAME[i]} (${DET[i]})"
      notify "watchdog: ${NAME[i]} recovered" \
"✅ ${NAME[i]} が復旧しました (${DET[i]})。
$(stamp) $HOST" default white_check_mark
    fi
    continue
  fi

  # 異常: 連続失敗カウンタ加算
  fails=$(( $(cat "$fF" 2>/dev/null || echo 0) + 1 )); echo "$fails" > "$fF"
  log "FAIL ${NAME[i]} (${DET[i]}) 連続${fails}/${FAIL_THRESHOLD}"
  [ "$fails" -lt "$FAIL_THRESHOLD" ] && continue

  # しきい値到達。冷却中なら再アクションしない(ループ防止。通知は最初のアクション時に済み)
  last="$(cat "$aF" 2>/dev/null || echo 0)"
  if [ $(( $(now) - last )) -lt "$COOLDOWN_SEC" ]; then
    log "SKIP ${NAME[i]} 冷却中 ($(( COOLDOWN_SEC - ($(now) - last) ))s 残)"
    continue
  fi

  before="${DET[i]}"
  log "ACTION ${NAME[i]} 実行: ${RESTART[i]}"
  rout="$(eval "${RESTART[i]}" 2>&1)"; rrc=$?
  date +%s > "$aF"; echo 0 > "$fF"
  sleep "$POST_RESTART_WAIT"
  if run_check "${KIND[i]}" "${TARGET[i]}" "${SMIN[i]}" "${SMAX[i]}" "${SUBSTR[i]}"; then
    after="${CHK_DETAIL}"; rm -f "$iF"
    log "ACTION-RESULT ${NAME[i]} 復旧OK (${after})"
    notify "watchdog: ${NAME[i]} restarted (recovered)" \
"⚠ ${NAME[i]} が L7 異常(${FAIL_THRESHOLD}回連続)のため再起動を実施しました。
コマンド: ${RESTART[i]} (rc=$rrc)
実施前: ${before}
実施後: ✅ 復旧 (${after})
$(stamp) $HOST" default heavy_check_mark
  else
    after="${CHK_DETAIL}"; : > "$iF"
    log "ACTION-RESULT ${NAME[i]} まだ異常 (${after})"
    notify "watchdog: ${NAME[i]} restarted (STILL DOWN)" \
"🔴 ${NAME[i]} が L7 異常(${FAIL_THRESHOLD}回連続)のため再起動を実施しましたが、復旧しませんでした。手動確認が必要です。
コマンド: ${RESTART[i]} (rc=$rrc)
実施前: ${before}
実施後: ❌ まだ異常 (${after})
$([ -n "$rout" ] && echo "出力: $(echo "$rout" | head -c 300)")
$(stamp) $HOST" high rotating_light
  fi
done
exit 0
