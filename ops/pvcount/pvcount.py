#!/usr/bin/env python3
"""pvcount — ezoe.net(さくら)のページの閲覧数を数える小さなサービス(2026-11-19)。

ページの pv.js が stats.ezoe.net/pv へ「ページの場所」と「外から来たときの参照元のホスト名」だけを送る。
数えるのは日ごと(JST)・ページごとの閲覧数と人数、参照元のホスト名ごとの件数だけ。
- IP・User-Agent・Cookie は保存しない。人数は「その日だけの使い捨ての鍵 + IP + User-Agent」のハッシュで
  メモリ上で見分け、日が変わると鍵ごと捨てる(後から個人をたどれない)。再起動するとその日の人数は数え直しになる。
- ロボット(User-Agent に bot/crawl/spider 等)・ezoe.net 以外の Origin・形の正しくない場所は数えない。
- 集計は STATE(既定 /var/lib/pvcount/stats.json)に 1 分ごとに書く。GET /stats(表)・/stats.json は
  Caddy で管理 VPN からだけ届くようにする(stats.caddy)。

環境変数: PV_BIND(既定 127.0.0.1,172.17.0.1)・PV_PORT(3105)・PV_STATE・PV_ORIGINS・PV_KEEP_DAYS(400)
"""
import hashlib
import html
import json
import os
import re
import secrets
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BIND = [a.strip() for a in os.environ.get("PV_BIND", "127.0.0.1,172.17.0.1").split(",") if a.strip()]
PORT = int(os.environ.get("PV_PORT", "3105"))
STATE = os.environ.get("PV_STATE", "/var/lib/pvcount/stats.json")
ORIGINS = set(os.environ.get("PV_ORIGINS", "https://ezoe.net https://www.ezoe.net").split())
KEEP_DAYS = int(os.environ.get("PV_KEEP_DAYS", "400"))

PATH_RE = re.compile(r"^/[A-Za-z0-9._~%/\-]{0,200}$")
HOST_RE = re.compile(r"^[a-z0-9.\-]{1,100}$")
BOT_RE = re.compile(r"bot|crawl|spider|slurp|headless|preview|lighthouse|facebookexternalhit|curl|wget|python", re.I)
MAX_PAGES_PER_DAY = 2000      # 場所の種類の上限(ごみの送り付けでメモリが膨らまないように)
MAX_REFS_PER_DAY = 500
MAX_PER_VISITOR_HOUR = 120    # 1 人(その日の鍵)あたり 1 時間の上限

JST = 9 * 3600
lock = threading.Lock()
stats = {"days": {}}
dirty = False
today = {"day": None, "salt": b"", "visitors": set(), "page_visitors": {}, "rate": {}}


def jst_day(t=None):
    return time.strftime("%Y-%m-%d", time.gmtime((t or time.time()) + JST))


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def load():
    global stats
    try:
        with open(STATE, encoding="utf-8") as f:
            d = json.load(f)
        if isinstance(d.get("days"), dict):
            stats = d
    except (OSError, ValueError):
        pass


def save():
    global dirty
    with lock:
        if not dirty:
            return
        days = sorted(stats["days"])
        for old in days[:-KEEP_DAYS]:
            del stats["days"][old]
        data = json.dumps(stats, ensure_ascii=False, separators=(",", ":"))
        dirty = False
    tmp = STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(data)
    os.replace(tmp, STATE)


def saver():
    while True:
        time.sleep(60)
        try:
            save()
        except OSError as e:
            log(f"save failed: {e}")


def norm_path(p):
    p = p.split("?", 1)[0].split("#", 1)[0]
    if not PATH_RE.match(p) or ".." in p:
        return None
    if p.endswith("/index.html"):
        p = p[: -len("index.html")]
    return p


def count(path, ref, ip, ua):
    global dirty
    day = jst_day()
    with lock:
        if today["day"] != day:   # 日が変わったら鍵と見分けの記憶を捨てる
            today.update(day=day, salt=secrets.token_bytes(32), visitors=set(), page_visitors={}, rate={})
        v = hashlib.sha256(today["salt"] + ip.encode() + b"\0" + ua.encode()).digest()[:12]
        hour = int(time.time() // 3600)
        r = today["rate"].get(v)
        if r and r[0] == hour and r[1] >= MAX_PER_VISITOR_HOUR:
            return
        today["rate"][v] = (hour, (r[1] + 1) if r and r[0] == hour else 1)
        d = stats["days"].setdefault(day, {"views": 0, "visitors": 0, "pages": {}, "refs": {}})
        pg = d["pages"].get(path)
        if pg is None:
            if len(d["pages"]) >= MAX_PAGES_PER_DAY:
                return
            pg = d["pages"][path] = [0, 0]
        d["views"] += 1
        pg[0] += 1
        if v not in today["visitors"]:
            today["visitors"].add(v)
            d["visitors"] += 1
        pv = today["page_visitors"].setdefault(path, set())
        if v not in pv:
            pv.add(v)
            pg[1] += 1
        if ref and (ref in d["refs"] or len(d["refs"]) < MAX_REFS_PER_DAY):
            d["refs"][ref] = d["refs"].get(ref, 0) + 1
        dirty = True


def stats_html():
    with lock:
        days = sorted(stats["days"].items(), reverse=True)
    last30 = days[:30]
    pages, refs = {}, {}
    for _, d in last30:
        for p, (vw, vs) in d["pages"].items():
            a = pages.setdefault(p, [0, 0])
            a[0] += vw
            a[1] += vs
        for h, n in d["refs"].items():
            refs[h] = refs.get(h, 0) + n
    e = html.escape
    rows_d = "".join(f"<tr><td>{e(k)}</td><td>{d['views']}</td><td>{d['visitors']}</td></tr>" for k, d in last30)
    rows_p = "".join(f"<tr><td>{e(p)}</td><td>{a[0]}</td><td>{a[1]}</td></tr>"
                     for p, a in sorted(pages.items(), key=lambda x: -x[1][0])[:100])
    rows_r = "".join(f"<tr><td>{e(h)}</td><td>{n}</td></tr>" for h, n in sorted(refs.items(), key=lambda x: -x[1])[:50])
    tv = sum(d["views"] for _, d in last30)
    return f"""<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ezoe.net 閲覧数</title><style>body{{font-family:sans-serif;margin:16px;color:#111;background:#fff}}table{{border-collapse:collapse;margin:0 0 24px}}
td,th{{border:1px solid #ccc;padding:4px 8px;text-align:right}}td:first-child,th:first-child{{text-align:left}}h2{{font-size:1.1em}}p{{color:#555}}</style></head><body>
<h1>ezoe.net 閲覧数</h1><p>直近 30 日(JST)・合計 {tv} 回。人数は日ごとの見分けで、ページ別・期間合計の人数は日ごとの人数の足し合わせ。ロボットは除く。</p>
<h2>日ごと</h2><table><tr><th>日</th><th>閲覧</th><th>人数</th></tr>{rows_d}</table>
<h2>ページごと(30 日)</h2><table><tr><th>ページ</th><th>閲覧</th><th>人数(日ごとの和)</th></tr>{rows_p}</table>
<h2>外からの参照元(30 日)</h2><table><tr><th>ホスト名</th><th>件数</th></tr>{rows_r}</table></body></html>"""


class H(BaseHTTPRequestHandler):
    server_version = "pvcount"
    sys_version = ""

    def log_message(self, *a):
        pass

    def send(self, code, body=b"", ctype=None, extra=()):
        self.send_response(code)
        self.send_header("Cache-Control", "no-store")
        if ctype:
            self.send_header("Content-Type", ctype)
        for k, v in extra:
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body and self.command != "HEAD":
            self.wfile.write(body)

    def do_POST(self):
        origin = self.headers.get("Origin", "")
        cors = (("Access-Control-Allow-Origin", origin), ("Vary", "Origin")) if origin in ORIGINS else ()
        if self.path != "/pv":
            return self.send(404)
        try:
            n = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            n = -1
        if not 0 < n <= 512:
            return self.send(400, extra=cors)
        raw = self.rfile.read(n)
        if origin not in ORIGINS:
            return self.send(204)   # 数えないが、送り主には理由を返さない
        ua = self.headers.get("User-Agent", "")
        if not ua or BOT_RE.search(ua):
            return self.send(204, extra=cors)
        try:
            d = json.loads(raw.decode("utf-8"))
            path = norm_path(str(d.get("p", "")))
            ref = str(d.get("r", "")).lower()[:100]
        except (ValueError, UnicodeDecodeError, AttributeError):
            return self.send(400, extra=cors)
        if not path:
            return self.send(400, extra=cors)
        if ref and (not HOST_RE.match(ref) or ref in ("ezoe.net", "www.ezoe.net")):
            ref = ""
        # Caddy は外から来た X-Forwarded-For を捨てて送信元を入れ直す。直接つないだ時(手元の試験)は接続元
        ip = (self.headers.get("X-Forwarded-For", "").split(",")[-1].strip()) or self.client_address[0]
        count(path, ref, ip, ua)
        self.send(204, extra=cors)

    def do_OPTIONS(self):
        origin = self.headers.get("Origin", "")
        if self.path == "/pv" and origin in ORIGINS:
            return self.send(204, extra=(("Access-Control-Allow-Origin", origin), ("Vary", "Origin"),
                                         ("Access-Control-Allow-Methods", "POST"),
                                         ("Access-Control-Allow-Headers", "Content-Type"),
                                         ("Access-Control-Max-Age", "86400")))
        self.send(404)

    def do_GET(self):
        if self.path == "/stats":
            return self.send(200, stats_html().encode(), "text/html; charset=utf-8")
        if self.path == "/stats.json":
            with lock:
                body = json.dumps(stats, ensure_ascii=False).encode()
            return self.send(200, body, "application/json; charset=utf-8")
        if self.path == "/healthz":
            return self.send(200, b"ok\n", "text/plain")
        self.send(404)

    do_HEAD = do_GET


def serve(addr):
    """docker0(172.17.0.1)は起動直後に無いことがあるので、現れるまで待ち直す"""
    while True:
        try:
            srv = ThreadingHTTPServer((addr, PORT), H)
            srv.daemon_threads = True
            log(f"listening {addr}:{PORT}")
            srv.serve_forever()
        except OSError as e:
            log(f"bind {addr}:{PORT} failed ({e}); retry in 10s")
            time.sleep(10)


def main():
    load()
    threading.Thread(target=saver, daemon=True).start()
    for a in BIND[1:]:
        threading.Thread(target=serve, args=(a,), daemon=True).start()
    try:
        serve(BIND[0])
    finally:
        save()


if __name__ == "__main__":
    import signal
    signal.signal(signal.SIGTERM, lambda *a: (save(), sys.exit(0)))
    main()
