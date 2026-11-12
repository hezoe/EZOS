#!/bin/bash
# EZOS 追加策 D (2026-11-13): 稼働中の EZOS が「署名されたコミットそのもの」で動いているか、
# 部品に既知の脆弱性が無いかを毎日確かめ、違いがあれば ntfy で知らせる(侵入後の細工・居座りの検知)。
#  1. HEAD の署名(git verify-commit)が通ること
#  2. app/ 配下の稼働コードがコミットと一致すること(追跡ファイルの変更・未追跡ファイルの両方。data/ と node_modules/ は除く)
#  3. ezos の実行ファイルが /usr/bin/node、作業ディレクトリが app/ であること
#  4. npm audit(本番依存・high 以上)が 0 件であること
# 問題が無ければ journal に 1 行残すだけ(通知しない)。debian ユーザーで動かす(リポジトリの所有者)。
# ntfy 設定は service-watchdog.conf を再利用。
set -u
CONF="${1:-/etc/service-watchdog.conf}"
[ -r "$CONF" ] && . "$CONF"
: "${NTFY_URL:=https://ntfy.sh}"
: "${NTFY_TOPIC:=}"
REPO="${EZOS_REPO:-/home/debian/EZOS}"
APP="$REPO/app"
HS="$(hostname -s 2>/dev/null || hostname)"
notify(){ [ -n "$NTFY_TOPIC" ] || return 0; curl -s -m 8 -H "Title: $1" -H "Priority: ${3:-high}" -H "Tags: ${4:-mag}" --data-binary "$2" "$NTFY_URL/$NTFY_TOPIC" >/dev/null 2>&1; }

issues=()
cd "$REPO" || { echo "リポジトリがありません: $REPO"; exit 0; }

head="$(git rev-parse --short HEAD 2>/dev/null)"
if ! git verify-commit HEAD >/dev/null 2>&1; then
  issues+=("HEAD($head) の署名を確かめられません(未署名、または検証鍵に無い署名者)")
fi

dirty="$(git status --porcelain --untracked-files=all -- app ':!app/data' ':!app/node_modules' 2>/dev/null)"
if [ -n "$dirty" ]; then
  issues+=("稼働コード(app/)がコミット $head と違います:
$(echo "$dirty" | head -20)$([ "$(echo "$dirty" | wc -l)" -gt 20 ] && echo '
…(以下省略)')")
fi

pid="$(systemctl show -p MainPID --value ezos 2>/dev/null)"
if [ -n "$pid" ] && [ "$pid" != 0 ]; then
  exe="$(readlink "/proc/$pid/exe" 2>/dev/null)"
  cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null)"
  node="$(readlink -f /usr/bin/node 2>/dev/null)"
  # Node 更新直後は旧バイナリで動いていて "(deleted)" が付く(node-refresh.timer が夜間に再起動する)。それは異常ではない
  exe_base="${exe% (deleted)}"
  [ -n "$exe" ] && [ "$(readlink -f "$exe_base" 2>/dev/null || echo "$exe_base")" != "$node" ] && issues+=("ezos の実行ファイルが想定外です: $exe (想定 $node)")
  [ "$exe" != "$exe_base" ] && echo "情報: ezos は更新前の node で動作中(node-refresh で再起動予定)"
  [ -n "$cwd" ] && [ "$cwd" != "$(readlink -f "$APP")" ] && issues+=("ezos の作業ディレクトリが想定外です: $cwd")
else
  issues+=("ezos が動いていません")
fi

audit_json="$(cd "$APP" && timeout 180 npm audit --omit=dev --audit-level=high --json 2>/dev/null)"
if [ -n "$audit_json" ]; then
  summary="$(printf '%s' "$audit_json" | python3 -c '
import json,sys
try:
    d=json.load(sys.stdin); v=d.get("metadata",{}).get("vulnerabilities",{})
    hi=v.get("high",0); cr=v.get("critical",0)
    if hi or cr:
        names=[k for k,x in d.get("vulnerabilities",{}).items() if x.get("severity") in ("high","critical")]
        print(f"npm audit: high {hi} / critical {cr}: " + ", ".join(names[:10]))
except Exception as e:
    pass
')"
  [ -n "$summary" ] && issues+=("$summary")
else
  echo "npm audit を実行できませんでした(ネットワーク?)。今回は省略"
fi

if [ ${#issues[@]} -eq 0 ]; then
  echo "EZOS integrity OK: HEAD $head 署名済み・稼働コード一致・npm audit 0 件"
  exit 0
fi
body="⚠ EZOS の点検で違いが見つかりました($HS)
"
for i in "${issues[@]}"; do body="$body
- $i"; done
body="$body

$(date '+%F %T %Z')"
echo "$body"
notify "EZOS integrity: 要確認" "$body" high rotating_light
