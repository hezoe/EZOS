#!/bin/bash
# UserPromptSubmit フックから呼ばれ、タブ見出し生成(ez-title.mjs)を非同期起動して即 return する。
# これでユーザのターンをブロックせず、数秒後にタブ見出しが最新の作業内容へ更新される。
set -u
# 要約用の headless claude から呼ばれた場合は無限再帰を防ぐため即終了
[ -n "${EZOS_HOOK_SILENT:-}" ] && exit 0
EV=$(cat 2>/dev/null || echo '{}')
DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# setsid でセッションを切り離し、node を完全にデタッチ(親フックの終了に巻き込まれない)
printf '%s' "$EV" | setsid /usr/bin/node "$DIR/ez-title.mjs" >/dev/null 2>&1 &
exit 0
