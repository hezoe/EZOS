#!/bin/bash
# UserPromptSubmit フックから呼ばれ、タブ見出し生成(ez-title.mjs)を非同期起動して即 return する。
# これでユーザのターンをブロックせず、数秒後にタブ見出しが最新の作業内容へ更新される。
set -u
# 要約用の headless claude から呼ばれた場合は無限再帰を防ぐため即終了
[ -n "${EZOS_HOOK_SILENT:-}" ] && exit 0
EV=$(cat 2>/dev/null || echo '{}')
DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# setsid でセッションを切り離し、node を完全にデタッチ(親フックの終了に巻き込まれない)
# node は PATH から解決(/usr/bin 以外: /usr/local/bin, nvm 等)。setsid の無い環境は nohup で代替
NODE=$(command -v node 2>/dev/null) || exit 0
if command -v setsid >/dev/null 2>&1; then
  printf '%s' "$EV" | setsid "$NODE" "$DIR/ez-title.mjs" >/dev/null 2>&1 &
else
  printf '%s' "$EV" | nohup "$NODE" "$DIR/ez-title.mjs" >/dev/null 2>&1 &
fi
exit 0
