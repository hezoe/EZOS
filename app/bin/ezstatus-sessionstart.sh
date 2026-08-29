#!/bin/bash
# SessionStart フック: EZOSの新規Claudeセッション開始時に、サーバ状態ダッシュボードを
# 追加コンテキストとして注入し、Claudeに「起動時にまず状態を提示せよ」と指示する。
# - 要約用 headless claude 等(EZOS_HOOK_SILENT)では出さない。
# - 起動(startup)と /clear のときだけ。resume/compact では再表示しない(うるさいので)。
set -u
[ -n "${EZOS_HOOK_SILENT:-}" ] && exit 0
EV=$(cat 2>/dev/null || echo '{}')
SRC=$(printf '%s' "$EV" | jq -r '.source // "startup"' 2>/dev/null)
case "$SRC" in startup|clear) ;; *) exit 0 ;; esac

DASH="$(/home/debian/EZOS/app/bin/ezstatus.sh 2>/dev/null)"
[ -z "$DASH" ] && exit 0

cat <<EOF
[EZOS起動時サーバ状態] 以下は現在のサーバ状態ダッシュボードです。ユーザの依頼に入る前に、まずこれを**そのままフェンス付きコードブロックで**提示してください（等幅整列レイアウトなので加工・要約・表化しない）。サービス行に 🔴 があるか、CPU/メモリ/ディスクが逼迫していれば一言添えてください。

\`\`\`
$DASH
\`\`\`
EOF
exit 0
