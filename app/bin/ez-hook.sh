#!/bin/bash
# Claude Code フック → EZeditor開発ハブへのハートビート
# 使い方: ez-hook.sh <state>   (state: idle|working|pretool|waiting_user|ended)
# フックのstdinにイベントJSONが渡される
set -u
STATE="${1:-working}"
EV=$(cat 2>/dev/null || echo '{}')

SID=$(echo "$EV" | jq -r '.session_id // ""' 2>/dev/null)
CWD=$(echo "$EV" | jq -r '.cwd // ""' 2>/dev/null)
DETAIL=""

case "$STATE" in
  pretool)
    TOOL=$(echo "$EV" | jq -r '.tool_name // ""' 2>/dev/null)
    case "$TOOL" in
      Bash|BashOutput) STATE=running ;;
      *) STATE=working ;;
    esac
    DETAIL="$TOOL"
    ;;
  waiting_user)
    DETAIL=$(echo "$EV" | jq -r '.message // ""' 2>/dev/null | head -c 200)
    ;;
esac

[ -z "$SID" ] && exit 0

PAYLOAD=$(jq -n --arg id "$SID" --arg state "$STATE" --arg cwd "$CWD" --arg detail "$DETAIL" \
  '{id:$id, state:$state, cwd:$cwd, detail:$detail}')

# 非同期送信 (Claude Codeをブロックしない)
curl -s -m 3 -X POST http://127.0.0.1:3100/api/beat \
  -H 'Content-Type: application/json' \
  -d "$PAYLOAD" > /dev/null 2>&1 &

exit 0
