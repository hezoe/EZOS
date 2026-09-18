#!/usr/bin/env bash
# EZOS 自己更新。サーバー(/api/update/apply)から切り離して起動される。
#   1. 更新できる状態か確認(gitリポジトリ・リモートあり・変更なし)
#   2. git pull --ff-only
#   3. 依存が変わっていれば npm install
#   4. サーバーを終了させて再起動(systemd の Restart=always / sudo が使えるなら systemctl restart)
# 進捗はこのスクリプトの標準出力(data/update.log)へ、結果は data/update-status.json へ書く。
set -uo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(dirname "$APP_DIR")"
STATUS="$APP_DIR/data/update-status.json"
FROM_VERSION="$(node -p "require('$APP_DIR/package.json').version" 2>/dev/null || echo unknown)"
mkdir -p "$APP_DIR/data"

log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
finish() { # $1=state $2=message
  node -e "
    const fs=require('fs');
    fs.writeFileSync('$STATUS', JSON.stringify({
      state: process.argv[1], message: process.argv[2],
      fromVersion: '$FROM_VERSION',
      toVersion: (()=>{try{return require('$APP_DIR/package.json').version}catch{return null}})(),
      finishedAt: Date.now(),
    }));
  " "$1" "$2" 2>/dev/null
  log "$1: $2"
}
fail() { finish failed "$1"; exit 1; }

cd "$REPO_DIR" || fail "リポジトリのディレクトリに移動できません: $REPO_DIR"
log "更新開始 (現在 v$FROM_VERSION, $REPO_DIR)"

[ "$(git rev-parse --is-inside-work-tree 2>/dev/null)" = "true" ] || fail "git リポジトリではありません。手動で更新してください"
REMOTE="$(git config --get remote.origin.url || true)"
[ -n "$REMOTE" ] || fail "git remote (origin) が設定されていません"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
log "リモート: $REMOTE / ブランチ: $BRANCH"

DIRTY="$(git status --porcelain)"
if [ -n "$DIRTY" ] && [ "${EZOS_FORCE:-}" != "1" ]; then
  log "$DIRTY"
  fail "ローカルに未コミットの変更があります。退避してから再実行してください"
fi

export GIT_TERMINAL_PROMPT=0
export GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=10"
BEFORE="$(git rev-parse HEAD)"
log "git fetch ..."
git fetch --prune origin "$BRANCH" 2>&1 || fail "git fetch に失敗しました(ネットワーク/認証を確認)"
log "git pull --ff-only ..."
git merge --ff-only "origin/$BRANCH" 2>&1 || fail "早送りできません(分岐しています)。手動で解決してください"
AFTER="$(git rev-parse HEAD)"

if [ "$BEFORE" = "$AFTER" ]; then
  finish uptodate "すでに最新です (v$FROM_VERSION)"
  exit 0
fi
log "更新: ${BEFORE:0:7} → ${AFTER:0:7}"
git --no-pager log --oneline "$BEFORE..$AFTER" | head -20

if ! git diff --quiet "$BEFORE" "$AFTER" -- app/package.json app/package-lock.json; then
  log "依存が変わったため npm install を実行 ..."
  (cd "$APP_DIR" && npm install --omit=dev --no-audit --no-fund 2>&1) || fail "npm install に失敗しました"
fi

TO_VERSION="$(node -p "require('$APP_DIR/package.json').version" 2>/dev/null || echo unknown)"
finish restarting "v$FROM_VERSION → v$TO_VERSION に更新しました。再起動します"

# 再起動は「更新を依頼してきたサーバー自身」だけを対象にする。
# 同じ機に複数の EZOS が居ても巻き添えにしないよう、unit 名は PID の cgroup から判定する。
unit_of_pid() {
  local pid="${1:-}" cg
  [ -n "$pid" ] || return 1
  cg="$(head -1 "/proc/$pid/cgroup" 2>/dev/null)" || return 1
  [[ "$cg" =~ ([A-Za-z0-9_.@\\-]+\.service) ]] && printf '%s' "${BASH_REMATCH[1]}"
}

sleep 1
if [ -z "${EZOS_SERVER_PID:-}" ]; then
  log "サーバーのPIDが渡されていないため再起動しません。手動で EZOS を再起動してください"
  exit 0
fi
# 呼び出し元(サーバー)が渡した unit を優先。無ければ PID の cgroup から判定
UNIT="${EZOS_UNIT:-$(unit_of_pid "$EZOS_SERVER_PID" || true)}"
if [ -n "$UNIT" ] && sudo -n systemctl restart "$UNIT" 2>/dev/null; then
  log "systemctl restart $UNIT を実行しました"
else
  # sudo が使えない/systemd でない場合はサーバーを終了させ、Restart=always に任せる
  log "サーバー(PID ${EZOS_SERVER_PID}${UNIT:+, $UNIT})を終了します。自動で起動し直します"
  kill "$EZOS_SERVER_PID" 2>/dev/null || log "プロセスを終了できませんでした。手動で再起動してください"
fi
