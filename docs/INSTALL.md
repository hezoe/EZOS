# EZOS インストール手順書（作業者確認つき / Claude実行前提）

このドキュメントは **新しいサーバーに EZOS を導入する** ための手順書です。
想定シナリオはこうです:

1. 作業者がサーバーに SSH ログインする
2. Claude Code を導入し、Pro/Max アカウントで認証する
3. 作業者が Claude に「Git と GitHub CLI(gh) を入れて」と指示する
4. 作業者が Claude に「このリポジトリ(github.com/hezoe/EZOS)をインストールして」と指示する
5. **Claude は本書を読み、まず下の「確認シート」を作業者に質問** → 回答を得てから STEP を順に実行する

> **Claude への指示（重要）**: 本書を実行するときは、まず必ず
> **「STEP 0 確認シート」** の各項目を作業者に質問し、値が全部そろってから STEP 1 以降に進むこと。
> IP・DNS・パスキー登録端末など、環境依存で勝手に決められない値を仮定しない。
> インフラ（Docker / Caddy）は「まず存在確認 → 有れば設定を追記、無ければ導入方針を提示」の順で進める。
> サービス名・ポート・設置先などが万一すでに使われていたら、Claude が空きを選んで作業者に伝える（衝突回避は都度判断でよい）。

---

## STEP 0. 作業者に確認する項目（インストール前に必ず質問）

Claude は次の表を作業者に提示し、空欄を埋めてもらう。埋まるまで先へ進まない。

| # | 確認項目 | 例 / 既定 | 用途 |
|---|---|---|---|
| 1 | サーバーのグローバルIP | `160.16.105.64` | DNS がここへ向いているかの確認 |
| 2 | 公開ホスト名(URL) | `https://ezos.ezoe.net` | Caddy のサイト名 / WebAuthn origin |
| 3 | WebAuthn の rpID(親ドメイン) | `ezoe.net` | パスキーの有効範囲。ホスト名の親ドメインを指定 |
| 4 | DNS 設定は完了しているか | 済 / これから | 未なら A(またはワイルドカード)を #1 のIPへ。反映待ちも確認 |
| 5 | 最初にパスキーを登録する端末名 | `作業者のノートPC(Chrome)` | 初回登録は **その端末のブラウザ**から `https://<host>` を開いて行う |
| 6 | systemd サービス名 | `ezos` | 既定でよい |
| 7 | localhost 待受ポート | `3100` | 既定でよい |
| 8 | 設置ディレクトリ | `/home/debian/EZOS` | リポジトリを置く場所 |
| 9 | 実行ユーザー | `debian` | systemd の User= と Caddy 操作権限 |

#3・#6〜#9 は既定のままで問題ない。作業者に確認が要るのは主に **#1 IP / #2 ホスト名 / #4 DNS / #5 パスキー登録端末**。

確認できたら、以降のコマンド内のプレースホルダをこう置き換える:

```
HOST=ezos.ezoe.net            # #2 のホスト名(スキームなし)
ORIGIN=https://ezos.ezoe.net  # #2 のURL
RPID=ezoe.net                 # #3
PORT=3100                     # #7
SERVICE=ezos                  # #6
APPDIR=/home/debian/EZOS      # #8 (この直下に app/ が入る)
USER_=debian                  # #9
```

---

## STEP 1. 前提コマンドの確認 / 導入

Claude Code 導入後、次が揃っているか確認する（`git`・`gh` は作業者指示で先に入っている想定）。

```bash
for c in git gh node npm jq tmux curl; do
  printf '%-6s ' "$c"; command -v "$c" || echo 'MISSING'
done
node -v   # v20 以上を推奨
```

- 不足があれば導入: `sudo apt-get update && sudo apt-get install -y jq tmux curl`
- Node が古い/無い場合は Node 20 系を導入(nodesource 等)。
- `gh auth status` で GitHub 認証を確認(未認証なら `gh auth login`)。

---

## STEP 2. インフラ確認（Docker / Caddy / リバースプロキシ）

TLS終端＆リバースプロキシをどう用意するかを **まず存在確認 → 有れば利用、無ければ方針提示** で決める。

```bash
command -v docker && docker ps --format '{{.Names}}' | grep -i caddy   # => saas-caddy が出れば利用可
ls -d /home/debian/saas/caddy/sites 2>/dev/null                        # サイト定義ディレクトリ
grep -n 'import .*/sites/\*' /home/debian/saas/caddy/Caddyfile 2>/dev/null  # サイト自動読込の有無
```

- **Docker の Caddy(`saas-caddy` 等)が動いている場合**: `sites/*.caddy` を1枚足すだけで公開できる → STEP 6 へ。
  `sites/` と `saas/` が作業ユーザー所有・docker グループ所属なら **sudo 不要**でファイル作成と reload が可能。
- **Caddy が無い / 別のリバースプロキシの場合**: ここで作業者に方針を確認する。
  - 既存の nginx 等がある → その流儀で `<host>` を `127.0.0.1:<port>` へ転送し TLS を張る(設定例は STEP 6 の Caddy 定義を読み替え)。
  - リバースプロキシ自体が無い → 「Caddy を Docker で入れるか、単体で入れるか」を提示して合意を得てから進む。**勝手に443を専有しない。**

---

## STEP 3. リポジトリ取得

```bash
gh repo clone hezoe/EZOS "$APPDIR"    # または: git clone https://github.com/hezoe/EZOS.git "$APPDIR"
cd "$APPDIR/app"
```

---

## STEP 4. 依存インストール & 初期設定（config.json 生成）

`setup.js` は環境変数で値を受け取れる（このインストールの `ORIGIN`・`RPID`・`PORT` を**必ず渡す**）。
`data/config.json` は `.gitignore` 対象＝インストールごとの実行時設定。

```bash
cd "$APPDIR/app"
npm install --omit=dev

EZOS_ORIGIN="$ORIGIN" EZOS_RPID="$RPID" EZOS_PORT="$PORT" \
  node setup.js
# => data/config.json を作成し、セットアップキー(パスキー登録に必要)を表示する
```

表示された **セットアップキー**を控える（STEP 9 の初回パスキー登録で使う）。
必要なら `EZOS_USERNAME` で表示ユーザー名も指定可。キーを後で再発行するには
`node setup.js --regen-setup-key`。

---

## STEP 5. systemd サービス化（自動起動・自動再起動）

`app/ezos.service` は基準機向けの参考ファイル。**下のテンプレで実値を埋めて生成**する。
`KillMode=process` は node だけ止めて node-pty が起こした tmux(=永続ターミナル)を再起動で生かし続けるため。

**起動順の注意**: server.js は `172.17.0.1`(docker0) にも待受する(Caddyコンテナから `host.docker.internal` 経由で届くため)。
この docker0 アドレスは **dockerd 起動後に初めて現れる**ので、EZOSが Docker より先に起動すると bind が `EADDRNOTAVAIL` で失敗する。
そのため unit を **`After=docker.service`(+`Wants=`)** で Docker の後に起動させる。
併せて server.js 側でも `EADDRNOTAVAIL` を検知したら3秒後にリトライして待受を確立する(順序制御と二重の保険)。

```bash
sudo tee /etc/systemd/system/${SERVICE}.service >/dev/null <<UNIT
[Unit]
Description=EZOS (${HOST}) - Claude web cockpit
# docker0(172.17.0.1)への待受のため Docker 起動後に立ち上げる(未導入機でも起動できるようWantsは弱依存)
After=network-online.target docker.service
Wants=network-online.target docker.service

[Service]
Type=simple
User=${USER_}
WorkingDirectory=${APPDIR}/app
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
KillMode=process
Environment=NODE_ENV=production
Environment=HOME=/home/${USER_}

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now ${SERVICE}
systemctl is-active ${SERVICE}          # => active
ss -tlnp | grep ":${PORT}"              # => 127.0.0.1:<port> で node が待受
```

---

## STEP 6. Caddy サイト定義（公開）

Docker の Caddy を使う場合。`sites/` に1枚 `${SERVICE}.caddy` を作る。

```bash
cat > /home/${USER_}/saas/caddy/sites/${SERVICE}.caddy <<CADDY
${HOST} {
  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
    X-Content-Type-Options "nosniff"
    X-Frame-Options "DENY"
    Referrer-Policy "strict-origin-when-cross-origin"
    # 音声入力(getUserMedia/Web Speech API)のため microphone のみ自オリジン許可
    Permissions-Policy "geolocation=(), microphone=(self), camera=()"
    -Server
  }
  encode zstd gzip
  reverse_proxy host.docker.internal:${PORT} {
    flush_interval -1
  }
}
CADDY

docker exec saas-caddy caddy validate --config /etc/caddy/Caddyfile   # => Valid configuration
docker exec saas-caddy caddy reload   --config /etc/caddy/Caddyfile   # => reload OK
```

- `flush_interval -1` は SSE/ストリーミング(Claude出力)をバッファせず流すため。
- `host.docker.internal` はコンテナからホスト上のサービスへ届く名前(compose の extra_hosts)。
- reload 後、Caddy が `${HOST}` の Let's Encrypt 証明書を HTTP-01 で自動取得する(数秒)。**#4 の DNS が #1 のIPへ解決していること**が前提。

---

## STEP 7. セッション追跡フック（任意・推奨）

管制塔でこのサーバーの Claude セッションを追跡したい場合、`~/.claude/settings.json` の各フックで
`${APPDIR}/app/bin/ez-hook.sh <state>` を呼ぶ。送信先ポートはスクリプトが `data/config.json` から自動取得する。
フックの対応は README「セッション状態の判定」表のとおり（SessionStart/Stop→idle、PreToolUse→working/running、Notification→waiting_user 等）。

---

## STEP 8. 検証

```bash
getent hosts "$HOST"                                                   # => <IP> $HOST (DNS一致)
curl -sS -o /dev/null -w "%{http_code} ssl=%{ssl_verify_result}\n" "$ORIGIN/"   # => 200 ssl=0
```

`200 ssl=0` なら公開成功（証明書検証OK）。

---

## STEP 9. 初回パスキー登録（作業者の端末で）

1. **STEP 0 #5 で決めた端末**のブラウザで `${ORIGIN}` を開く。
2. ログイン画面で **STEP 4 で控えたセットアップキー**を入力し、パスキーを登録する。
3. 登録後、セットアップキーは無効化（または `--regen-setup-key` で再発行して保管）してよい。

---

## トラブルシュート

| 症状 | 確認 |
|---|---|
| `curl` が 502/522 | `systemctl is-active ${SERVICE}` と `ss -tlnp | grep :${PORT}`。node が落ちていないか `journalctl -u ${SERVICE} -e` |
| 証明書が出ない | `getent hosts ${HOST}` がサーバIPを返すか(DNS未反映)。Caddy ログ `docker logs saas-caddy` |
| パスキー登録できない | `config.json` の `origin` がアクセスURLと**完全一致**か、`rpID` がホストの親ドメインか |
| セッションが管制塔に出ない | フックのパス、`ez-hook.sh` が読む `data/config.json` のポート、`/api/beat` 到達性 |
| 再起動後に `172.17.0.1` で待受しない / `EADDRNOTAVAIL` | EZOSが Docker より先に起動し docker0 が未生成。unit の `After=/Wants=docker.service` を確認(`systemctl cat ${SERVICE}`)。server.js は自動リトライするので `journalctl -u ${SERVICE}` に `retrying in 3s` が出ていれば数秒後に回復 |

## ロールバック

```bash
rm /home/${USER_}/saas/caddy/sites/${SERVICE}.caddy
docker exec saas-caddy caddy reload --config /etc/caddy/Caddyfile
sudo systemctl disable --now ${SERVICE}      # サービス停止(他ホストには影響しない)
```

---

### 参考: 実施記録

`ezos.ezoe.net` を基準機の既存 Caddy に相乗りさせた具体的な実施ログは
[ezos-domain-setup.md](ezos-domain-setup.md) を参照。
