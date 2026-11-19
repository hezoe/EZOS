#!/bin/bash
# offsite-backup — DB/サイトのオフサイト相互バックアップ (R-024 ほか, 2026-11-11)
#   A) VPS の当日 DB ダンプ(/var/backups/db)→ さくら ~/backups/vps-db/ (さくら側で14日保持)
#   B) さくら ~/www → VPS /var/backups/sakura/www-mirror/ (rsync ミラー。VPS の鍵は rrsync で ~/www に限定)
#   C) 月曜のみ: ミラーの tar スナップショット (3世代保持)
#   D) 秘密情報(鍵・台帳・設定)を公開鍵で暗号化 → さくら ~/backups/vps-secrets/ (さくら側で30日保持)
#      別ホスト(REMOTE_SECRETS)の秘密情報は相手の上で暗号化したものを受け取って同じ所へ(2026-11-19)
#   さくらへの送り出しはバックアップ専用鍵(/etc/offsite-backup/backup_ed25519)で行う。さくら側は
#   ~/bin/backup-recv が「新しいファイルを置く」だけを受け付け、上書き・削除はさせない(ランサム対策 2026-11-16)。
#   古い写しの削除と www の週ごとの写しは、さくらの cron(~/bin/backup-rotate)が行う。
#   E) VPS 上の git リポジトリ(自動検出)のうち変わったものを全履歴ごと bundle → さくら ~/backups/vps-git/
#      (非公開リポジトリは無料プランでは GitHub の保護ルールを付けられないため、強制 push で壊されても戻せるように)
#   作ったバックアップの指紋(SHA-256)を台帳に残し、さくら ~/backups/manifest.tsv にも置く
#   (backup-integrity-check が毎朝これと照らし合わせて書き換えを見つける)
# root/systemd 実行想定。鍵は debian のものを利用(送り先は /etc/offsite-backup/offsite-backup.conf)。
set -uo pipefail

# www の取り込み(rrsync で ~/www に限られた鍵)
SSH_OPTS=(-i /home/debian/.ssh/id_ed25519 -o IdentitiesOnly=yes
          -o UserKnownHostsFile=/home/debian/.ssh/known_hosts
          -o BatchMode=yes -o ConnectTimeout=20)
# さくらへの送り出し(put/manifest/list しかできない鍵)
PUT_OPTS=(-i /etc/offsite-backup/backup_ed25519 -o IdentitiesOnly=yes
          -o UserKnownHostsFile=/home/debian/.ssh/known_hosts
          -o BatchMode=yes -o ConnectTimeout=20)
# 送り先(さくらのアカウント)は公開リポジトリに載せず /etc/offsite-backup/offsite-backup.conf の REMOTE= に置く
REMOTE=$(grep -E '^REMOTE=' /etc/offsite-backup/offsite-backup.conf 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"')
[ -n "$REMOTE" ] || { echo "REMOTE 未設定(/etc/offsite-backup/offsite-backup.conf)" >&2; exit 1; }
DB_DIR=/var/backups/db
MIRROR=/var/backups/sakura/www-mirror
SNAP_DIR=/var/backups/sakura
KEEP_SNAPS=3
SECRETS_PUB=/etc/offsite-backup/secrets.pub.asc
SECRETS_DIR=/var/backups/secrets
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

GIT_ROOT=/home/debian
GIT_STATE=/var/lib/offsite-backup/git-state.tsv
MANIFEST=/var/lib/offsite-backup/manifest.tsv
MANIFEST_KEEP_DAYS=70   # git の古い bundle は 60 日残るのでそれより長く

fail_msgs=()

# 点検(backup-integrity-check)と同時に動かない
exec 9>/run/offsite-backup.lock
flock -w 600 9 || { echo "別のバックアップ/点検が動いています" >&2; exit 1; }

# put <vps-db|vps-secrets> <ファイル>: さくらへ新しいファイルとして置く(同名・同じ中身なら OK)
put() {
  local out
  out=$(ssh "${PUT_OPTS[@]}" "$REMOTE" "put $1 $(basename "$2")" < "$2" 2>&1)
  case "$out" in OK*) return 0 ;; *) echo "put $1/$(basename "$2"): $out" >&2; return 1 ;; esac
}

# keep_entry <名前>: 変わっていないリポジトリの最新 bundle は「まださくらにあるはず」として台帳の時刻を進める
keep_entry() {
  [ -f "$MANIFEST" ] || return 0
  awk -F'\t' -v OFS='\t' -v n="$1" -v t="$(date +%s)" '$2 == n { $4 = t } { print }' "$MANIFEST" > "$MANIFEST.tmp" \
    && chmod 600 "$MANIFEST.tmp" && mv -f "$MANIFEST.tmp" "$MANIFEST"
}

# record <種類 db|secrets|snap> <ファイル> <置き場所 local|both>: 台帳の同名の行を差し替える
record() {
  local h name
  h=$(sha256sum "$2" | cut -d' ' -f1) || { fail_msgs+=("指紋を取れない: $2"); return; }
  name=$(basename "$2")
  install -d -m 700 "${MANIFEST%/*}"; touch "$MANIFEST"
  { awk -F'\t' -v n="$name" '$2 != n' "$MANIFEST"
    printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$name" "$h" "$(date +%s)" "$3"; } > "$MANIFEST.tmp"
  chmod 600 "$MANIFEST.tmp"; mv -f "$MANIFEST.tmp" "$MANIFEST"
}

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
today=$(date +%Y%m%d)
shopt -s nullglob
dumps=("$DB_DIR"/*-"$today"-*.sql.gz "$DB_DIR"/*-"$today"-*.sql.gz.gpg)   # .gpg=別ホストの DB(db-backup の BACKUP_REMOTE_TARGETS)
if [ ${#dumps[@]} -eq 0 ]; then
  fail_msgs+=("当日のDBダンプが見つからない($DB_DIR)")
else
  n=0
  for f in "${dumps[@]}"; do
    if put vps-db "$f"; then record db "$f" both; n=$((n+1))
    else record db "$f" local; fail_msgs+=("DBダンプのさくらへの複製に失敗: $(basename "$f")"); fi
  done
  echo "OK  DBダンプ $n/${#dumps[@]} 件をさくらへ複製"
fi

# --- B) さくら ~/www → VPS ミラー ---
mkdir -p "$MIRROR"; chmod 700 "$SNAP_DIR"
# 鍵は rrsync で ~/www に限られているので、送り元は ~/www からの相対("./")
if rsync -a --delete --timeout=300 -e "ssh ${SSH_OPTS[*]}" "$REMOTE:./" "$MIRROR/"; then
  echo "OK  さくら www をミラー更新 ($(du -sh "$MIRROR" | cut -f1))"
else
  fail_msgs+=("さくら www の rsync ミラーに失敗")
fi

# --- C) 週次スナップショット(月曜) ---
if [ "$(date +%u)" = 1 ]; then
  snap="$SNAP_DIR/www-snap-$today.tar.gz"
  if tar -czf "$snap" -C "$MIRROR" . ; then
    echo "OK  週次スナップショット $(basename "$snap") ($(du -h "$snap" | cut -f1))"
    record snap "$snap" local
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
  # さくらは同名の上書きを受け付けないので、名前に時刻まで入れる
  out="$SECRETS_DIR/vps-secrets-$(date +%Y%m%d-%H%M%S).tar.gz.gpg"
  gh=$(mktemp -d /run/offsite-gpg.XXXXXX)
  tar -czf - -C / --warning=no-file-changed "${have[@]}" \
    | gpg --homedir "$gh" --batch --quiet --trust-model always \
          --recipient-file "$SECRETS_PUB" --encrypt -o "$out.tmp"
  rc=("${PIPESTATUS[@]}"); rm -rf "$gh"
  # tar の 1 は「読む間に変わった」だけなので通す
  if [ "${rc[0]}" -le 1 ] && [ "${rc[1]}" -eq 0 ] && [ -s "$out.tmp" ]; then
    mv -f "$out.tmp" "$out"; chmod 600 "$out"
    ls -1t "$SECRETS_DIR"/vps-secrets-*.tar.gz.gpg | tail -n +$((KEEP_SECRETS_LOCAL+1)) | xargs -r rm -f
    if put vps-secrets "$out"; then
      echo "OK  秘密情報を暗号化してさくらへ複製 ($(du -h "$out" | cut -f1)・${#have[@]} か所)"
      record secrets "$out" both
    else
      fail_msgs+=("秘密情報のさくらへの複製に失敗")
      record secrets "$out" local
    fi
  else
    rm -f "$out.tmp"; fail_msgs+=("秘密情報の暗号化に失敗 (tar=${rc[0]} gpg=${rc[1]})")
  fi
  # 別ホストの秘密情報(2026-11-19): 相手の上で同じ公開鍵で暗号化したものを受け取って置く(平文は相手から出ない)。
  #   offsite-backup.conf の REMOTE_SECRETS="名前|user@host|鍵 ..."。相手は鍵を command= で絞り、"secrets" で暗号文を出す。
  #   開けないので、この公開鍵あての暗号文かどうかだけを確かめる。
  read -r -a RSECRETS <<< "$(grep -E '^REMOTE_SECRETS=' /etc/offsite-backup/offsite-backup.conf 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"')"
  gh=$(mktemp -d /run/offsite-gpg.XXXXXX)
  want=$(gpg --homedir "$gh" --batch --with-colons --import-options show-only --import "$SECRETS_PUB" 2>/dev/null | awk -F: '$1 == "sub" { print $5 }')
  for t in "${RSECRETS[@]}"; do
    IFS='|' read -r nm dest key <<< "$t"
    out="$SECRETS_DIR/$nm-secrets-$(date +%Y%m%d-%H%M%S).tar.gz.gpg"
    ssh -i "$key" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=20 \
        -o UserKnownHostsFile=/home/debian/.ssh/known_hosts "$dest" secrets </dev/null > "$out.tmp" 2>/dev/null
    src=$?
    got=$(gpg --homedir "$gh" --batch --list-packets "$out.tmp" 2>/dev/null | awk '/^:pubkey enc packet:/ { print $NF }')
    if [ "$src" -eq 0 ] && [ -n "$got" ] && grep -qxF "$got" <<< "$want" && [ "$(stat -c %s "$out.tmp")" -gt 1024 ]; then
      mv -f "$out.tmp" "$out"; chmod 600 "$out"
      ls -1t "$SECRETS_DIR/$nm"-secrets-*.tar.gz.gpg | tail -n +$((KEEP_SECRETS_LOCAL+1)) | xargs -r rm -f
      if put vps-secrets "$out"; then
        echo "OK  $nm の秘密情報(相手の上で暗号化済み)をさくらへ複製 ($(du -h "$out" | cut -f1))"
        record secrets "$out" both
      else
        fail_msgs+=("$nm の秘密情報のさくらへの複製に失敗"); record secrets "$out" local
      fi
    else
      rm -f "$out.tmp"; fail_msgs+=("$nm の秘密情報を受け取れない (ssh=$src 宛先の鍵=${got:-なし})")
    fi
  done
  rm -rf "$gh"
else
  fail_msgs+=("暗号化の公開鍵がない($SECRETS_PUB)")
fi

# --- E) git リポジトリの全履歴 → さくら(変わったものだけ) ---
install -d -m 700 "${GIT_STATE%/*}"; touch "$GIT_STATE"; chmod 600 "$GIT_STATE"
gtmp=$(mktemp -d /run/offsite-git.XXXXXX)
ng=0; nk=0
while IFS= read -r repo; do
  id=$(printf '%s' "${repo#"$GIT_ROOT"/}" | tr '/' '_')
  refs=$(git -c safe.directory="$repo" -C "$repo" show-ref --head 2>/dev/null | sha256sum | cut -c1-16)
  prev=$(awk -F'\t' -v i="$id" '$1 == i { print $2 "\t" $3 }' "$GIT_STATE")
  if [ -n "$prev" ] && [ "${prev%%$'\t'*}" = "$refs" ]; then
    keep_entry "${prev#*$'\t'}"; nk=$((nk+1)); continue
  fi
  b="$gtmp/$id-$(date +%Y%m%d-%H%M%S).bundle"
  if git -c safe.directory="$repo" -C "$repo" bundle create -q "$b" --all 2>/dev/null && put vps-git "$b"; then
    record git "$b" remote
    { awk -F'\t' -v i="$id" '$1 != i' "$GIT_STATE"; printf '%s\t%s\t%s\n' "$id" "$refs" "$(basename "$b")"; } > "$GIT_STATE.tmp" \
      && mv -f "$GIT_STATE.tmp" "$GIT_STATE"
    ng=$((ng+1))
  else
    fail_msgs+=("git の全履歴をさくらへ置けない: $id")
  fi
  rm -f "$b"
done < <(find "$GIT_ROOT" -maxdepth 4 -type d -name .git -not -path '*/node_modules/*' -not -path '*/.cache/*' 2>/dev/null \
           | sed 's|/\.git$||' | sort)
rm -rf "$gtmp"
echo "OK  git の全履歴: 送った $ng・変わらず $nk"

# --- 台帳: 保持期間を過ぎた行を落とし、さくらにも置く ---
if [ -f "$MANIFEST" ]; then
  awk -F'\t' -v lim="$(( $(date +%s) - MANIFEST_KEEP_DAYS*86400 ))" '$4 >= lim' "$MANIFEST" > "$MANIFEST.tmp" \
    && chmod 600 "$MANIFEST.tmp" && mv -f "$MANIFEST.tmp" "$MANIFEST"
  case "$(ssh "${PUT_OPTS[@]}" "$REMOTE" manifest < "$MANIFEST" 2>&1)" in
    OK*) ;; *) fail_msgs+=("台帳のさくらへの複製に失敗") ;;
  esac
fi

if [ ${#fail_msgs[@]} -gt 0 ]; then
  printf 'FAIL %s\n' "${fail_msgs[@]}"
  notify_fail
  exit 1
fi
echo "offsite-backup 完了"
