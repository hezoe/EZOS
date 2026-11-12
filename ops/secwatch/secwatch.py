#!/usr/bin/env python3
"""secwatch (2026-11-13): 新しい脆弱性(CVE 等)を見つけたらすぐ調べて対策する仕組み。

在庫(何を使っているか)を集め、脆弱性データベースと突き合わせ、前回と比べて新しく出たものを
通知・記録し、できる対策は自動で行い、重いものは Claude Code を無人で起動して調査させる。

  在庫と照合先
    - VPS の Debian パッケージ            … debsecan(Debian セキュリティトラッカー)
    - 受信機(Raspbian bullseye)のパッケージ … 到達できる受信機から dpkg の状態ファイルを週 1 回取り、debsecan
    - npm(各リポジトリの package-lock.json) … OSV.dev(ecosystem npm)
    - Python(pip --user)                     … OSV.dev(PyPI)
    - docker コンテナ(Alpine)の apk        … OSV.dev(Alpine:vX.Y)
    - Node.js 本体                           … nodejs.org の脆弱性フィード(新しい記事を知らせる)
  動き(timer で 1 日 2 回)
    1. 在庫 → 照合 → 新しい(前回まで見ていない)脆弱性を抽出(状態は STATE_DIR/state.json)
    2. 報告書 REPORT_DIR/YYYY-MM-DD_HHMM.md と latest.json を書く
    3. Debian で修正版が出ているもの(debsecan "fixed")は apt で自動更新(AUTO_APT=1)
    4. 新しいものがあれば ntfy で知らせる(高・重大があれば高優先)
    5. 高・重大が新たに出たら Claude Code を無人で起動(CLAUDE_INVESTIGATE=1)、影響と対策を調査させて
       結果を報告書と通知に載せる(読み取りだけのツールに限定。対策の適用はしない=人が判断)
  使い方: secwatch.py [--dry](通知・apt・Claude を行わない) [--no-claude] [--refresh-receiver]
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta

JST = timezone(timedelta(hours=9))
STATE_DIR = os.environ.get("SECWATCH_STATE_DIR", "/var/lib/secwatch")
REPORT_DIR = os.environ.get("SECWATCH_REPORT_DIR", "/home/debian/workspace/docs/security/secwatch")
CONF = os.environ.get("SECWATCH_NTFY_CONF", "/etc/service-watchdog.conf")
AUTO_APT = os.environ.get("SECWATCH_AUTO_APT", "1") == "1"
CLAUDE_INVESTIGATE = os.environ.get("SECWATCH_CLAUDE", "1") == "1"
CLAUDE_CWD = os.environ.get("SECWATCH_CLAUDE_CWD", "/home/debian/workspace")
CLAUDE_BIN = os.environ.get("SECWATCH_CLAUDE_BIN", os.path.expanduser("~/.local/bin/claude"))
RECEIVER_UNITS = os.environ.get("SECWATCH_RECEIVERS", "feeldscope-49f8e9 takikawa-01 feeldscope-201c5e feeldscope-1c9429 feeldscope-31aeee feeldscope-31aed9").split()
RECEIVER_SUITE = os.environ.get("SECWATCH_RECEIVER_SUITE", "bullseye")
VPS_SUITE = os.environ.get("SECWATCH_VPS_SUITE", "bookworm")
RECEIVER_CACHE_DAYS = 7
NPM_LOCKS = os.environ.get("SECWATCH_NPM_LOCKS", " ".join([
    "/home/debian/EZOS/app/package-lock.json",
    "/home/debian/ogn-web/package-lock.json",
    "/home/debian/workspace/navlog/package-lock.json",
    "/home/debian/workspace/notam/package-lock.json",
    "/home/debian/Takikawa-WEB/package-lock.json",
    "/home/debian/saas/apps/flightlog/package-lock.json",
    "/home/debian/FEELDSCOPE-OGN/webapp/package-lock.json",
])).split()
ALPINE_CONTAINERS = os.environ.get("SECWATCH_ALPINE_CONTAINERS", "saas-caddy saas-postgres").split()
OSV_BATCH = "https://api.osv.dev/v1/querybatch"
OSV_VULN = "https://api.osv.dev/v1/vulns/"
NODE_FEED = "https://nodejs.org/en/feed/vulnerability.xml"
HIGH_LEVELS = ("critical", "high")

DRY = "--dry" in sys.argv
NO_CLAUDE = "--no-claude" in sys.argv
REFRESH_RECEIVER = "--refresh-receiver" in sys.argv


def log(msg):
    print(f"[secwatch] {msg}", flush=True)


def now_jst():
    return datetime.now(JST)


# ── 通知 ──────────────────────────────────────────────────────────────────
def read_ntfy():
    url, topic = "https://ntfy.sh", ""
    try:
        for line in open(CONF, encoding="utf-8"):
            m = re.match(r'\s*(NTFY_URL|NTFY_TOPIC)\s*=\s*"?([^"#\s]+)', line)
            if m:
                if m.group(1) == "NTFY_URL":
                    url = m.group(2).rstrip("/")
                else:
                    topic = m.group(2)
    except OSError:
        pass
    return url, topic


def notify(title, body, priority="default", tags="shield"):
    if DRY:
        log(f"(dry) notify: {title}\n{body[:400]}")
        return
    url, topic = read_ntfy()
    if not topic:
        return
    try:
        # 見出しに日本語を使う: HTTP ヘッダは latin-1 しか通らないので RFC 2047(ntfy が解釈)で包む
        import base64
        t = "=?UTF-8?B?" + base64.b64encode(title.encode("utf-8")).decode("ascii") + "?=" if any(ord(c) > 127 for c in title) else title
        req = urllib.request.Request(f"{url}/{topic}", data=body.encode("utf-8"), method="POST",
                                     headers={"Title": t, "Priority": priority, "Tags": tags})
        urllib.request.urlopen(req, timeout=10).read()
    except Exception as e:
        log(f"notify failed: {e}")


# ── CVSS 3.x の基本値(OSV の severity ベクターから) ─────────────────────────
def cvss3_base(vector):
    try:
        m = dict(p.split(":") for p in vector.split("/")[1:])
        AV = {"N": 0.85, "A": 0.62, "L": 0.55, "P": 0.2}[m["AV"]]
        AC = {"L": 0.77, "H": 0.44}[m["AC"]]
        UI = {"N": 0.85, "R": 0.62}[m["UI"]]
        S = m["S"]
        PR = {"N": 0.85, "L": 0.62 if S == "U" else 0.68, "H": 0.27 if S == "U" else 0.5}[m["PR"]]
        cia = {"H": 0.56, "L": 0.22, "N": 0.0}
        C, I, A = cia[m["C"]], cia[m["I"]], cia[m["A"]]
        iss = 1 - (1 - C) * (1 - I) * (1 - A)
        impact = 6.42 * iss if S == "U" else 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15
        expl = 8.22 * AV * AC * PR * UI
        if impact <= 0:
            return 0.0
        raw = min(impact + expl, 10) if S == "U" else min(1.08 * (impact + expl), 10)
        import math
        return math.ceil(raw * 10) / 10
    except Exception:
        return None


def level_from_score(score):
    if score is None:
        return "unknown"
    if score >= 9.0:
        return "critical"
    if score >= 7.0:
        return "high"
    if score >= 4.0:
        return "medium"
    return "low"


# ── 状態 ──────────────────────────────────────────────────────────────────
def load_state():
    try:
        return json.load(open(os.path.join(STATE_DIR, "state.json"), encoding="utf-8"))
    except (OSError, ValueError):
        return {"seen": {}, "vulns": {}, "node_feed": []}


def save_state(st):
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = os.path.join(STATE_DIR, "state.json.tmp")
    json.dump(st, open(tmp, "w", encoding="utf-8"), ensure_ascii=False)
    os.replace(tmp, os.path.join(STATE_DIR, "state.json"))


# ── debsecan(Debian) ──────────────────────────────────────────────────────
def run_debsecan(suite, status_file=None):
    cmd = ["debsecan", "--suite", suite, "--format", "detail"]
    if status_file:
        cmd += ["--status", status_file]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=600).stdout
    except Exception as e:
        log(f"debsecan failed ({suite}): {e}")
        return []
    findings = []
    for block in out.strip().split("\n\n"):
        lines = block.splitlines()
        if not lines:
            continue
        m = re.match(r"^(\S+)\s*\((.*)\)", lines[0])
        if not m:
            continue
        vid, flags = m.group(1), m.group(2)
        title = lines[1].strip() if len(lines) > 1 else ""
        pkg = ver = ""
        fix_available = any("fix is available" in ln for ln in lines)
        for ln in lines:
            mm = re.match(r"\s*installed:\s+(\S+)\s+(\S+)", ln)
            if mm:
                pkg, ver = mm.group(1), mm.group(2)
        urgency = "high" if "high urgency" in flags else "medium" if "medium urgency" in flags else "low" if "low urgency" in flags else "unknown"
        remote = "remotely exploitable" in flags
        findings.append({
            "source": f"debian-{suite}", "package": pkg, "version": ver, "id": vid, "title": title,
            "level": urgency if urgency != "unknown" else ("high" if remote else "unknown"),
            "remote": remote, "fix_available": fix_available, "fixed": "fixed" in flags,
        })
    return findings


def receiver_status_file():
    """到達できる受信機から dpkg の状態ファイルを取る(週 1 回・キャッシュ)。"""
    path = os.path.join(STATE_DIR, "receiver-dpkg-status")
    meta = path + ".json"
    try:
        age = time.time() - os.path.getmtime(path)
        if age < RECEIVER_CACHE_DAYS * 86400 and not REFRESH_RECEIVER:
            return path, json.load(open(meta)).get("unit", "?")
    except OSError:
        pass
    for unit in RECEIVER_UNITS:
        try:
            if subprocess.run(["timeout", "5", "feeldscope-remote", "ping", unit], capture_output=True).returncode != 0:
                continue
            r = subprocess.run(["timeout", "90", "feeldscope-remote", "ssh", unit, "cat /var/lib/dpkg/status"],
                               capture_output=True, text=True)
            if r.returncode == 0 and "Package:" in r.stdout:
                os.makedirs(STATE_DIR, exist_ok=True)
                open(path, "w", encoding="utf-8").write(r.stdout)
                json.dump({"unit": unit, "at": now_jst().isoformat()}, open(meta, "w"))
                log(f"receiver inventory refreshed from {unit}")
                return path, unit
        except Exception as e:
            log(f"receiver {unit}: {e}")
    if os.path.exists(path):
        return path, json.load(open(meta)).get("unit", "?") + "(古い控え)"
    return None, None


# ── OSV(npm / PyPI / Alpine) ─────────────────────────────────────────────
def osv_batch(queries):
    """[(label, ecosystem, name, version)] → {(label,name,version): [vuln ids]}"""
    out = {}
    for i in range(0, len(queries), 500):
        chunk = queries[i:i + 500]
        body = json.dumps({"queries": [{"package": {"name": n, "ecosystem": e}, "version": v} for (_, e, n, v) in chunk]}).encode()
        try:
            req = urllib.request.Request(OSV_BATCH, data=body, headers={"Content-Type": "application/json"})
            res = json.loads(urllib.request.urlopen(req, timeout=60).read())
        except Exception as e:
            log(f"OSV batch failed: {e}")
            continue
        for (label, eco, name, ver), r in zip(chunk, res.get("results", [])):
            ids = [v["id"] for v in r.get("vulns", [])]
            if ids:
                out[(label, name, ver)] = ids
    return out


def osv_detail(vid, cache):
    if vid in cache:
        return cache[vid]
    try:
        d = json.loads(urllib.request.urlopen(OSV_VULN + vid, timeout=30).read())
    except Exception as e:
        log(f"OSV detail {vid}: {e}")
        return None
    score = None
    for s in d.get("severity", []) or []:
        if s.get("type", "").startswith("CVSS_V3"):
            score = cvss3_base(s.get("score", ""))
        elif s.get("type") == "CVSS_V4" and score is None:
            m = re.search(r"/(?:AV):", s.get("score", ""))
            score = None
    level = (d.get("database_specific") or {}).get("severity", "")
    level = level.lower() if level else level_from_score(score)
    level = {"moderate": "medium"}.get(level, level)
    if level == "unknown" and score is not None:
        level = level_from_score(score)
    fixed = []
    for a in d.get("affected", []) or []:
        for rg in a.get("ranges", []) or []:
            for ev in rg.get("events", []) or []:
                if "fixed" in ev:
                    fixed.append(ev["fixed"])
    aliases = d.get("aliases", []) or []
    cve = next((x for x in [vid] + aliases if x.startswith("CVE-")), None)
    info = {"id": vid, "cve": cve, "summary": (d.get("summary") or d.get("details") or "")[:160].replace("\n", " "),
            "level": level, "score": score, "fixed": sorted(set(fixed))[:3]}
    cache[vid] = info
    return info


def npm_inventory():
    q = []
    for lock in NPM_LOCKS:
        try:
            d = json.load(open(lock, encoding="utf-8"))
        except (OSError, ValueError):
            continue
        label = f"npm:{os.path.basename(os.path.dirname(lock))}"
        for key, ent in (d.get("packages") or {}).items():
            if not key or "node_modules/" not in key or ent.get("link"):
                continue
            name = key.rsplit("node_modules/", 1)[1]
            ver = ent.get("version")
            if name and ver:
                q.append((label + (" (dev)" if ent.get("dev") else ""), "npm", name, ver))
    return q


def pip_inventory():
    try:
        out = subprocess.run(["pip3", "list", "--user", "--format=json"], capture_output=True, text=True, timeout=60).stdout
        return [("pip:user", "PyPI", p["name"], p["version"]) for p in json.loads(out)]
    except Exception:
        return []


def alpine_inventory():
    q = []
    for c in ALPINE_CONTAINERS:
        try:
            rel = subprocess.run(["sudo", "-n", "docker", "exec", c, "cat", "/etc/alpine-release"], capture_output=True, text=True, timeout=30).stdout.strip()
            eco = "Alpine:v" + ".".join(rel.split(".")[:2])
            out = subprocess.run(["sudo", "-n", "docker", "exec", c, "apk", "info", "-v"], capture_output=True, text=True, timeout=30).stdout
        except Exception as e:
            log(f"alpine {c}: {e}")
            continue
        for line in out.split():
            parts = line.rsplit("-", 2)
            if len(parts) == 3:
                q.append((f"docker:{c}", eco, parts[0], f"{parts[1]}-{parts[2]}"))
    return q


# ── Node.js のフィード ────────────────────────────────────────────────────
def node_feed(state):
    try:
        xml = urllib.request.urlopen(NODE_FEED, timeout=30).read()
        root = ET.fromstring(xml)
    except Exception as e:
        log(f"node feed: {e}")
        return []
    seen = set(state.get("node_feed", []))
    new = []
    ns = {"a": "http://www.w3.org/2005/Atom"}
    items = root.findall(".//item") or root.findall(".//a:entry", ns)
    for it in items[:20]:
        title = (it.findtext("title") or it.findtext("a:title", namespaces=ns) or "").strip()
        link = (it.findtext("link") or "").strip()
        if not link:
            le = it.find("a:link", ns)
            link = le.get("href", "") if le is not None else ""
        key = link or title
        if key and key not in seen:
            new.append({"title": title, "link": link})
            seen.add(key)
    state["node_feed"] = list(seen)[-200:]
    return new


# ── 自動対策(Debian の修正版を入れる) ────────────────────────────────────────
def apply_debian_fixes(findings):
    pkgs = sorted({f["package"] for f in findings if f["source"] == f"debian-{VPS_SUITE}" and f["fix_available"] and f["package"]})
    if not pkgs:
        return None
    if DRY or not AUTO_APT:
        return f"(適用せず) 修正版あり: {' '.join(pkgs)}"
    try:
        subprocess.run(["sudo", "-n", "apt-get", "update", "-qq"], capture_output=True, timeout=300)
        r = subprocess.run(["sudo", "-n", "env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "install", "-y", "-qq", "--only-upgrade", *pkgs],
                           capture_output=True, text=True, timeout=900)
        tail = (r.stdout + r.stderr).strip().splitlines()[-3:]
        return f"apt --only-upgrade {' '.join(pkgs)} → rc={r.returncode} {' / '.join(tail)}"
    except Exception as e:
        return f"apt 失敗: {e}"


# ── docker イメージの更新(任意・SECWATCH_AUTO_DOCKER=1) ──────────────────────
AUTO_DOCKER = os.environ.get("SECWATCH_AUTO_DOCKER", "0") == "1"
DOCKER_COMPOSE_DIRS = {"saas-caddy": "/home/debian/saas/caddy", "saas-postgres": "/home/debian/saas/postgres"}


def apply_docker_updates(new):
    """新しい Alpine の脆弱性に修正版があるコンテナは、イメージを pull して作り直す(数十秒の停止を伴うため既定は OFF)。"""
    targets = sorted({f["source"].split(":", 1)[1] for f in new if f["source"].startswith("docker:") and f.get("fix_available")})
    targets = [t for t in targets if t in DOCKER_COMPOSE_DIRS]
    if not targets:
        return None
    if DRY or not AUTO_DOCKER:
        return f"(適用せず・SECWATCH_AUTO_DOCKER=0) 修正版のあるコンテナ: {' '.join(targets)} → 各 compose dir で pull && up -d"
    results = []
    for t in targets:
        d = DOCKER_COMPOSE_DIRS[t]
        try:
            subprocess.run(["sudo", "-n", "docker", "compose", "pull", "-q"], cwd=d, capture_output=True, timeout=600)
            r = subprocess.run(["sudo", "-n", "docker", "compose", "up", "-d"], cwd=d, capture_output=True, text=True, timeout=300)
            results.append(f"{t}: pull+up rc={r.returncode}")
        except Exception as e:
            results.append(f"{t}: 失敗 {e}")
    return "; ".join(results)


# ── Claude Code による無人調査 ───────────────────────────────────────────
def claude_investigate(new_high, report_path):
    if DRY or NO_CLAUDE or not CLAUDE_INVESTIGATE or not new_high:
        return None
    prompt = (
        "あなたは VPS tk2-228-23810 の保守担当です。secwatch が新しく見つけた高・重大の脆弱性を調査してください。"
        "対象の環境は docs/security(台帳 findings-20261026.json)とメモリ(~/.claude/projects/-home-debian-workspace/memory)に記録があります。"
        "それぞれについて、(1) この環境で実際にその機能・経路が使われ露出しているか、(2) 今すぐできる緩和策(設定・無効化・ファイアウォール等)、"
        "(3) 恒久対策(更新の見込み)、(4) 緊急度の判断(今夜中/今週/次回更新で可)を、日本語で簡潔にまとめてください。"
        "変更は加えず、調査と提案だけを行ってください。最後に 3 行以内の要約を『要約:』で始めて書いてください。\n\n"
        "新しい高・重大の脆弱性(JSON):\n" + json.dumps(new_high[:30], ensure_ascii=False, indent=1)
    )
    cmd = [CLAUDE_BIN, "-p", prompt, "--output-format", "json",
           "--settings", json.dumps({"disableAllHooks": True}),
           "--allowedTools", "Read,Grep,Glob,WebFetch,WebSearch,Bash(dpkg-query *),Bash(dpkg -l*),Bash(apt-cache *),Bash(systemctl status *),Bash(systemctl is-active *),Bash(ss *),Bash(ls *),Bash(cat *),Bash(grep *),Bash(debsecan *),Bash(sudo docker ps*),Bash(sudo docker exec * apk info*)"]
    try:
        r = subprocess.run(cmd, cwd=CLAUDE_CWD, capture_output=True, text=True, timeout=1500)
        d = json.loads(r.stdout)
        text = d.get("result", "") or ""
        cost = d.get("total_cost_usd")
        with open(report_path, "a", encoding="utf-8") as f:
            f.write(f"\n\n## Claude Code による調査(無人・費用 ${cost})\n\n{text}\n")
        return text
    except Exception as e:
        log(f"claude investigate failed: {e}")
        return f"(調査の起動に失敗: {e})"


# ── 本体 ──────────────────────────────────────────────────────────────────
def main():
    t0 = now_jst()
    state = load_state()
    seen = state.setdefault("seen", {})
    first_run = not seen   # 初回は全件を「既知」として取り込む(基準作成)。無人調査は行わない
    vcache = state.setdefault("vulns", {})
    findings = []

    # Debian(VPS)
    vps = run_debsecan(VPS_SUITE)
    findings += vps
    log(f"VPS debsecan: {len(vps)} 件(修正版あり {sum(1 for f in vps if f['fix_available'])})")

    # Debian(受信機)
    rs, runit = receiver_status_file()
    if rs:
        rcv = run_debsecan(RECEIVER_SUITE, rs)
        for f in rcv:
            f["source"] = f"receiver-{RECEIVER_SUITE}"
        findings += rcv
        log(f"受信機 debsecan({runit}): {len(rcv)} 件")

    # OSV
    queries = npm_inventory() + pip_inventory() + alpine_inventory()
    hits = osv_batch(queries)
    log(f"OSV: {len(queries)} 部品 → 該当 {len(hits)} 部品")
    for (label, name, ver), ids in hits.items():
        for vid in ids:
            info = osv_detail(vid, vcache)
            if not info:
                continue
            findings.append({"source": label, "package": name, "version": ver, "id": info["cve"] or vid, "osv_id": vid,
                             "title": info["summary"], "level": info["level"], "score": info["score"],
                             "remote": None, "fix_available": bool(info["fixed"]), "fixed_in": info["fixed"]})

    # 差分
    now_iso = t0.isoformat(timespec="minutes")
    new = []
    for f in findings:
        key = f"{f['source']}|{f['package']}|{f['id']}"
        if key not in seen:
            seen[key] = now_iso
            new.append(f)
    node_new = node_feed(state)

    # 対策(Debian の修正版)
    apt_result = apply_debian_fixes(findings)

    # 集計
    def lv(f):
        return (f.get("level") or "unknown").lower()
    new_high = [f for f in new if lv(f) in HIGH_LEVELS or f.get("remote") and f["source"].startswith("debian")]
    by_level = {}
    for f in new:
        by_level[lv(f)] = by_level.get(lv(f), 0) + 1
    total_by_src = {}
    for f in findings:
        total_by_src[f["source"]] = total_by_src.get(f["source"], 0) + 1

    # 報告書
    os.makedirs(REPORT_DIR, exist_ok=True)
    report_path = os.path.join(REPORT_DIR, t0.strftime("%Y-%m-%d_%H%M") + ".md")
    lines = [f"# secwatch 報告 {t0.strftime('%Y-%m-%d %H:%M')} JST", "",
             f"- 照合した部品: Debian(VPS) / 受信機({runit or '取得不可'}) / OSV {len(queries)} 部品 / Node.js フィード",
             f"- 新しい脆弱性: {len(new)} 件 " + (", ".join(f"{k} {v}" for k, v in sorted(by_level.items())) if new else "なし"),
             f"- 自動対策: {apt_result or 'なし'}", ""]
    if new:
        lines += ["## 新しい脆弱性", "", "| 区分 | 部品 | 版 | ID | 深刻度 | 修正版 | 内容 |", "|---|---|---|---|---|---|---|"]
        for f in sorted(new, key=lambda x: (x.get("score") or 0), reverse=True)[:200]:
            fix = ", ".join(f.get("fixed_in") or []) or ("あり" if f.get("fix_available") else "-")
            lines.append(f"| {f['source']} | {f['package']} | {f['version']} | {f['id']} | {lv(f)}{'('+str(f.get('score'))+')' if f.get('score') else ''}{' 遠隔' if f.get('remote') else ''} | {fix} | {(f.get('title') or '')[:80].replace('|','/')} |")
        lines.append("")
    if node_new:
        lines += ["## Node.js の脆弱性のお知らせ(新着)", ""] + [f"- {n['title']} {n['link']}" for n in node_new] + [""]
    lines += ["## 全体", ""] + [f"- {k}: {v} 件(未修正の低緊急度を含む)" for k, v in sorted(total_by_src.items())]
    open(report_path, "w", encoding="utf-8").write("\n".join(lines) + "\n")
    json.dump({"at": now_iso, "new": new, "node_new": node_new, "apt": apt_result, "totals": total_by_src},
              open(os.path.join(REPORT_DIR, "latest.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    save_state(state)

    # docker イメージの更新(Alpine の修正版がある場合・任意)
    docker_result = apply_docker_updates(new) if new else None

    # Claude の調査(初回=基準作成では行わない)
    claude_text = claude_investigate(new_high, report_path) if (new_high and not first_run) else None

    # 通知
    if new or node_new or (apt_result and not apt_result.startswith("(適用せず)")):
        top = sorted(new, key=lambda x: (x.get("score") or (9 if lv(x) == 'critical' else 7 if lv(x) == 'high' else 0)), reverse=True)[:6]
        body = [f"新しい脆弱性 {len(new)} 件" + (" (" + ", ".join(f"{k} {v}" for k, v in sorted(by_level.items())) + ")" if new else "")]
        for f in top:
            body.append(f"- [{lv(f)}] {f['source']} {f['package']} {f['id']}")
        if node_new:
            body.append(f"Node.js お知らせ {len(node_new)} 件: " + "; ".join(n["title"] for n in node_new[:3]))
        if apt_result:
            body.append(f"自動対策: {apt_result}")
        if docker_result:
            body.append(f"docker: {docker_result}")
        if first_run:
            body.insert(0, "初回(基準作成)。以後はこの時点より後に現れたものだけを知らせます")
        if claude_text:
            m = re.search(r"要約[:：]\s*(.+)", claude_text, re.S)
            body.append("調査の要約: " + (m.group(1) if m else claude_text)[:700].strip())
        body.append(f"報告書: {report_path}")
        prio = "high" if new_high else "default"
        notify("secwatch: " + ("要確認(高・重大あり)" if new_high else "新着あり"), "\n".join(body), prio, "shield")
    log(f"done: new={len(new)} high={len(new_high)} node_new={len(node_new)} report={report_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
