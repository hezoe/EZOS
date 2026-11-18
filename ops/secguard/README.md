# secguard — 外部に面した部分の記録と見張り(2026-11-14)

VPS の外から届く口(Caddy の全サイト・CATVPN/EZOS-Admin の WireGuard・操作者 VPN からの SSH)と、公開サービスの中身を
記録して見張る。攻撃らしい動きは ntfy(service-watchdog と同じトピック)で知らせ、段階を踏んで対処する。
**サービスの停止を最終の対策とし、システム全体が乗っ取られないようにする**(権限分離 R-016 の上に重ねる)。

## 記録(合計 2GB・90 日)

| 記録 | 場所 | 上限 |
|---|---|---|
| Web のアクセス(全サイト+IP 直打ち) | `saas/caddy/data/logs/<名前>.access.log`(共通設定 `saas/caddy/sites/00-access-log.caddy`) | 20MB ごとに gzip・90 日・合計 1.4GB(`secguard-logbudget` が古い順に消す) |
| 防火壁で拒否した通信 `SECGUARD-*`・sshd・sudo・各サービス | journald | 400MB・90 日(`zz-secguard-journald.conf`) |
| 公開サービスの実行・管理者の設定の書き換え | auditd `/var/log/audit/` | 20MB×5 |
| secguard の判定(遮断・隔離・学習) | `/var/lib/secguard/events.jsonl` | 5MB×5 |

Web の記録は、調査に要らない欄(応答ヘッダの大半・ブラウザの細かいヘッダ・TLS)を落として約 1/3 にしている。
Cookie/Authorization は残さない。応答の Content-Type と Location は残す(攻撃への 200 が「ページ」か「中身の漏れ」かの判定)。

防火壁の記録(正本 `catvpn-hub/hub/catvpn-hub-firewall.sh`、毎分の上限付き):
- `SECGUARD-EGRESS`(UID 付き): 公開サービスの専用ユーザーが内部(EZOS・SSH・登録 API・VPN・docker 網)へ出ようとした。平常時 0 件
- `SECGUARD-CTR`: コンテナがホストの禁止ポートや VPN へ出ようとした
- `SECGUARD-IN`: インターネット側から捨てた通信(走査が常にあるので記録だけ)

## 検知と対処

| 兆候 | 対処 |
|---|---|
| Web: 弱点探し(`.env`・`wp-`・`.git` など 1 点)・危険な要求(`${jndi:`・`../`・`$(…)`・`${IFS}`・SQL/コマンド注入など 5 点。URL は 16KB まで調べる)・認証の失敗(1 点)が 10 分で 10 点 / 404 が 10 分で 80 件 / 5 分で 3000 件 | その IP を 24 時間遮断(ipset `secguard-ban`・raw PREROUTING)。30 分ごとのまとめ通知 |
| Web: 探りに HTML 以外の中身を 2xx で返した | 漏れの疑いとして通知(多くのサイトは知らない URL にも `index.html`(text/html)を返すので、それは除く) |
| 公開サービスのユーザーが内部へ出ようとした(`SECGUARD-EGRESS`) | **そのサービスを隔離(停止)**・至急の通知 |
| 公開サービスのユーザー(ogn/navlog/notam/takikawa)・docker の flightlog(uid 1001)/postgres(70)がシェル・ネット道具・sudo などを実行した(auditd `sg_exec`) | **隔離**・至急 |
| 上のうち、docker のコンテナの起動から 120 秒以内の実行(Alpine の起動手順は env・id・sh などを busybox で動かす) | 起動の手順として記録だけ(`exec_container_start`・まとめ通知)。秒数は `CONTAINER_START_GRACE` |
| 公開サービスのユーザーが sudo を試みた | **隔離**・至急 |
| 見覚えのない実行・公開サービスの新しい待ち受けポート | 学習期間(設置から 48 時間)は覚えるだけ。その後は**隔離** |
| コンテナが禁止先へ出ようとした(`SECGUARD-CTR`) | 通知(Caddy を止めると EZOS を含む全サイトが止まるので、自動では止めない) |
| おとりファイル(下記)への書き込み・改名・削除(拒否された試みも数える)・中身の不一致(5 分ごとに照合) | **ランサム攻撃の疑い**として至急の通知(10 分に 1 回まで、残りはまとめへ)。公開サービスのユーザーなら**隔離** |
| アカウント・sudoers・SSH の鍵・secguard 自身の書き換え | 至急ではない高優先の通知 |
| systemd・/usr/local・WireGuard・cron の書き換え | まとめ通知(apt/dpkg による変更は除く) |
| SSH のログイン | 通知(SSH は操作者の VPN からだけ届く) |

遮断しないもの: VPN の中(10.0.0.0/8)・docker 網・VPS 自身・`/etc/secguard.conf` の `ALLOW_IPS`。
常習の発信元の区画は `/etc/secguard.conf` の `BLOCK_NETS`(空白区切りの CIDR)に書くと、期限なしに遮断する(ipset `secguard-block`・raw PREROUTING。
書き換えたら `sudo systemctl restart secguard` で入れ直す)。書き間違いの保険として、/16 より広い区画・VPN/内部・`ALLOW_IPS` と重なる区画は受け付けない。
1 時間に 300 件を超える遮断は止めて知らせる(誤判定の暴走防止)。通知は 1 時間 30 件まで(至急は数えない)。

おとりファイル(2026-11-16): `/home/debian`・`/home/debian/saas`・`/home/debian/workspace`・`/var/lib`・`/var/backups`・`/opt`・`/srv`・`/root`
の下の `000-confidential/`(`passwords.xlsx` など 3 つ。root の持ち物・読み取り専用)。誰も触らないはずの場所なので、触られたら暗号化が始まった疑いとみる。
置き場は `secguard.py` の `CANARY_DIRS` と `50-secguard.rules` の `sg_canary` を揃える。作るのは `install.sh`(`secguard.py --make-canaries`。常駐は書き込めない囲いの中)。
消えたり書き換えられたりしたものは証拠として残し、確かめてから `--make-canaries` で置き直す(中身の違う既存ファイルは上書きしないので、先に消す)。

systemd が起動したもの(親が PID 1)は、サービスの起動として扱う。管理者の `docker exec`(親が containerd-shim/runc)は
記録だけにする(ホストの root でしかできないため)。

## 隔離(停止)と戻し方

隔離すると `/var/lib/secguard/quarantine/<名前>` に印を置き、そのサービスのユニット(タイマーも)・コンテナを止める。
印があるあいだは `90-secguard.conf`(`ConditionPathExists=!…`)で systemd が起動せず、service-watchdog も起こし直さない
(再起動後も止まったまま)。

| 名前 | 止まるもの |
|---|---|
| ogn | ogn-web・ogn-collect・ogn の取り込みタイマー 5 つ |
| navlog / notam / takikawa | navlog / notam / takikawa-web |
| flightlog | flightlog-app コンテナ |
| postgres | saas-postgres・flightlog-app コンテナ |

確かめてから戻す:

```
sudo secguard-release            # 隔離中の一覧(理由つき)
sudo secguard-release notam      # 印を消して起動し直す
```

調べるところ: `/var/lib/secguard/events.jsonl`、`sudo ausearch -k sg_exec -i`、`journalctl -k | grep SECGUARD`、
`journalctl -u secguard`。遮断の一覧は `sudo ipset list secguard-ban`。1 件外すなら `sudo ipset del secguard-ban <IP>`
(`/var/lib/secguard/bans.json` からも消す)。

## 設置

```
sudo ./install.sh     # ipset/auditd・本体・auditd 規則・journald の上限・隔離の条件・timer を設置
```

設定は `/etc/secguard.conf`(root 0600・repo には入れない。例は `secguard.conf.example`)。`ACTION=observe` にすると
遮断も停止もせず知らせるだけになる(`sudo systemctl restart secguard`)。

ファイル: `secguard.py`(常駐)・`secguard.service`・`secguard-release`・`secguard-logbudget.{sh,service,timer}`(毎日 04:40)・
`50-secguard.rules` / `99-secguard-enable.rules`(auditd。Debian の既定では監査が無効のままなので `-e 1` で有効にする)・
`auditd-secguard.sh`・`zz-secguard-journald.conf`・`90-secguard.conf`。

試し: `sudo python3 -I secguard.py --test-web`(今の Web の記録を最初から読み、遮断の候補を表示するだけ)。
