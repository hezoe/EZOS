#!/bin/bash
# Claude Code statusLine: stdinのJSONから rate_limits を抜き EZOS へ共有 + 一行表示
set -u
IN=$(cat 2>/dev/null || echo '{}')
OUT=/home/debian/EZOS/app/data/usage.json

RL=$(echo "$IN" | jq -c '.rate_limits // empty' 2>/dev/null)
if [ -n "$RL" ] && [ "$RL" != "null" ] && [ "$RL" != "{}" ]; then
  TMP="${OUT}.tmp.$$"   # 複数セッション同時実行でも衝突しないよう PID 付き tmp
  if echo "$IN" | jq -c '{rate_limits, model: .model.display_name,
        cost_usd: .cost.total_cost_usd, collected_at: (now | floor)}' \
        > "$TMP" 2>/dev/null; then
    chmod 600 "$TMP" && mv -f "$TMP" "$OUT"
  else
    rm -f "$TMP"
  fi
fi

# コンソール最下部のステータスライン表示は行わない。
# 使用量(5h/週)は EZOS の GUI 上部の使用量ウィジェット(#usage-widget が上で書いた
# usage.json を /api/usage 経由で表示)と重複するため、標準出力には何も出さない。
# ※ usage.json への書き出し(上記)は GUI ウィジェットの元データなので残す。
exit 0
