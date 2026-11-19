#!/usr/bin/env python3
"""backup-integrity-check — バックアップが書き換えられていないかの点検 (2026-11-16)

offsite-backup.sh がバックアップを作るたびに指紋(SHA-256)を台帳 /var/lib/offsite-backup/manifest.tsv に残し、
同じ台帳をさくら ~/backups/manifest.tsv にも置く。この点検は毎朝それと照らし合わせる。

  1. VPS のバックアップ(DB ダンプ・暗号化した秘密情報・www のスナップショット)が台帳の指紋と一致する
  2. さくらの写し(vps-db/・vps-secrets/・vps-git/)が台帳の指紋と一致する
  3. 台帳にない新しいファイルが紛れ込んでいない・保持期間内のファイルが消えていない
  4. VPS とさくらの台帳が同じ(片方だけ書き換えても気づく)
  5. VPS の置き場が root 専用(700)で、ファイルが他人から書けない
  6. さくらの中の www の週ごとの写し(backup-rotate が作る)が 8 日より古くない
さくらへはバックアップ専用鍵で入り、受け取り口(~/bin/backup-recv)の list だけを使う。

問題が無ければ journal に 1 行だけ。違いがあれば ntfy に高優先で知らせる(service-watchdog.conf の ntfy を共用)。
  --init  台帳に無い既存ファイルを今の中身で登録する(設置時に 1 回)
  --no-notify  知らせずに結果を表示だけする(試験用)
"""
import base64
import fcntl
import glob
import hashlib
import os
import re
import socket
import stat
import subprocess
import sys
import time
import urllib.request

MANIFEST = "/var/lib/offsite-backup/manifest.tsv"
REMOTE_CONF = "/etc/offsite-backup/offsite-backup.conf"
NTFY_CONF = "/etc/service-watchdog.conf"
SSH_OPTS = ["-i", "/etc/offsite-backup/backup_ed25519", "-o", "IdentitiesOnly=yes",
            "-o", "UserKnownHostsFile=/home/debian/.ssh/known_hosts",
            "-o", "BatchMode=yes", "-o", "ConnectTimeout=20"]
DAY = 86400

# 種類ごとの置き場と保持(offsite-backup.sh / db-backup.sh と合わせる)
LOCAL = {
    "db": ("/var/backups/db", "*.sql.gz*"),   # .sql.gz.gpg=別ホストの DB(暗号化済み)
    "secrets": ("/var/backups/secrets", "vps-secrets-*.tar.gz.gpg"),
    "snap": ("/var/backups/sakura", "www-snap-*.tar.gz"),
}
LOCAL_KEEP_DAYS = {"db": 7}            # 日数で消すもの
LOCAL_KEEP_NEWEST = {"secrets": 3, "snap": 3}   # 新しい順に n 個残すもの
REMOTE = {"db": ("vps-db", 14), "secrets": ("vps-secrets", 30), "git": ("vps-git", 60)}
WWW_SNAP_MAX_DAYS = 8


def conf_value(path, key):
    try:
        with open(path) as f:
            val = ""
            for line in f:
                line = line.strip()
                if line.startswith(key + "="):
                    val = line.split("=", 1)[1].split("#", 1)[0].strip().strip('"').strip("'")
            return val
    except OSError:
        return ""


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def load_manifest():
    m = {}
    try:
        with open(MANIFEST) as f:
            for line in f:
                p = line.rstrip("\n").split("\t")
                if len(p) == 5:
                    m[p[1]] = {"kind": p[0], "sha": p[2], "ts": int(p[3]), "where": p[4]}
    except FileNotFoundError:
        pass
    return m


def save_manifest(m):
    os.makedirs(os.path.dirname(MANIFEST), mode=0o700, exist_ok=True)
    tmp = MANIFEST + ".tmp"
    with open(tmp, "w") as f:
        for name, e in sorted(m.items(), key=lambda x: (x[1]["ts"], x[0])):
            f.write(f"{e['kind']}\t{name}\t{e['sha']}\t{e['ts']}\t{e['where']}\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, MANIFEST)


def remote_run(remote, cmd, stdin=None):
    """受け取り口(backup-recv)へ list / manifest を送る"""
    r = subprocess.run(["ssh", *SSH_OPTS, remote, cmd], input=stdin, capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        raise RuntimeError(f"さくらに接続できません(rc={r.returncode}): {(r.stderr or r.stdout).strip()[:200]}")
    return r.stdout


def remote_state(remote):
    """さくらの写しの指紋 {kind: {name: sha}}・www の写し [(mtime, size, name)]・さくらの台帳の中身を返す"""
    out = remote_run(remote, "list")
    files, snaps, man = {k: {} for k in REMOTE}, [], None
    head, _, rest = out.partition("--www-snap--\n")
    snap_part, sep, tail = rest.partition("--manifest--\n")
    by_dir = {d: k for k, (d, _) in REMOTE.items()}
    for line in head.splitlines():
        sha, _, rel = line.partition(" ")
        d, _, name = rel.partition("/")
        if d in by_dir:
            files[by_dir[d]][name] = sha
    for line in snap_part.splitlines():
        p = line.split(" ", 2)
        if len(p) == 3 and p[0].isdigit():
            snaps.append((int(p[0]), int(p[1]), p[2]))
    if sep:
        man = tail
    return files, snaps, man


def notify(title, body, prio="high", tags="rotating_light"):
    topic = conf_value(NTFY_CONF, "NTFY_TOPIC")
    if not topic:
        return
    url = (conf_value(NTFY_CONF, "NTFY_URL") or "https://ntfy.sh").rstrip("/") + "/" + topic
    # ntfy の Title は ASCII 以外を RFC 2047 で渡す
    req = urllib.request.Request(url, data=body.encode(), method="POST", headers={
        "Title": "=?UTF-8?B?" + base64.b64encode(title.encode()).decode() + "?=",
        "Priority": prio, "Tags": tags})
    try:
        urllib.request.urlopen(req, timeout=10).read()
    except Exception as e:  # 通知の失敗で点検を落とさない
        print(f"通知に失敗: {e}")


def name_ts(name, default):
    """ファイル名の YYYYmmdd から作成日を推す(さくらにしか無い古い写しの登録用)"""
    mt = re.search(r"-(\d{8})(?:-|\.)", name)
    return int(time.mktime(time.strptime(mt.group(1), "%Y%m%d"))) if mt else default


def lock():
    """offsite-backup と同時に動かない(作りかけのファイルを書き換えと見誤らない)"""
    f = open("/run/offsite-backup.lock", "w")
    for _ in range(600):
        try:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return f
        except BlockingIOError:
            time.sleep(1)
    raise SystemExit("バックアップが 10 分以上動いているため点検を見送りました")


def main():
    init = "--init" in sys.argv[1:]
    _lk = lock()
    now = int(time.time())
    m = load_manifest()
    issues, added = [], []
    remote = conf_value(REMOTE_CONF, "REMOTE")

    # 1・3・5) VPS のバックアップ
    for kind, (d, pat) in LOCAL.items():
        try:
            st = os.stat(d)
            if st.st_uid != 0 or stat.S_IMODE(st.st_mode) & 0o077:
                issues.append(f"置き場 {d} が root 専用ではありません(所有 uid {st.st_uid}・{oct(stat.S_IMODE(st.st_mode))})")
        except FileNotFoundError:
            continue
        present = set()
        for p in sorted(glob.glob(os.path.join(d, pat))):
            if p.endswith(".tmp"):   # 書き込み途中
                continue
            name = os.path.basename(p)
            present.add(name)
            fst = os.stat(p)
            if fst.st_uid != 0 or fst.st_mode & 0o022:
                issues.append(f"{p} が root 以外から書ける状態です({oct(stat.S_IMODE(fst.st_mode))}・uid {fst.st_uid})")
            h = sha256(p)
            e = m.get(name)
            if e is None:
                if init:
                    m[name] = {"kind": kind, "sha": h, "ts": int(fst.st_mtime), "where": "local"}
                    added.append(name)
                else:
                    issues.append(f"台帳にないバックアップがあります: {p}")
            elif e["sha"] != h:
                issues.append(f"中身が台帳と違います(書き換えの疑い): {p}")
        recorded = sorted((e["ts"], n) for n, e in m.items() if e["kind"] == kind and e["where"] != "remote")
        newest = {n for _, n in recorded[-LOCAL_KEEP_NEWEST[kind]:]} if kind in LOCAL_KEEP_NEWEST else set()
        for ts, n in recorded:
            if n in present:
                continue
            gone_early = (kind in LOCAL_KEEP_DAYS and now - ts < LOCAL_KEEP_DAYS[kind] * DAY) or n in newest
            if gone_early:
                issues.append(f"保持期間内のバックアップが VPS から消えています: {d}/{n}")

    # 2・3・4) さくらの写しと台帳
    if not remote:
        issues.append(f"送り先が未設定のため、さくら側を確かめられません({REMOTE_CONF})")
    else:
        try:
            rfiles, snaps, rman = remote_state(remote)
        except Exception as e:
            issues.append(str(e))
            rfiles, snaps, rman = None, [], None
        expected = [n for n, e in m.items() if e["where"] != "local" and e["kind"] in REMOTE]
        if rfiles is not None and expected and not any(rfiles.values()):
            # 1 件ずつ並べると数十行になるので 1 行にまとめる
            issues.append(f"さくらの写しが 1 件も見えません(台帳では {len(expected)} 件。全部消された、"
                          "または受け取り口 ~/bin/backup-recv の一覧が壊れている)")
            rfiles = {k: None for k in REMOTE}
        if rfiles is not None:
            for kind, (d, keep) in REMOTE.items():
                if rfiles[kind] is None:
                    continue
                for name, h in sorted(rfiles[kind].items()):
                    e = m.get(name)
                    if init and (e is None or e["where"] == "local") and (e is None or e["sha"] == h):
                        if e is None:
                            m[name] = {"kind": kind, "sha": h, "ts": name_ts(name, now), "where": "remote"}
                        else:
                            e["where"] = "both"
                        added.append(f"さくら {d}/{name}")
                    elif e is None:
                        issues.append(f"さくらに台帳にないファイルがあります: {d}/{name}")
                    elif e["sha"] != h:
                        issues.append(f"さくらの写しが台帳と違います(書き換えの疑い): {d}/{name}")
                for n, e in m.items():
                    if e["kind"] == kind and e["where"] != "local" and n not in rfiles[kind] \
                            and now - e["ts"] < (keep - 1) * DAY:
                        issues.append(f"保持期間内の写しがさくらから消えています: {d}/{n}")
            newest = max((t for t, _, _ in snaps), default=0)
            if not snaps:
                issues.append("さくらの中に www の週ごとの写しがありません(backup-rotate の cron を確認)")
            elif now - newest > WWW_SNAP_MAX_DAYS * DAY:
                issues.append(f"さくらの www の写しが {int((now - newest) / DAY)} 日前で止まっています(backup-rotate の cron を確認)")
            if init:
                save_manifest(m)
                remote_run(remote, "manifest", stdin=open(MANIFEST).read())
                rman = open(MANIFEST).read()
            if rman is None:
                issues.append("さくらに台帳(backups/manifest.tsv)がありません")
            elif not os.path.exists(MANIFEST) or rman != open(MANIFEST).read():
                issues.append("VPS とさくらの台帳が一致しません(どちらかが書き換えられた疑い)")

    if init:
        save_manifest(m)
        print(f"台帳に登録: {len(added)} 件" + ("\n  " + "\n  ".join(added) if added else ""))
    host = socket.gethostname().split(".")[0]
    if not issues:
        n = sum(1 for e in m.values())
        print(f"backup integrity OK: 台帳 {n} 件・VPS とさくらの写しが一致")
        return 0
    body = f"⚠ バックアップの点検で違いが見つかりました({host})\n\n" + "\n".join(f"- {i}" for i in issues) \
        + "\n\n" + time.strftime("%F %T %Z")
    print(body)
    if "--no-notify" not in sys.argv[1:]:
        notify("backup integrity: 要確認", body)
    return 1


if __name__ == "__main__":
    sys.exit(main())
