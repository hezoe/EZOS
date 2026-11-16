#!/bin/bash
# offsite-backup — DB/サイトのオフサイト相互バックアップ (R-024 ほか, 2026-11-11)
#   A) VPS の当日 DB ダンプ(/var/backups/db)→ さくら ~/backups/vps-db/ (14日保持)
#   B) さくら ~/www → VPS /var/backups/sakura/www-mirror/ (rsync ミラー)
#   C) 月曜のみ: ミラーの tar スナップショット (3世代保持)
#   D) 秘密情報(鍵・台帳・設定)を公開鍵で暗号化 → さくら ~/backups/vps-secrets/ (30日保持)
# root/systemd 実行想定。鍵は debian のものを利用(送り先は /etc/offsite-backup/offsite-backup.conf)。
set -uo pipefail

SSH_OPTS=(-i /home/debian/.ssh/id_ed25519 -o IdentitiesOnly=yes
          -o UserKnownHostsFile=/home/debian/.ssh/known_hosts
          -o BatchMode=yes -o ConnectTimeout=20)
# 送り先(さくらのアカウント)は公開リポジトリに載せず /etc/offsite-backup/offsite-backup.conf の REMOTE= に置く
REMOTE=$(grep -E '^REMOTE=' /etc/offsite-backup/offsite-backup.conf 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"')
[ -n "$REMOTE" ] || { echo "REMOTE 未設定(/etc/offsite-backup/offsite-backup.conf)" >&2; exit 1; }
DB_DIR=/var/backups/db
MIRROR=/var/backups/sakura/www-mirror
SNAP_DIR=/var/backups/sakura
KEEP_REMOTE_DAYS=14
KEEP_SNAPS=3
SECRETS_PUB=/etc/offsite-backup/secrets.pub.asc
SECRETS_DIR=/var/backups/secrets
KEEP_SECRETS_DAYS=30
KEEP_SECRETS_LOCAL=3
SECRET_PATHS=(
  /etc/wireguard /etc/catvpn /var/lib/catvpn
  /etc/secguard.conf /etc/service-watchdog.conf /etc/vps-healthcheck.conf /etc/secwatch.env
  /etc/systemd/system /etc/sudoers.d /var/spool/cron/crontabs /etc/offsite-backup
  /home/debian/.ssh /home/debian/.config/navlog /home/debian/.config/ogn-collect
  /home/debian/.config/techlink /home/debian/.config/takikawa
  /home/debian/EZOS/app/data /home/debian/Takikawa-WEB/.env.local
  /home/debian/saas/apps/flightlog/.env.saas /home/debian/saas/postgres/postgres_password.txt
)

fail_msgs=()

notify_fail() {
  local conf=/etc/vps-healthcheck.conf url="https://ntfy.sh" topic=""
  if [ -r "$conf" ]; then
    url=$(grep -E '^NTFY_URL=' "$conf" | tail -1 | cut -d= -f2- | tr -d '"' ) || true
    topic=$(grep -E '^NTFY_TOPIC=' "$conf" | tail -1 | cut -d= -f2- | tr -d '"' ) || true
  fi
  [ -n "$topic" ] || { echo "NTFY_TOPIC 未設定: 通知スキップ"; return; }
  curl -s -m 15 -H "Title: offsite-backup 失敗" -H "Priority: 4" -H "Tags: warning" \
    --data-binary "$(printf '%s\n' "${fail_msgs[@]}")" "${url}/${topic}" >/dev/null || true
}

# --- A) VPS DBダンプ → さくら ---
ssh "${SSH_OPTS[@]}" "$REMOTE" 'mkdir -p ~/backups/vps-db && chmod 700 ~/backups ~/backups/vps-db' \
  || fail_msgs+=("さくら側ディレクトリ準備に失敗")

today=$(date +%Y%m%d)
shopt -s nullglob
dumps=("$DB_DIR"/*-"$today"-*.sql.gz)
if [ ${#dumps[@]} -eq 0 ]; then
  fail_msgs+=("当日のDBダンプが見つからない($DB_DIR)")
else
  if scp "${SSH_OPTS[@]}" -q "${dumps[@]}" "$REMOTE:backups/vps-db/"; then
    echo "OK  DBダンプ ${#dumps[@]} 件をさくらへ複製"
  else
    fail_msgs+=("DBダンプのさくらへの複製に失敗")
  fi
fi
# さくら側ローテーション
ssh "${SSH_OPTS[@]}" "$REMOTE" "find backups/vps-db -name '*.sql.gz' -mtime +${KEEP_REMOTE_DAYS} -delete" \
  || fail_msgs+=("さくら側ローテーションに失敗")

# --- B) さくら ~/www → VPS ミラー ---
mkdir -p "$MIRROR"; chmod 700 "$SNAP_DIR"
if rsync -a --delete --timeout=300 -e "ssh ${SSH_OPTS[*]}" "$REMOTE:www/" "$MIRROR/"; then
  echo "OK  さくら www をミラー更新 ($(du -sh "$MIRROR" | cut -f1))"
else
  fail_msgs+=("さくら www の rsync ミラーに失敗")
fi

# --- C) 週次スナップショット(月曜) ---
if [ "$(date +%u)" = 1 ]; then
  snap="$SNAP_DIR/www-snap-$today.tar.gz"
  if tar -czf "$snap" -C "$MIRROR" . ; then
    echo "OK  週次スナップショット $(basename "$snap") ($(du -h "$snap" | cut -f1))"
    ls -1t "$SNAP_DIR"/www-snap-*.tar.gz 2>/dev/null | tail -n +$((KEEP_SNAPS+1)) | xargs -r rm -f
  else
    rm -f "$snap"; fail_msgs+=("週次スナップショット作成に失敗")
  fi
fi

# --- D) 秘密情報(鍵・台帳・設定)を暗号化してさくらへ (2026-11-16) ---
#   git に入れない物(WireGuard 鍵・CATVPN 台帳・/etc の実値・各 .env・署名鍵)を VPS 消失に備えて外へ置く。
#   公開鍵で暗号化する。復号の秘密鍵は VPS に置かない(浩さんが保管)。戻し方は README。
if [ -s "$SECRETS_PUB" ]; then
  mkdir -p "$SECRETS_DIR"; chmod 700 "$SECRETS_DIR"
  have=(); missing=()
  for p in "${SECRET_PATHS[@]}"; do
    if [ -e "$p" ]; then have+=("${p#/}"); else missing+=("$p"); fi
  done
  [ ${#missing[@]} -eq 0 ] || fail_msgs+=("秘密情報の対象が見つからない: ${missing[*]}")
  out="$SECRETS_DIR/vps-secrets-$today.tar.gz.gpg"
  gh=$(mktemp -d /run/offsite-gpg.XXXXXX)
  tar -czf - -C / --warning=no-file-changed "${have[@]}" \
    | gpg --homedir "$gh" --batch --quiet --trust-model always \
          --recipient-file "$SECRETS_PUB" --encrypt -o "$out.tmp"
  rc=("${PIPESTATUS[@]}"); rm -rf "$gh"
  # tar の 1 は「読む間に変わった」だけなので通す
  if [ "${rc[0]}" -le 1 ] && [ "${rc[1]}" -eq 0 ] && [ -s "$out.tmp" ]; then
    mv -f "$out.tmp" "$out"; chmod 600 "$out"
    ls -1t "$SECRETS_DIR"/vps-secrets-*.tar.gz.gpg | tail -n +$((KEEP_SECRETS_LOCAL+1)) | xargs -r rm -f
    if ssh "${SSH_OPTS[@]}" "$REMOTE" 'mkdir -p ~/backups/vps-secrets && chmod 700 ~/backups/vps-secrets' \
       && scp "${SSH_OPTS[@]}" -q "$out" "$REMOTE:backups/vps-secrets/"; then
      echo "OK  秘密情報を暗号化してさくらへ複製 ($(du -h "$out" | cut -f1)・${#have[@]} か所)"
      ssh "${SSH_OPTS[@]}" "$REMOTE" "find backups/vps-secrets -name '*.gpg' -mtime +${KEEP_SECRETS_DAYS} -delete" \
        || fail_msgs+=("さくら側 秘密情報のローテーションに失敗")
    else
      fail_msgs+=("秘密情報のさくらへの複製に失敗")
    fi
  else
    rm -f "$out.tmp"; fail_msgs+=("秘密情報の暗号化に失敗 (tar=${rc[0]} gpg=${rc[1]})")
  fi
else
  fail_msgs+=("暗号化の公開鍵がない($SECRETS_PUB)")
fi

if [ ${#fail_msgs[@]} -gt 0 ]; then
  printf 'FAIL %s\n' "${fail_msgs[@]}"
  notify_fail
  exit 1
fi
echo "offsite-backup 完了"
