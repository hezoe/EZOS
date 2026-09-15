#!/bin/bash
# session-mem-watch インストーラ(要root)。EZOS/app/bin の監視スクリプトを system パスへ設置し、
# 設定を /etc に生成(初回のみ)、10分毎の systemd timer を有効化する。
#   使い方:  sudo ops/session-mem-watch/install.sh
#   初回は /etc/ezos-session-mem-watch.conf を編集して NTFY_TOPIC を実値にし、再実行(既存confは保持)。
#   ntfy は環境変数でも渡せる:  sudo EZOS_NTFY_TOPIC=xxxxx ops/session-mem-watch/install.sh
set -eu
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"        # .../ops/session-mem-watch
REPO="$(cd "$SRC/../.." && pwd)"                            # リポジトリルート
SCRIPT="$REPO/app/bin/session-mem-watch.sh"
CONF=/etc/ezos-session-mem-watch.conf
[ "$(id -u)" -eq 0 ] || { echo "root で実行してください: sudo $0" >&2; exit 1; }
[ -f "$SCRIPT" ] || { echo "監視スクリプトが見つかりません: $SCRIPT" >&2; exit 1; }

# 監視スクリプトを system パスへ設置(リポジトリ更新時は再実行で更新)
install -m 0755 "$SCRIPT" /usr/local/bin/session-mem-watch.sh

# 設定は既存を上書きしない(初回のみ example から生成)。編集済みの実値を保全するため。
if [ ! -e "$CONF" ]; then
  install -m 0644 "$SRC/session-mem-watch.conf.example" "$CONF"
  # 環境変数で NTFY_TOPIC / NTFY_URL が渡されていれば初期値として反映(対話不要のゼロタッチ導入)
  [ -n "${EZOS_NTFY_TOPIC:-}" ] && sed -i "s|^NTFY_TOPIC=.*|NTFY_TOPIC=\"${EZOS_NTFY_TOPIC}\"|" "$CONF"
  [ -n "${EZOS_NTFY_URL:-}"   ] && sed -i "s|^NTFY_URL=.*|NTFY_URL=\"${EZOS_NTFY_URL}\"|"     "$CONF"
  echo "設置(要確認): $CONF ← example から生成。NTFY_TOPIC を自分専用の値に編集してください。"
else
  echo "既存 $CONF は保持(更新は手動で)。"
fi

# ntfy 未設定チェック(vps-healthcheck.conf からの後方互換フォールバックが無い場合の警告)
TOPIC="$( . "$CONF" 2>/dev/null || true; printf '%s' "${NTFY_TOPIC:-}" )"
if [ -z "$TOPIC" ] || [ "$TOPIC" = "CHANGE-ME-your-secret-topic" ]; then
  if [ -r /etc/vps-healthcheck.conf ] && grep -q '^NTFY_TOPIC=' /etc/vps-healthcheck.conf; then
    echo "※ NTFY_TOPIC 未設定ですが /etc/vps-healthcheck.conf の設定を後方互換で使用します。"
  else
    echo "⚠ NTFY_TOPIC が未設定です。$CONF を編集しないと通知は飛びません。" >&2
  fi
fi

mkdir -p /var/lib/ezos

install -m 0644 "$SRC/session-mem-watch.service" /etc/systemd/system/session-mem-watch.service
install -m 0644 "$SRC/session-mem-watch.timer"   /etc/systemd/system/session-mem-watch.timer
systemctl daemon-reload
systemctl enable --now session-mem-watch.timer
echo "有効化完了。10分毎に監視します:"
systemctl status session-mem-watch.timer --no-pager | head -4
echo "手動テスト: sudo systemctl start session-mem-watch.service ; journalctl -u session-mem-watch.service -n 20 --no-pager"
