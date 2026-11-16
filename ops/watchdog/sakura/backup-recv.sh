#!/bin/sh
# offsite-backup の受け取り口(さくら側・2026-11-16)。~/bin/backup-recv に置き、VPS のバックアップ専用鍵の
# authorized_keys に restrict,command="/bin/sh /home/<アカウント>/bin/backup-recv" を付けて呼ばせる。
# VPS が乗っ取られても過去の写しを消させないため、この鍵でできるのは次の 3 つだけ:
#   put <vps-db|vps-secrets|vps-git> <名前>  標準入力を新しいファイルとして置く(同名があれば同じ中身のときだけ OK・上書き不可)
#   manifest                         指紋の台帳(manifest.tsv)を差し替える
#   list                             写しの指紋・台帳・www のスナップショットの一覧(backup-integrity-check 用)
# 削除は backup-rotate(さくらの cron)だけが行う。
set -u
set -f
umask 077
B=$HOME/backups
MAX=209715200   # 1 ファイル 200MB まで(容量を食い潰されないように)
log() { echo "$(date '+%F %T') $*" >> "$B/recv.log"; }
mkdir -p "$B"
# shellcheck disable=SC2086
set -- ${SSH_ORIGINAL_COMMAND:-}
case "${1:-}" in
put)
  [ $# -eq 3 ] || { echo "ERR usage"; exit 2; }
  dir=$2; name=$3
  case "$dir" in vps-db|vps-secrets|vps-git) ;; *) echo "ERR dir"; exit 2 ;; esac
  printf '%s' "$name" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$' || { echo "ERR name"; exit 2; }
  mkdir -p "$B/$dir"
  tmp="$B/.incoming.$$"
  head -c "$MAX" > "$tmp" || { rm -f "$tmp"; echo "ERR write"; exit 1; }
  [ "$(stat -f %z "$tmp")" -lt "$MAX" ] || { rm -f "$tmp"; log "REFUSE too-large $dir/$name"; echo "ERR size"; exit 2; }
  dst="$B/$dir/$name"
  if [ -e "$dst" ]; then
    if cmp -s "$tmp" "$dst"; then rm -f "$tmp"; echo "OK same"; exit 0; fi
    rm -f "$tmp"; log "REFUSE overwrite $dir/$name"; echo "ERR exists"; exit 3
  fi
  chmod 400 "$tmp"
  mv -n "$tmp" "$dst"
  if [ -e "$tmp" ]; then rm -f "$tmp"; echo "ERR exists"; exit 3; fi
  log "PUT $dir/$name $(stat -f %z "$dst")"
  echo "OK"
  ;;
manifest)
  [ $# -eq 1 ] || { echo "ERR usage"; exit 2; }
  tmp="$B/.manifest.$$"
  head -c 1048576 > "$tmp" && chmod 600 "$tmp" && mv -f "$tmp" "$B/manifest.tsv" || { rm -f "$tmp"; echo "ERR write"; exit 1; }
  echo "OK"
  ;;
list) set +f   # 引数の解釈では展開を止めているが、一覧では * を使う
  [ $# -eq 1 ] || { echo "ERR usage"; exit 2; }
  cd "$B" || exit 1
  for d in vps-db vps-secrets vps-git; do
    for f in "$d"/*; do [ -f "$f" ] && sha256 -r "$f"; done
  done
  echo '--www-snap--'
  for f in www-snap/*.tar.gz; do [ -f "$f" ] && echo "$(stat -f '%m %z' "$f") ${f#www-snap/}"; done
  echo '--manifest--'
  cat manifest.tsv 2>/dev/null
  true
  ;;
*)
  log "REFUSE command: $(printf '%.80s' "${SSH_ORIGINAL_COMMAND:-}")"
  echo "ERR command"; exit 2
  ;;
esac
