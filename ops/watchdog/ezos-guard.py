#!/usr/bin/env python3
"""EZOS 追加策 C (2026-11-13): 認証の失敗が続く送信元を自動で遮断する。

EZOS の監査記録(journald・1 行 JSON)から直近 10 分の login_fail / reauth_fail / passkey_register_fail を
送信元 IP ごとに数え、5 回以上なら 1 時間、iptables の EZOS-GUARD チェーン(DOCKER-USER の先頭から呼ぶ)で
DROP する。Caddy(docker)へ届く前に落ちるので、node のログイン前 API に総当たりが届かなくなる。
  - 私設網(10.66/16 の VPN・docker の網・127/8)は遮断しない(操作者の経路を閉じない)
  - 状態は /var/lib/service-watchdog/ezos-guard.json。毎分の実行で期限切れを外し、チェーンを作り直す
    (catvpn-hub-firewall.sh が DOCKER-USER を組み直しても、次の実行で呼び出しを戻す)
  - 遮断したら ntfy で知らせる(設定は service-watchdog.conf)
使い方: ezos-guard.py            … 1 回分の処理(timer から毎分)
        ezos-guard.py list       … 遮断中の一覧
        ezos-guard.py unblock IP … 手動で解除
        ezos-guard.py block IP   … 手動で 1 時間遮断(動作確認用)
"""
import ipaddress
import json
import os
import re
import subprocess
import sys
import time
import urllib.request

STATE = "/var/lib/service-watchdog/ezos-guard.json"
CONF = "/etc/service-watchdog.conf"
CHAIN = "EZOS-GUARD"
WINDOW_SEC = 600
THRESHOLD = 5
BAN_SEC = 3600
FAIL_EVENTS = {"login_fail", "reauth_fail", "passkey_register_fail"}
NEVER_BLOCK = [ipaddress.ip_network(n) for n in ("10.66.0.0/16", "172.16.0.0/12", "127.0.0.0/8", "::1/128", "fc00::/7")]


def read_conf():
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


def notify(title, body, priority="high", tags="no_entry"):
    url, topic = read_conf()
    if not topic:
        return
    try:
        # 見出しの日本語は RFC 2047 で包む(HTTP ヘッダは latin-1 のみ。ntfy が解釈する)
        import base64
        t = "=?UTF-8?B?" + base64.b64encode(title.encode("utf-8")).decode("ascii") + "?=" if any(ord(c) > 127 for c in title) else title
        req = urllib.request.Request(f"{url}/{topic}", data=body.encode("utf-8"), method="POST",
                                     headers={"Title": t, "Priority": priority, "Tags": tags})
        urllib.request.urlopen(req, timeout=8).read()
    except Exception:
        pass


def is_protected(ip):
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return True
    return any(a in n for n in NEVER_BLOCK)


def load_state():
    try:
        return json.load(open(STATE, encoding="utf-8"))
    except (OSError, ValueError):
        return {"blocked": {}}


def save_state(st):
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    tmp = STATE + ".tmp"
    json.dump(st, open(tmp, "w", encoding="utf-8"))
    os.replace(tmp, STATE)


def ipt(*args, check=False):
    return subprocess.run(["iptables", *args], capture_output=True, text=True, check=check)


def recent_failures():
    out = subprocess.run(["journalctl", "-u", "ezos", "--since", f"-{WINDOW_SEC}s", "-o", "cat", "--no-pager"],
                         capture_output=True, text=True).stdout
    counts = {}
    for line in out.splitlines():
        if not line.startswith("{") or '"audit"' not in line:
            continue
        try:
            j = json.loads(line)
        except ValueError:
            continue
        if j.get("audit") in FAIL_EVENTS and j.get("ip"):
            counts[j["ip"]] = counts.get(j["ip"], 0) + 1
    return counts


def sync_rules(blocked):
    """チェーンを状態どおりに作り直し、DOCKER-USER の先頭から呼ばれていることを保証する"""
    ipt("-N", CHAIN)
    ipt("-F", CHAIN)
    for ip in sorted(blocked):
        fam = "-s"
        ipt("-A", CHAIN, fam, ip, "-j", "DROP")
    if ipt("-C", "DOCKER-USER", "-j", CHAIN).returncode != 0:
        ipt("-N", "DOCKER-USER")
        ipt("-I", "DOCKER-USER", "1", "-j", CHAIN)


def main(argv):
    st = load_state()
    blocked = st.setdefault("blocked", {})
    now = int(time.time())

    if len(argv) >= 2 and argv[1] == "list":
        for ip, exp in sorted(blocked.items()):
            print(f"{ip}\t残り {max(0, exp - now)} 秒")
        return 0
    if len(argv) >= 3 and argv[1] == "unblock":
        blocked.pop(argv[2], None)
        save_state(st); sync_rules(blocked)
        print(f"解除: {argv[2]}")
        return 0
    if len(argv) >= 3 and argv[1] == "block":
        if is_protected(argv[2]):
            print("私設網の IP は遮断しません"); return 1
        blocked[argv[2]] = now + BAN_SEC
        save_state(st); sync_rules(blocked)
        print(f"遮断(手動): {argv[2]}")
        return 0

    # 期限切れを外す
    for ip in [ip for ip, exp in blocked.items() if exp <= now]:
        del blocked[ip]
        print(f"期限切れで解除: {ip}")

    # 直近の失敗を数えて新たに遮断
    newly = []
    for ip, n in recent_failures().items():
        if n >= THRESHOLD and ip not in blocked and not is_protected(ip):
            blocked[ip] = now + BAN_SEC
            newly.append((ip, n))
    save_state(st)
    sync_rules(blocked)
    for ip, n in newly:
        msg = f"⛔ EZOS: 認証の失敗が {WINDOW_SEC // 60} 分に {n} 回続いた送信元を 1 時間遮断しました\nIP: {ip}\n解除: sudo ezos-guard.py unblock {ip}\n{time.strftime('%F %T %Z')}"
        print(msg.replace("\n", " / "))
        notify("EZOS guard: 遮断", msg)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
