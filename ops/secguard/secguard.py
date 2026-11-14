#!/usr/bin/env python3
"""
secguard — VPS の外部に面した部分の見張り番(2026-11-14)

外から届く口(Caddy の 8 サイト・CATVPN/EZOS-Admin・SSH)と、公開サービスの中身(専用ユーザー ogn/navlog/notam/
takikawa と docker の flightlog/postgres)を見張り、攻撃らしい動きを ntfy で知らせる。対処は段階を踏む:

  1. Web で攻撃と判定した送信元 IP → ipset secguard-ban に期限付き(既定 24 時間)で入れて遮断
     (raw PREROUTING で落とすので、ホスト宛ても docker の 80/443 宛ても届かない)
  2. 乗っ取りの強い兆候 → そのサービスだけを止める(最終の対策。システム全体には広げない)
       - 公開サービスの専用ユーザーが内部(EZOS・SSH・登録 API・VPN・docker 網)へ出ようとした(SECGUARD-EGRESS)
       - 公開サービスの専用ユーザーがシェル・ネット道具・sudo などを実行した(auditd: sg_exec)
       - 公開サービスの専用ユーザーが sudo を試みた(journald: sudo)
       - 見覚えのない実行・新しい待ち受けポート(学習期間の後)
     止めたサービスは /var/lib/secguard/quarantine/<名前> を置き、systemd の条件(90-secguard.conf)と
     service-watchdog の両方が起こし直さない。戻すのは浩さんが確かめてから `secguard-release <名前>`。
  3. 管理者の設定(アカウント・sudoers・SSH の鍵・systemd・/usr/local/bin・WireGuard)の書き換え → 通知だけ

入力(どれも外から来た文字列を含むので、解析は json/正規表現だけで行い、シェルには渡さない。IP は ipaddress で検証):
  - /home/debian/saas/caddy/data/logs/*.access.log(Caddy の JSON。回転に追随)
  - journalctl -f(カーネルの SECGUARD-*・sshd・sudo)
  - /var/log/audit/audit.log(auditd の sg_* 鍵)
  - ss -lntu(待ち受けポートの増減を 60 秒ごと)

  secguard.py              常駐(secguard.service)
  secguard.py --test-web   Caddy の記録を最初から読み、判定だけ表示(遮断も通知もしない)
"""
import collections
import ipaddress
import json
import os
import re
import select
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path

CONF_PATH = os.environ.get("SECGUARD_CONF", "/etc/secguard.conf")
STATE_DIR = Path(os.environ.get("SECGUARD_STATE", "/var/lib/secguard"))
QUAR_DIR = STATE_DIR / "quarantine"
CADDY_LOG_DIR = Path("/home/debian/saas/caddy/data/logs")
AUDIT_LOG = Path("/var/log/audit/audit.log")
WATCHDOG_CONF = "/etc/service-watchdog.conf"
IPSET = "secguard-ban"
TEST = "--test-web" in sys.argv

# ── 設定(/etc/secguard.conf。KEY=VALUE。無ければ既定) ─────────────────────────────
def load_conf():
    c = {
        "BAN_SEC": "86400",            # 遮断の期限(秒)
        "BAN_MAX_PER_HOUR": "300",     # 1 時間に遮断する上限(暴走防止。超えたら通知して止める)
        "WEB_WINDOW_SEC": "600",       # Web の点数を数える時間幅
        "WEB_BAN_SCORE": "10",         # この点数で遮断(探り=1・危険な要求=5・認証失敗=1)
        "WEB_404_BAN": "80",           # 時間幅内の 404 がこの数で遮断
        "WEB_FLOOD_REQ": "3000",       # 5 分間の要求数がこの数で遮断(1 秒 10 件相当)
        "LEARN_UNTIL": "0",            # この時刻(epoch)までは見覚えのない実行・待ち受けを覚えるだけ(止めない)
        "DIGEST_SEC": "1800",          # 遮断・設定変更のまとめ通知の間隔
        "NOTIFY_MAX_PER_HOUR": "30",   # 通知の上限(至急の停止の通知は数えない)
        "ALLOW_IPS": "",               # 遮断しない IP/CIDR(空白区切り。自宅・事務所など。repo には書かない)
        "ACTION": "enforce",           # enforce=遮断・停止する / observe=知らせるだけ
    }
    try:
        for line in open(CONF_PATH, encoding="utf-8"):
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            c[k.strip()] = v.split("#", 1)[0].strip().strip('"')
    except FileNotFoundError:
        pass
    return c

CONF = load_conf()
I = lambda k: int(CONF[k])
ENFORCE = CONF["ACTION"] == "enforce" and not TEST

# ── 守る対象(uid → 止める単位) ─────────────────────────────────────────────────
# group: 隔離の名前(quarantine のファイル名)。units: 止める systemd ユニット(タイマーも)。
# docker: 止めるコンテナ。watchdog: service-watchdog の名前(隔離中は起こし直さない)。
# exe: その uid が実行してよいもの(実体のパス)。ppid が 1(systemd が起動)なら起動として扱う。
TARGETS = {
    "ogn": {"user": "ogn", "units": ["ogn-web", "ogn-collect", "ogn-web-drone", "ogn-web-dropzones", "ogn-web-amedas",
                                    "ogn-web-wind", "ogn-notify-receivers"],
            "timers": ["ogn-web-drone", "ogn-web-dropzones", "ogn-web-amedas", "ogn-web-wind", "ogn-notify-receivers"],
            "watchdog": ["ogn-web", "ogn-collect"], "exe": ["/usr/bin/node", "/usr/bin/python3.11"]},
    "navlog": {"user": "navlog", "units": ["navlog"], "watchdog": ["navlog"], "exe": ["/usr/bin/node"]},
    "notam": {"user": "notam", "units": ["notam"], "watchdog": ["notam"], "exe": ["/usr/bin/node"]},
    "takikawa": {"user": "takikawa", "units": ["takikawa-web"], "watchdog": ["takikawa"], "exe": ["/usr/bin/node"]},
    "flightlog": {"uid": 1001, "docker": ["flightlog-app"], "watchdog": ["flightlog"], "exe": ["/usr/local/bin/node"]},
    "postgres": {"uid": 70, "docker": ["saas-postgres", "flightlog-app"], "watchdog": ["flightlog"],
                 "exe": ["/usr/local/bin/postgres"]},
}
UID2GROUP = {}
for g, t in TARGETS.items():
    uid = t.get("uid")
    if uid is None:
        try:
            import pwd
            uid = pwd.getpwnam(t["user"]).pw_uid
        except KeyError:
            continue
    UID2GROUP[int(uid)] = g
USER2GROUP = {t["user"]: g for g, t in TARGETS.items() if "user" in t}

DANGEROUS = {"sh", "bash", "dash", "zsh", "ash", "ksh", "busybox", "nc", "ncat", "netcat", "socat", "curl", "wget",
             "perl", "ruby", "php", "telnet", "ssh", "scp", "sftp", "nmap", "python2", "sudo", "su", "crontab",
             "chmod", "chown", "base64", "xmrig", "gcc", "cc", "make", "tftp", "ftp", "openssl", "awk", "gawk", "mawk"}

# VPN の中・内部・自分自身は遮断しない
NEVER_BAN = [ipaddress.ip_network(n) for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8",
                                               "160.16.105.64/32", "::1/128", "fc00::/7", "fe80::/10")]
for n in CONF["ALLOW_IPS"].split():
    try:
        NEVER_BAN.append(ipaddress.ip_network(n, strict=False))
    except ValueError:
        pass

# ── 記録・通知 ───────────────────────────────────────────────────────────────────
def log(msg):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), msg, flush=True)

EVENTS = STATE_DIR / "events.jsonl"
def event(kind, **kw):
    """検知・遮断・停止を events.jsonl に残す(5MB で回し 4 世代)"""
    if TEST:
        return
    rec = {"ts": round(time.time(), 3), "kind": kind, **kw}
    try:
        if EVENTS.exists() and EVENTS.stat().st_size > 5 * 1024 * 1024:
            for i in range(3, 0, -1):
                a = STATE_DIR / f"events.jsonl.{i}"
                if a.exists():
                    a.rename(STATE_DIR / f"events.jsonl.{i + 1}")
            EVENTS.rename(STATE_DIR / "events.jsonl.1")
        with open(EVENTS, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except OSError as e:
        log(f"event write failed: {e}")

def read_ntfy():
    url, topic = "https://ntfy.sh", ""
    try:
        for line in open(WATCHDOG_CONF, encoding="utf-8"):
            m = re.match(r'\s*(NTFY_URL|NTFY_TOPIC)=["\']?([^"\'\s#]+)', line)
            if m:
                if m.group(1) == "NTFY_URL":
                    url = m.group(2)
                else:
                    topic = m.group(2)
    except OSError:
        pass
    return url.rstrip("/"), topic

_sent = collections.deque()
def notify(title, body, priority="default", tags="shield", force=False):
    log(f"NOTIFY[{priority}] {title} | {body[:300]!r}")
    if TEST:
        return
    now = time.time()
    while _sent and now - _sent[0] > 3600:
        _sent.popleft()
    if not force and len(_sent) >= I("NOTIFY_MAX_PER_HOUR"):
        return
    _sent.append(now)
    url, topic = read_ntfy()
    if not topic:
        return
    try:
        import base64
        t = "=?UTF-8?B?" + base64.b64encode(title.encode("utf-8")).decode("ascii") + "?="
        req = urllib.request.Request(f"{url}/{topic}", data=body[:3500].encode("utf-8"), method="POST",
                                     headers={"Title": t, "Priority": priority, "Tags": tags})
        urllib.request.urlopen(req, timeout=10).read()
    except Exception as e:  # noqa: BLE001
        log(f"notify failed: {e}")

HOST = os.uname().nodename
def stamp():
    return time.strftime("%Y-%m-%d %H:%M:%S JST") + " " + HOST

# ── 遮断(ipset) ─────────────────────────────────────────────────────────────────
BANS_FILE = STATE_DIR / "bans.json"
bans = {}          # ip -> {"until":, "reason":}
_ban_times = collections.deque()
_ban_paused = False
pending_digest = {"bans": [], "changes": [], "info": []}

def valid_public_ip(s):
    try:
        ip = ipaddress.ip_address(s)
    except ValueError:
        return None
    if ip.version != 4:   # 外部 IPv6 は受けていない(ip6tables で DROP)
        return None
    if any(ip in n for n in NEVER_BAN):
        return None
    return str(ip)

def ipset_add(ip, sec):
    subprocess.run(["ipset", "add", IPSET, ip, "timeout", str(int(sec)), "-exist"], check=False,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def save_bans():
    if TEST:
        return
    try:
        tmp = BANS_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(bans, ensure_ascii=False))
        tmp.replace(BANS_FILE)
    except OSError as e:
        log(f"save bans failed: {e}")

def restore_bans():
    global bans
    try:
        bans = json.loads(BANS_FILE.read_text())
    except (OSError, ValueError):
        bans = {}
    now = time.time()
    bans = {ip: b for ip, b in bans.items() if b.get("until", 0) > now and valid_public_ip(ip)}
    if ENFORCE:
        subprocess.run(["ipset", "create", IPSET, "hash:ip", "timeout", str(I("BAN_SEC")), "-exist"], check=False)
        for ip, b in bans.items():
            ipset_add(ip, b["until"] - now)
    log(f"restored {len(bans)} bans")

def ban(ip, reason, detail=""):
    global _ban_paused
    ip = valid_public_ip(ip)
    if not ip or ip in bans:
        return
    now = time.time()
    while _ban_times and now - _ban_times[0] > 3600:
        _ban_times.popleft()
    if len(_ban_times) >= I("BAN_MAX_PER_HOUR"):
        if not _ban_paused:
            _ban_paused = True
            notify("secguard: 遮断の上限に達しました",
                   f"1時間に {I('BAN_MAX_PER_HOUR')} 件を遮断したため、新しい遮断を一時的に止めています(大規模な攻撃か誤判定の疑い)。\n"
                   f"記録: {EVENTS}\n{stamp()}", "high", "rotating_light", force=True)
        event("ban_skipped", ip=ip, reason=reason)
        return
    _ban_paused = False
    _ban_times.append(now)
    sec = I("BAN_SEC")
    bans[ip] = {"until": now + sec, "reason": reason, "detail": detail[:200]}
    if ENFORCE:
        ipset_add(ip, sec)
    save_bans()
    event("ban", ip=ip, reason=reason, detail=detail[:300], enforced=ENFORCE)
    pending_digest["bans"].append(f"{ip} {reason}{(' ' + detail[:80]) if detail else ''}")
    log(f"BAN {ip} {reason} {detail[:120]}")

# ── 隔離(サービスの停止) ──────────────────────────────────────────────────────────
quarantined = set()

def quarantine(group, why, detail):
    t = TARGETS.get(group)
    if not t or group in quarantined:
        return
    quarantined.add(group)
    event("quarantine", group=group, why=why, detail=detail[:500], enforced=ENFORCE)
    stopped = []
    if ENFORCE:
        QUAR_DIR.mkdir(parents=True, exist_ok=True)
        for name in [group] + t.get("watchdog", []):
            (QUAR_DIR / name).write_text(f"{time.time()} {why}\n{detail[:500]}\n")
        for tm in t.get("timers", []):
            subprocess.run(["systemctl", "stop", f"{tm}.timer"], check=False)
        for u in t.get("units", []):
            subprocess.run(["systemctl", "stop", f"{u}.service"], check=False)
            stopped.append(u)
        for c in t.get("docker", []):
            subprocess.run(["docker", "update", "--restart=no", c], check=False, stdout=subprocess.DEVNULL)
            subprocess.run(["docker", "stop", "-t", "5", c], check=False, stdout=subprocess.DEVNULL)
            stopped.append(c)
    act = ("停止しました: " + ", ".join(stopped)) if ENFORCE else "観察モードのため停止していません"
    notify(f"secguard 至急: {group} を隔離",
           f"乗っ取りの強い兆候: {why}\n{detail[:900]}\n\n{act}\n"
           f"他のサービスとシステムは動いています。確かめてから `sudo secguard-release {group}` で戻します。\n{stamp()}",
           "urgent", "rotating_light,stop_sign", force=True)
    log(f"QUARANTINE {group} {why} {detail[:200]}")

def load_quarantined():
    if QUAR_DIR.exists():
        for p in QUAR_DIR.iterdir():
            if p.name in TARGETS:
                quarantined.add(p.name)

# ── 学習(見覚えのない実行・待ち受け) ───────────────────────────────────────────────
LEARN_FILE = STATE_DIR / "learned.json"
try:
    learned = json.loads(LEARN_FILE.read_text())
except (OSError, ValueError):
    learned = {"exe": {}, "listen": []}

def learning():
    return time.time() < int(CONF["LEARN_UNTIL"] or 0)

def save_learned():
    try:
        LEARN_FILE.write_text(json.dumps(learned, ensure_ascii=False, indent=1))
    except OSError:
        pass

# ── Web(Caddy の記録) ─────────────────────────────────────────────────────────────
PROBE = re.compile(r"(/\.env|/\.git|/\.svn|/\.hg|/\.aws|/\.ssh|/\.docker|/\.vscode|/\.DS_Store|wp-login|wp-admin|"
                   r"wp-content|wp-includes|xmlrpc\.php|phpmyadmin|/pma/|\.php\b|/cgi-bin/|/actuator|/server-status|"
                   r"/vendor/phpunit|/boaform|/HNAP1|/config\.json|/credentials|\.sql\b|\.bak\b|"
                   r"/backup|\.tar(\.gz)?\b|\.zip\b|/druid|/solr|/jenkins|/manager/html|/owa/|/autodiscover|/telescope|"
                   r"/_ignition|/geoserver|/hudson|/console\b|/shell\b|/wls-wsat|/invoker|/jmx-console|/setup\.cgi|/GponForm)",
                   re.I)
CRITICAL = re.compile(r"(\$\{jndi:|\$\{\$\{|\.\./\.\./|%2e%2e%2f|%2e%2e/|\.\.%2f|/etc/passwd|/etc/shadow|/proc/self/|"
                      r"union(\s|%20|\+)+select|select(\s|%20|\+).+from(\s|%20|\+)|sleep\(\d|benchmark\(|"
                      r"<script|%3cscript|javascript:|onerror=|php://|data://|expect://|file://|"
                      r"cmd=|exec=|/bin/(ba)?sh|wget(\s|%20|\+)|curl(\s|%20|\+)|;(\s|%20)*(id|uname|cat)\b|"
                      r"\|\s*(id|uname|sh)\b|base64_decode|eval\(|system\(|passthru|shell_exec|allow_url_include)", re.I)
web_score = collections.defaultdict(collections.deque)    # ip -> deque[(ts, pts, what)]
web_404 = collections.defaultdict(collections.deque)
web_req = collections.defaultdict(collections.deque)
web_5xx = collections.defaultdict(collections.deque)     # host -> deque[ts]
web_5xx_last = {}

def _trim(dq, now, win):
    while dq and now - dq[0][0] > win:
        dq.popleft()

def on_web(d, fname):
    r = d.get("request") or {}
    ip = r.get("client_ip") or r.get("remote_ip") or ""
    uri = str(r.get("uri", ""))[:2000]
    host = str(r.get("host", ""))[:100]
    st = int(d.get("status") or 0)
    ts = float(d.get("ts") or time.time())
    ctype = ""
    try:
        ctype = (d.get("resp_headers") or {}).get("Content-Type", [""])[0]
    except (AttributeError, IndexError, TypeError):
        pass
    if not valid_public_ip(ip):
        return
    win = I("WEB_WINDOW_SEC")
    # 量(5 分)
    q = web_req[ip]; q.append((ts, 1, "")); _trim(q, ts, 300)
    if len(q) >= I("WEB_FLOOD_REQ"):
        ban(ip, "大量の要求", f"{len(q)}件/5分 {host}"); q.clear()
    # 5xx の多発(ホスト単位・記録とまとめ通知だけ。障害は service-watchdog が受け持つ。
    # 上流の不調で 5xx を返し続ける API(例 navlog の ATIS)があるので至急の通知にはしない)
    if st >= 500:
        h = web_5xx[host]; h.append((ts, 1, "")); _trim(h, ts, 300)
        if len(h) >= 50 and ts - web_5xx_last.get(host, 0) > 3600:
            web_5xx_last[host] = ts
            event("web_5xx_burst", host=host, count=len(h), last_uri=uri[:200])
            pending_digest["info"].append(f"{host} で 5分に 5xx {len(h)} 件(最後 {uri.split('?')[0][:60]})")
    pts, what = 0, ""
    dec = urllib.parse.unquote(uri)
    if CRITICAL.search(uri) or CRITICAL.search(dec):
        pts, what = 5, "危険な要求"
    elif PROBE.search(uri):
        pts, what = 1, "弱点探し"
    if pts and 200 <= st < 300 and ctype and not ctype.startswith("text/html"):
        # 探りに HTML 以外の中身を返した=漏れの疑い(SPA の index は text/html なので除く)
        event("web_leak", ip=ip, host=host, uri=uri[:300], status=st, ctype=ctype)
        notify(f"secguard: {host} が探りに中身を返した疑い",
               f"{ip} → {uri[:300]}\n状態 {st} / {ctype}\n確かめてください(中身が漏れていないか)。\n{stamp()}", "high", "warning")
    if st in (401, 403) and not pts:
        pts, what = 1, "認証の失敗"
    if pts:
        s = web_score[ip]; s.append((ts, pts, what, f"{host}{uri[:80]}")); _trim(s, ts, win)
        total = sum(x[1] for x in s)
        if total >= I("WEB_BAN_SCORE"):
            kinds = collections.Counter(x[2] for x in s)
            ban(ip, "・".join(f"{k}{v}回" for k, v in kinds.items()), "例 " + s[-1][3]); s.clear()
    if st == 404:
        n = web_404[ip]; n.append((ts, 1, "")); _trim(n, ts, win)
        if len(n) >= I("WEB_404_BAN"):
            ban(ip, "404の連発", f"{len(n)}件/{win // 60}分 {host}"); n.clear()

class Tail:
    """回転(作り直し・切り詰め)に追随して行を読む"""
    def __init__(self, path, from_start=False):
        self.path, self.f, self.ino, self.buf = Path(path), None, None, b""
        self.from_start = from_start
    def lines(self):
        try:
            st = self.path.stat()
        except FileNotFoundError:
            return []
        if self.f is None or st.st_ino != self.ino or st.st_size < self.f.tell():
            reopen = self.f is not None
            if self.f:
                self.f.close()
            self.f = open(self.path, "rb"); self.ino = st.st_ino; self.buf = b""
            if not (self.from_start or reopen):
                self.f.seek(0, 2)
        out = []
        while True:
            chunk = self.f.read(1 << 20)
            if not chunk:
                break
            self.buf += chunk
            *full, self.buf = self.buf.split(b"\n")
            out.extend(full)
            if len(out) > 200000:
                break
        return out

# ── カーネル・sshd・sudo(journald) ─────────────────────────────────────────────────
KV = re.compile(r"(\w+)=(\S*)")
ctr_hits = collections.deque()
ctr_last = 0
ssh_fail = collections.defaultdict(collections.deque)

def on_journal(j):
    msg = j.get("MESSAGE")
    if isinstance(msg, list):   # バイト列で来ることがある
        try:
            msg = bytes(msg).decode("utf-8", "replace")
        except (TypeError, ValueError):
            return
    msg = str(msg or "")
    ident = j.get("SYSLOG_IDENTIFIER", "")
    if "SECGUARD-EGRESS" in msg:
        f = dict(KV.findall(msg))
        uid = int(f.get("UID", "-1") or -1)
        g = UID2GROUP.get(uid)
        detail = f"uid={uid} 宛先 {f.get('DST')}:{f.get('DPT', '')} {f.get('PROTO', '')} 出口 {f.get('OUT', '')}"
        event("egress_block", uid=uid, group=g, msg=msg[:300])
        if g:
            quarantine(g, "内部(EZOS・SSH・登録API・VPN・docker網)へ出ようとした", detail)
        else:
            notify("secguard: 内部への接続の拒否", detail + "\n" + stamp(), "high")
    elif "SECGUARD-CTR" in msg:
        global ctr_last
        now = time.time()
        ctr_hits.append(now)
        while ctr_hits and now - ctr_hits[0] > 600:
            ctr_hits.popleft()
        f = dict(KV.findall(msg))
        event("container_block", src=f.get("SRC"), dst=f.get("DST"), dpt=f.get("DPT"), iface=f.get("IN"))
        if now - ctr_last > 1800:
            ctr_last = now
            notify("secguard: コンテナが禁止先へ接続しようとした",
                   f"{f.get('SRC')} → {f.get('DST')}:{f.get('DPT', '')} ({f.get('IN')}→{f.get('OUT', 'ホスト')})\n"
                   f"10分で {len(ctr_hits)} 件。Caddy/flightlog/postgres の乗っ取りの兆候の可能性。\n{stamp()}", "high", "warning")
    elif ident == "sshd" or j.get("_COMM") == "sshd":
        m = re.search(r"Accepted (\S+) for (\S+) from (\S+)", msg)
        if m:
            event("ssh_login", method=m.group(1), user=m.group(2), ip=m.group(3))
            notify("secguard: SSH ログイン", f"{m.group(2)} ← {m.group(3)} ({m.group(1)})\n{stamp()}", "default", "key")
            return
        m = re.search(r"(Failed \S+|Invalid user \S*) .*?from (\S+)", msg)
        if m:
            ip = m.group(2); now = time.time()
            q = ssh_fail[ip]; q.append((now, 1, "")); _trim(q, now, 600)
            event("ssh_fail", ip=ip, msg=msg[:200])
            if len(q) == 5:
                notify("secguard: SSH の失敗が続いています", f"{ip} から10分で5回。SSH は操作者の VPN からだけ届くはずです。\n{stamp()}", "high")
    elif ident == "sudo":
        m = re.match(r"\s*(\S+) : (.*)", msg)
        if not m:
            return
        user, rest = m.group(1), m.group(2)
        g = USER2GROUP.get(user)
        bad = re.search(r"NOT in sudoers|incorrect password|authentication failure|command not allowed", rest)
        if g:
            event("sudo_by_service", user=user, msg=msg[:300])
            quarantine(g, "公開サービスのユーザーが sudo を試みた", msg[:300])
        elif bad:
            event("sudo_fail", user=user, msg=msg[:300])
            notify("secguard: sudo の失敗", msg[:400] + "\n" + stamp(), "high")

# ── auditd ────────────────────────────────────────────────────────────────────────
AUD_KV = re.compile(r'(\w+)=("(?:[^"]*)"|\S+)')

def aud_val(v):
    if v.startswith('"'):
        return v[1:-1]
    if re.fullmatch(r"[0-9A-F]+", v) and len(v) % 2 == 0 and len(v) >= 2:
        try:
            return bytes.fromhex(v).decode("utf-8", "replace")   # 空白などを含む値は16進で来る
        except ValueError:
            pass
    return v

def parent_comm(ppid):
    try:
        return Path(f"/proc/{int(ppid)}/comm").read_text().strip()
    except (OSError, ValueError):
        return ""

CHANGE_KEYS = {"sg_ident": "アカウント", "sg_priv": "sudo の設定", "sg_keys": "SSH の鍵", "sg_sshd": "SSH の設定",
               "sg_units": "systemd", "sg_bin": "/usr/local の実行ファイル", "sg_wg": "WireGuard", "sg_cron": "cron",
               "sg_secguard": "secguard 自身"}
URGENT_KEYS = {"sg_ident", "sg_priv", "sg_keys", "sg_secguard"}
PKG_EXES = {"/usr/bin/dpkg", "/usr/bin/apt", "/usr/bin/apt-get", "/usr/lib/apt/methods/http", "/usr/bin/unattended-upgrade"}

def on_audit_event(recs):
    sc = next((r for r in recs if r.get("type") == "SYSCALL"), None)
    if not sc:
        return
    key = aud_val(sc.get("key", ""))
    exe = aud_val(sc.get("exe", ""))
    uid = int(sc.get("uid", "-1")) if sc.get("uid", "").lstrip("-").isdigit() else -1
    auid = sc.get("auid", "")
    ppid = sc.get("ppid", "0")
    paths = [aud_val(r.get("name", "")) for r in recs if r.get("type") == "PATH" and r.get("name")]
    if key == "sg_exec":
        g = UID2GROUP.get(uid)
        if not g:
            return
        base = os.path.basename(exe)
        pc = parent_comm(ppid)
        ex = next((r for r in recs if r.get("type") == "EXECVE"), {})
        argv = " ".join(aud_val(ex[k]) for k in sorted((k for k in ex if re.fullmatch(r"a\d+", k)), key=lambda k: int(k[1:])))[:300]
        started_by_systemd = ppid == "1"
        docker_exec = pc.startswith("containerd-shim") or pc.startswith("runc")
        detail = f"{exe} ({argv}) uid={uid} 親={pc or '?'}({ppid})"
        if exe in TARGETS[g]["exe"]:
            return
        if docker_exec:
            # 管理者の docker exec(ホストの root でしかできない)。記録だけ
            event("exec_docker", group=g, exe=exe, argv=argv)
            pending_digest["info"].append(f"docker exec {g}: {exe}")
            return
        if base in DANGEROUS and not started_by_systemd:
            event("exec_dangerous", group=g, exe=exe, argv=argv, ppid=ppid, parent=pc)
            quarantine(g, f"公開サービスのユーザーが {base} を実行した", detail)
            return
        k = f"{g}:{exe}"
        if k in learned["exe"]:
            return
        if learning() or started_by_systemd:
            learned["exe"][k] = time.time(); save_learned()
            event("exec_learned", group=g, exe=exe, argv=argv, parent=pc)
            pending_digest["info"].append(f"覚えた実行 {g}: {exe}" + ("(systemd が起動)" if started_by_systemd else ""))
        else:
            event("exec_unknown", group=g, exe=exe, argv=argv, ppid=ppid, parent=pc)
            quarantine(g, "公開サービスのユーザーが見覚えのないものを実行した", detail)
    elif key in CHANGE_KEYS:
        if exe in PKG_EXES or os.path.basename(exe) in ("dpkg", "unattended-upgr"):
            return
        what = CHANGE_KEYS[key]
        who = f"auid={auid} uid={uid} {exe}"
        event("config_change", key=key, exe=exe, auid=auid, uid=uid, paths=paths[:5])
        line = f"{what}: {', '.join(p for p in paths[:3] if p)} ← {who}"
        if key in URGENT_KEYS:
            notify(f"secguard: {what}が書き換えられました", line + "\n心当たりが無ければ乗っ取りの疑い。\n" + stamp(), "high", "warning")
        else:
            pending_digest["changes"].append(line)

aud_cur = {"serial": None, "recs": [], "t": 0.0}

def aud_flush():
    """溜めた 1 件分(同じ通し番号の行)を処理する。EOE が出ない環境があるので、番号が変わった時と 1 秒たった時に出す"""
    recs, aud_cur["recs"], aud_cur["serial"] = aud_cur["recs"], [], None
    if recs:
        on_audit_event(recs)

def on_audit_line(line):
    m = re.match(r"type=(\S+) msg=audit\((\d+\.\d+):(\d+)\):\s*(.*)", line)
    if not m:
        return
    typ, serial, rest = m.group(1), m.group(3), m.group(4)
    if serial != aud_cur["serial"]:
        aud_flush()
        aud_cur["serial"] = serial
    if typ == "EOE":
        aud_flush()
        return
    rest = rest.split("\x1d", 1)[0]   # ENRICHED 形式の後ろ(大文字の欄)は使わない
    rec = {"type": typ}
    for k, v in AUD_KV.findall(rest):
        rec.setdefault(k, v)
    aud_cur["recs"].append(rec); aud_cur["t"] = time.time()

# ── 待ち受けポート ──────────────────────────────────────────────────────────────────
def listeners():
    out = subprocess.run(["ss", "-lntuHp"], capture_output=True, text=True).stdout
    res = set()
    for l in out.splitlines():
        p = l.split()
        if len(p) < 5:
            continue
        local = p[4]
        if local.startswith("127.") or local.startswith("[::1]") or local.startswith("[::ffff:127."):
            continue
        pid = re.search(r"pid=(\d+)", l)
        uid = -1
        if pid:
            try:
                uid = os.stat(f"/proc/{pid.group(1)}").st_uid
            except OSError:
                pass
        port = local.rsplit(":", 1)[-1]
        if p[0] == "udp" and port.isdigit() and int(port) >= 32768 and uid not in UID2GROUP:
            continue   # 問い合わせ用の一時ポート(名前解決など)は待ち受けではない
        res.add((p[0], local, uid))
    return res

listen_base = None
def check_listeners():
    global listen_base
    cur = listeners()
    keys = {f"{a}|{b}" for a, b, _ in cur}
    if listen_base is None:
        listen_base = keys | set(learned.get("listen", []))
        learned["listen"] = sorted(listen_base); save_learned()
        return
    for proto, local, uid in cur:
        k = f"{proto}|{local}"
        if k in listen_base:
            continue
        g = UID2GROUP.get(uid)
        listen_base.add(k)
        event("listen_new", proto=proto, local=local, uid=uid, group=g)
        if g and not learning():
            quarantine(g, "公開サービスのユーザーが新しいポートで待ち受けた", f"{proto} {local} uid={uid}")
        else:
            learned["listen"] = sorted(listen_base); save_learned()
            notify("secguard: 新しい待ち受けポート", f"{proto} {local} uid={uid}\n心当たりが無ければ確かめてください。\n{stamp()}", "high")

# ── まとめ通知 ─────────────────────────────────────────────────────────────────────
last_digest = time.time()
def digest():
    global last_digest
    if time.time() - last_digest < I("DIGEST_SEC"):
        return
    last_digest = time.time()
    b, c, i = pending_digest["bans"], pending_digest["changes"], pending_digest["info"]
    if not (b or c or i):
        return
    parts = []
    if b:
        parts.append(f"遮断 {len(b)} 件(24時間){'' if ENFORCE else '※観察モード=実際には遮断していない'}:\n" +
                     "\n".join(b[:15]) + (f"\n…ほか {len(b) - 15} 件" if len(b) > 15 else ""))
    if c:
        parts.append(f"設定の書き換え {len(c)} 件:\n" + "\n".join(c[:10]))
    if i:
        parts.append("記録:\n" + "\n".join(i[:10]))
    notify(f"secguard: まとめ(遮断{len(b)}・変更{len(c)})", "\n\n".join(parts) + "\n" + stamp(), "low" if not c else "default")
    pending_digest["bans"], pending_digest["changes"], pending_digest["info"] = [], [], []

# ── 本体 ────────────────────────────────────────────────────────────────────────────
def journal_reader(q):
    while True:
        p = subprocess.Popen(["journalctl", "-f", "-n", "0", "-o", "json", "_TRANSPORT=kernel", "+",
                              "SYSLOG_IDENTIFIER=sshd", "+", "SYSLOG_IDENTIFIER=sudo"],
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        for line in p.stdout:
            try:
                q.append(("j", json.loads(line)))
            except ValueError:
                pass
        p.wait(); time.sleep(5)

def main():
    os.umask(0o077)
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    os.chmod(STATE_DIR, 0o711)          # 中身は root だけ。quarantine/ だけは watchdog 等が有無を見られるように
    QUAR_DIR.mkdir(exist_ok=True)
    os.chmod(QUAR_DIR, 0o755)
    for f in ("events.jsonl", "bans.json", "learned.json"):
        if (STATE_DIR / f).exists():
            os.chmod(STATE_DIR / f, 0o600)
    if TEST:
        n = 0
        for f in sorted(CADDY_LOG_DIR.glob("*.access.log")):
            for line in open(f, "rb"):
                try:
                    on_web(json.loads(line), f.name); n += 1
                except (ValueError, KeyError, TypeError):
                    pass
        print(f"--test-web: {n} 行・遮断候補 {len(bans)} 件")
        for ip, b in sorted(bans.items(), key=lambda x: x[1]["until"]):
            print(f"  {ip:16} {b['reason']}  {b['detail'][:90]}")
        return
    restore_bans(); load_quarantined()
    log(f"secguard start enforce={ENFORCE} learning={learning()} targets={UID2GROUP}")
    q = collections.deque()
    threading.Thread(target=journal_reader, args=(q,), daemon=True).start()
    tails = {}
    audit = Tail(AUDIT_LOG)
    last_listen = 0
    while True:
        for f in CADDY_LOG_DIR.glob("*.access.log"):
            if f not in tails:
                tails[f] = Tail(f)
            for line in tails[f].lines():
                try:
                    on_web(json.loads(line), f.name)
                except (ValueError, KeyError, TypeError, AttributeError) as e:
                    if not isinstance(e, ValueError):
                        log(f"web parse: {e}")
        for line in audit.lines():
            try:
                on_audit_line(line.decode("utf-8", "replace"))
            except Exception as e:  # noqa: BLE001
                log(f"audit parse: {e}")
        if aud_cur["recs"] and time.time() - aud_cur["t"] > 1:
            try:
                aud_flush()
            except Exception as e:  # noqa: BLE001
                log(f"audit parse: {e}")
        while q:
            _, j = q.popleft()
            try:
                on_journal(j)
            except Exception as e:  # noqa: BLE001
                log(f"journal parse: {e}")
        if time.time() - last_listen > 60:
            last_listen = time.time()
            try:
                check_listeners()
            except Exception as e:  # noqa: BLE001
                log(f"listen: {e}")
        digest()
        time.sleep(1)

if __name__ == "__main__":
    main()
