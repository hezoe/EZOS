#!/usr/bin/env bash
# EZOS の systemd unit を「この機の実環境」に合わせて生成・設置する。
# ユーザー名・ホーム・設置先・node のパスを実行時に解決するので、
# Debian / Ubuntu / RHEL 系 / Arch など systemd を使う任意のディストリで同じ手順で使える。
#
# 使い方:
#   app/bin/install-service.sh [サービス名(既定: ezos)]          → unit を設置して起動(内部で sudo)
#   app/bin/install-service.sh --print [サービス名]               → 生成内容を表示するだけ
# 環境変数: EZOS_USER(実行ユーザー。既定: sudo元ユーザー or 現ユーザー)
set -euo pipefail

PRINT=0
if [ "${1:-}" = "--print" ]; then PRINT=1; shift; fi
SERVICE="${1:-ezos}"

APP_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TEMPLATE="$APP_DIR/ezos.service"

RUN_USER="${EZOS_USER:-${SUDO_USER:-$(id -un)}}"
if command -v getent >/dev/null 2>&1; then
  RUN_HOME=$(getent passwd "$RUN_USER" | cut -d: -f6)
else
  RUN_HOME=$(eval echo "~$RUN_USER")
fi
[ -n "$RUN_HOME" ] && [ -d "$RUN_HOME" ] || { echo "ユーザー $RUN_USER のホームが見つかりません" >&2; exit 1; }

# sudo 経由だと PATH が secure_path に置き換わり nvm 等の node を見失うため、実行ユーザーのログインシェルで解決
if [ "$(id -un)" = "$RUN_USER" ]; then
  NODE=$(command -v node || true)
else
  NODE=$(sudo -u "$RUN_USER" -i sh -c 'command -v node' 2>/dev/null || true)
fi
[ -n "$NODE" ] || { echo "node が見つかりません(PATH を確認してください)" >&2; exit 1; }
NODE=$(readlink -f "$NODE" 2>/dev/null || echo "$NODE")
# PATH は再現性のため固定構成で組み立てる: node の設置先 → ~/.local/bin(claude) → 標準のシステムパス
RUN_PATH="$(dirname "$NODE"):$RUN_HOME/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

for v in RUN_USER RUN_HOME APP_DIR NODE RUN_PATH; do
  case "${!v}" in *'|'*|*$'\n'*) echo "$v に使用できない文字が含まれています" >&2; exit 1 ;; esac
done

UNIT=$(sed -e '/^#@/d' -e "s|@USER@|$RUN_USER|g" -e "s|@HOME@|$RUN_HOME|g" -e "s|@APP_DIR@|$APP_DIR|g" \
           -e "s|@NODE@|$NODE|g" -e "s|@PATH@|$RUN_PATH|g" "$TEMPLATE")

if [ "$PRINT" = 1 ]; then printf '%s\n' "$UNIT"; exit 0; fi

command -v systemctl >/dev/null 2>&1 || { echo "systemd が無い環境です。--print の内容を参考に各OSのサービス管理へ登録してください" >&2; exit 1; }
SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO="sudo"
printf '%s\n' "$UNIT" | $SUDO tee "/etc/systemd/system/${SERVICE}.service" >/dev/null
$SUDO systemctl daemon-reload
$SUDO systemctl enable --now "$SERVICE"
echo "設置しました: /etc/systemd/system/${SERVICE}.service (User=$RUN_USER, HOME=$RUN_HOME, node=$NODE)"
