# 実施記録: EZOS を ezos.example.com で公開 (実例)

> これは特定サーバーでの **実施ログ(1つの実例)** です。
> 新しいサーバーへ入れる汎用手順は **[INSTALL.md](INSTALL.md)** を参照してください。
> 本書はその INSTALL.md の STEP 2/5/6(既存 Caddy 相乗り公開)を、基準機で実際に行った記録です。

新インストール **EZOS** を `https://ezos.example.com` で公開するために行った作業の記録。
既存の **ezeditor** (`ezeditor.example.com`、基準機の本番) はそのまま残す(無変更)。

実施日: 2026-07-05 / 基準機: さくらVPS `203.0.113.10` (Debian 12, user debian)

---

## 1. 構成の全体像

このVPSでは Caddy(Docker `saas-caddy`) が全ホストを統一リバースプロキシしている。
EZOS と ezeditor は **それぞれ独立した Node アプリ + systemd サービス** として並存する。

| 項目 | ezeditor(旧) | **EZOS(新)** |
|---|---|---|
| ディレクトリ | `/home/debian/workspace/EZeditor/app` | `/home/debian/EZOS/app` |
| systemd サービス | `ezeditor` | `ezos` |
| 待受ポート(localhost) | `3100` | `3101` |
| 公開ドメイン | `ezeditor.example.com` | `ezos.example.com` |
| Caddyサイト定義 | `sites/ezeditor.caddy` | `sites/ezos.caddy` |

- 両アプリの `rpID` は **`example.com`**(親ドメイン)。WebAuthn のパスキーは rpID 単位で有効なので、
  **同じパスキーが両サブドメインで使える**(EZOS用にパスキーを作り直す必要はない)。
- 各アプリの `origin`(WebAuthn の期待オリジン)は自分のドメイン単一で設定:
  EZOS = `https://ezos.example.com` / ezeditor = `https://ezeditor.example.com`。
  → **ezeditor 側のコード/設定は変更不要**(ドメインごとに別アプリが応答するため)。

---

## 2. 前提(この作業の前に完了していたこと)

- DNS: `ezos.example.com` が VPS(203.0.113.10)へ解決すること(ワイルドカード or A レコード)。確認:
  ```
  getent hosts ezos.example.com    # => 203.0.113.10 ezos.example.com
  ```
- EZOS アプリが稼働していること(別途セットアップ済み):
  ```
  systemctl is-active ezos       # => active
  ss -tlnp | grep 3101           # => 127.0.0.1:3101 で node が待受
  ```
- EZOS の `app/data/config.json` が自ドメイン向けに設定済み:
  `rpID=example.com`, `origin=https://ezos.example.com`, `port=3101`。
  (`app/data/` は `.gitignore` 対象=インストールごとの実行時設定)

---

## 3. 実施手順(Caddy 設定)

Caddyの sites ディレクトリと saas ディレクトリは debian 所有、debian は docker グループ所属のため、
**sudo 不要**でファイル作成と reload が可能。

### 3-1. サイト定義を作成

`/home/debian/saas/caddy/sites/ezos.caddy` を新規作成(ezeditor.caddy と同型、転送先だけ 3101):

```caddy
ezos.example.com {
  # 音声入力(getUserMedia/Web Speech API)のため microphone のみ自オリジン許可(=self)
  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
    X-Content-Type-Options "nosniff"
    X-Frame-Options "DENY"
    Referrer-Policy "strict-origin-when-cross-origin"
    Permissions-Policy "geolocation=(), microphone=(self), camera=()"
    -Server
  }
  encode zstd gzip
  reverse_proxy host.docker.internal:3101 {
    flush_interval -1
  }
}
```

- `sites/*.caddy` は `Caddyfile` の `import /etc/caddy/sites/*.caddy` で自動読み込みされる。
- `flush_interval -1` は SSE/ストリーミング(Claude出力)をバッファせず流すため。
- `host.docker.internal` はコンテナからホスト上のサービスへ到達するための名前(compose の extra_hosts)。

### 3-2. 反映(検証 → reload)

```bash
docker exec saas-caddy caddy validate --config /etc/caddy/Caddyfile   # => Valid configuration
docker exec saas-caddy caddy reload   --config /etc/caddy/Caddyfile   # => reload OK
```

reload 後、Caddy が `ezos.example.com` の Let's Encrypt 証明書を HTTP-01 で自動取得する(数秒)。

---

## 4. 検証

```bash
# EZOS: 200 かつ TLS 検証成功(証明書発行OK)
curl -sS -o /dev/null -w "%{http_code} ssl=%{ssl_verify_result}\n" https://ezos.example.com/
#   => 200 ssl=0

# ezeditor が無変更で生きていること
curl -sS -o /dev/null -w "%{http_code}\n" https://ezeditor.example.com/
#   => 200
```

ブラウザで `https://ezos.example.com` を開き、既存パスキーでログインできることを確認する
(rpID=example.com のため ezeditor で登録済みのパスキーがそのまま使える)。

---

## 5. ロールバック

EZOS の公開を取り下げる場合:

```bash
rm /home/debian/saas/caddy/sites/ezos.caddy
docker exec saas-caddy caddy reload --config /etc/caddy/Caddyfile
```

(必要なら `sudo systemctl disable --now ezos` でサービスも停止。ezeditor には影響しない)

---

## 6. 新ホストを増やすときの一般手順(参考)

1. アプリを別ポート(例 3102…)で systemd サービス化し localhost bind。
2. `app/data/config.json` の `origin` を自ドメイン、`rpID` は共有したいなら `example.com`。
3. `sites/<name>.caddy` を作成(`reverse_proxy host.docker.internal:<port>`)。
4. `docker exec saas-caddy caddy reload --config /etc/caddy/Caddyfile`。
5. DNS がワイルドカード `*.example.com` なら DNS 変更不要。
