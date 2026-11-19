# service-watchdog（EZOS 同梱・任意のホスト監視）

EZOS を動かすホストの**サービス死活監視・自動再起動・通知**をまとめた軽量な運用ツール。EZOS 本体（Node アプリ）とは
独立した **root/systemd のコンポーネント**で、EZOS 以外のサービスも監視できる。導入は任意。

- **L7 監視＋自動再起動**: 各サービスを HTTP(ステータス＋内容照合) / systemd active で監視し、連続失敗したものだけを個別に再起動して通知。
- **環境アラート(通知のみ)**: ディスク使用率 / HTTPS証明書の残日数 / systemd の failed ユニット / メモリ・スワップ・OOM / DBバックアップ鮮度 / 外部死活監視(Dead-man's switch)。
- **DBバックアップ**: postgres コンテナを毎晩 `pg_dumpall` で保存＋世代ローテーション。
- **証明書更新の見届け**: 指定ドメインの更新窓で「更新されたか」を確認して通知（任意）。

通知は [ntfy](https://ntfy.sh) を利用。すべての実値（監視対象・ドメイン・ntfyトピック・ping URL 等）は
**`/etc/service-watchdog.conf`（ローカル・非公開）**に置く。リポジトリには雛形 `service-watchdog.conf.example` のみを含む。

## 構成

| 役割 | パス |
|---|---|
| ソース(正本) | `EZOS/ops/watchdog/`（本ディレクトリ） |
| チェック本体(root) | `/usr/local/bin/service-watchdog.sh` |
| 設定(実値・非公開) | `/etc/service-watchdog.conf`（雛形＝`service-watchdog.conf.example`） |
| 状態 | `/var/lib/service-watchdog/` |
| 起動 | `service-watchdog.timer`（既定5分毎）→ `service-watchdog.service`(oneshot) |
| DBバックアップ | `db-backup.{sh,service,timer}`（毎晩） |
| オフサイト複製 | `offsite-backup.sh`（`/usr/local/sbin`・`db-backup-offsite.conf` で db-backup の後に実行） |
| バックアップの書き換え点検 | `backup-integrity-check.{py,service,timer}`（毎朝 05:20） |
| 証明書更新の見届け | `cert-renewal-check.{sh,service,timer}`（任意・`CERTRENEW_HOST` 設定時） |
| 別ホストの見張り | `remote-host-watch.{sh,service,timer}`（2 分毎・設定 `/etc/remote-host-watch.conf` があるとき） |

## インストール

```sh
# 1) 設定を用意（初回は install.sh が example から /etc に生成する。実値へ編集）
sudo ops/watchdog/install.sh
sudo vi /etc/service-watchdog.conf     # SERVICES / NTFY_TOPIC / CERT_HOSTS / BACKUP_TARGETS 等を実値に
sudo ops/watchdog/install.sh           # 再実行（既存 /etc conf は保持される）
```

`install.sh` は各スクリプトを `/usr/local/bin` へ、systemd unit を `/etc/systemd/system` へ設置し、タイマを有効化する。
`/etc/service-watchdog.conf` は**既存があれば上書きしない**（編集済みの実値を保全）。

## 設定の要点（`service-watchdog.conf`）
`service-watchdog.conf.example` のコメント参照。主なもの:
- `SERVICES=( "name|kind|target|min|max|substr|restart_cmd" ... )` — 監視対象。kind=http/systemd。
- `NTFY_URL` / `NTFY_TOPIC` — 通知先。トピックは秘匿。
- `DISK_*` / `CERT_*` / `MEM_*` — 環境アラート閾値。`CERT_HOSTS` は証明書残日数を見る公開ドメイン。
- `DEADMAN_URL` — healthchecks.io 等の ping URL（空=無効）。毎巡回 ping し、途絶を外部が検知。
- `FAILED_UNITS_CHECK` / `FAILED_UNITS_IGNORE` — systemd failed の総ざらいと除外。
- `BACKUP_TARGETS="container|POSTGRES_USER ..."` / `BACKUP_DBS` — DBバックアップ対象と鮮度監視対象。
- `BACKUP_REMOTE_TARGETS="名前|user@host|鍵 ..."`(2026-11-19) — 別ホストの DB。相手側の authorized_keys で鍵を `from=…,restrict,command="DB を gzip した SQL で出す台本"` に絞り、db-backup が受け取りながら `/etc/offsite-backup/secrets.pub.asc` で暗号化して `<名前>-日時.sql.gz.gpg` に置く(VPS では開けない)。offsite-backup がさくら vps-db へ送り、改ざん点検・鮮度監視(`BACKUP_DBS` に名前を足す)・さくらの世代整理も `.sql.gz.gpg` を扱う。実例: JP1 ホスト(`jp1|ubuntu@<IP>|/etc/offsite-backup/jp1_backup_ed25519`、相手の台本 `/usr/local/sbin/jp1-db-dump`)。
- `REMOTE_SECRETS="名前|user@host|鍵 ..."`(2026-11-19・`/etc/offsite-backup/offsite-backup.conf`) — 別ホストの秘密情報。相手側で同じ公開鍵 `secrets.pub.asc` を置き、鍵の `command=` の入口が `secrets` で「tar.gz を暗号化したもの」だけを出す(平文は相手から出ない)。offsite-backup が受け取り、宛先の鍵が `secrets.pub.asc` であることだけ確かめて `/var/backups/secrets/<名前>-secrets-日時.tar.gz.gpg`(3 世代)に置き、さくら vps-secrets へ送る。実例: JP1 ホスト(入口 `/usr/local/sbin/jp1-backup` → `jp1-secrets-dump`。DB と同じ鍵で、指定なし=DB)。
- `CERTRENEW_HOST` / `CERTRENEW_LASTDAY` ＋ `cert-renewal-check.timer` の `OnCalendar` — 証明書更新の見届け。

## ロジック（service-watchdog）
1. 全サービスを評価。
2. 同一巡回で `SYSTEMIC_THRESHOLD` 件以上同時失敗 → 基盤障害の疑いで個別再起動を抑止し通知1本。
3. それ以外は `FAIL_THRESHOLD` 回**連続**失敗のみ `restart_cmd` → `POST_RESTART_WAIT` 秒後に再チェック → **成否に関わらず通知**。
4. `COOLDOWN_SEC` 内は同一サービスへ再アクションしない（フラップ防止）。
5. 環境アラートは状態ベースで重複通知を抑制。

## オフサイト複製(`offsite-backup.sh`)

毎晩 db-backup のあとに走る。失敗は ntfy(vps-healthcheck のトピック)。送り先は `/etc/offsite-backup/offsite-backup.conf` の `REMOTE=`(公開リポジトリには載せない)。

| | 中身 | 置き先 | 保持 |
|---|---|---|---|
| A | 当日の DB ダンプ | さくら `~/backups/vps-db/` | 14 日 |
| B / C | さくら `~/www` のミラー(月曜は tar も) | VPS `/var/backups/sakura/` | ミラー + 3 世代 |
| D | 秘密情報(WireGuard 鍵・CATVPN 台帳・`/etc` の実値・各 `.env`・SSH/署名鍵・systemd ユニット・cron)を暗号化 | さくら `~/backups/vps-secrets/`(VPS にも 3 世代) | 30 日 |

D は git に入れない物を VPS 消失に備えて外へ置くためのもの。対象は台本の `SECRET_PATHS`。
暗号化は公開鍵 `/etc/offsite-backup/secrets.pub.asc` で行い、**復号の秘密鍵は VPS にもさくらにも置かない**(持ち主が手元で保管)。
対象が消えている・暗号化や複製に失敗したときは通知する。

### 書き換えの点検(`backup-integrity-check.py`・毎朝 05:20)

`offsite-backup.sh` はバックアップを作るたびに指紋(SHA-256)を台帳 `/var/lib/offsite-backup/manifest.tsv` に残し、
同じ台帳をさくら `~/backups/manifest.tsv` にも置く(70 日で行を落とす。変わらないリポジトリの最新 bundle は毎晩時刻を進めて残す)。点検はこれと照らし合わせ、違いがあれば高優先で通知する。

- VPS のバックアップ(DB ダンプ・暗号化した秘密情報・www のスナップショット)とさくらの写しが台帳の指紋と一致するか
- 台帳にないファイルが紛れ込んでいないか・保持期間内のファイルが消えていないか
- VPS とさくらの台帳が同じか(片方だけ書き換えても気づく)
- VPS の置き場が root 専用(700)で、ファイルが他人から書けないか

台帳の列は「種類・名前・指紋・記録時刻・置き場所(local/both/remote)」。バックアップと同時には動かない(`/run/offsite-backup.lock`)。
試すときは `sudo python3 -I /usr/local/sbin/backup-integrity-check.py --no-notify`。台帳を作り直すときは `--init`(台帳に無いファイルを今の中身で登録)。

さくら側は受け取り専用(`sakura/backup-recv.sh` を `~/bin/backup-recv`、`sakura/backup-rotate.sh` を `~/bin/backup-rotate` に置き cron で毎日)。
VPS の鍵ではさくらの `backups/` を読めない・消せないので、写しを取り出すのは持ち主の鍵(制限なし)で行う。

戻し方(秘密鍵 `OFFSITE-SECRETS-PRIVATE-KEY.asc` を手元から持ってくる。写しは持ち主の鍵で取り出して VPS へ運ぶ):

```sh
G=$(mktemp -d /dev/shm/g.XXXX)
gpg --homedir "$G" --import OFFSITE-SECRETS-PRIVATE-KEY.asc
scp <さくらのアカウント>:backups/vps-secrets/vps-secrets-YYYYmmdd-HHMMSS.tar.gz.gpg .   # 持ち主の鍵で
gpg --homedir "$G" -d vps-secrets-YYYYmmdd.tar.gz.gpg | tar -tzvf -            # 中身を確かめる
gpg --homedir "$G" -d vps-secrets-YYYYmmdd.tar.gz.gpg | sudo tar -xzpf - -C / etc/wireguard   # 要る物だけ戻す
rm -rf "$G"
```

## 別ホストの見張り(`remote-host-watch.sh`・2026-11-19)
別の VPS(例: JP1)を、この VPS から VPN 越しに 2 分毎に見張る。通知は service-watchdog と同じ ntfy。
- 見るもの: WireGuard の最後の通信(`WG_STALE_SEC` より古い=VPN 切れ)・SSH で届くか・相手のサービス(is-active)・failed ユニット・ディスク・空きメモリ・相手側の DB バックアップの鮮度・公開 URL の L7(`REMOTE_HTTP`)。再起動待ちの更新は 1 回だけ知らせる。
- 連続 `FAIL_THRESHOLD` 回の異常で 1 回知らせ、続けば `REMIND_SEC` ごとに念押し、戻れば回復を知らせる。サービス/URL の異常では、許したユニットだけを相手の入口で再起動する。
- 相手の鍵は `from=<VPN のこちらの IP>,restrict,command="<入口>"` に絞る。入口が受け付けるのは `status`(読むだけ)と `restart <unit>`(相手側でも許可リストと 15 分の間隔を確かめる)だけ。シェルは渡さない。
- 設定の雛形は `remote-host-watch.conf.example`。実値(宛先・鍵・WireGuard の公開鍵)は `/etc/remote-host-watch.conf`(root 600)に置き、リポジトリに入れない。

## 運用コマンド
```sh
sudo systemctl start service-watchdog.service            # 手動1回
sudo journalctl -u service-watchdog.service -n 30 --no-pager
systemctl list-timers 'service-watchdog*' 'db-backup*' 'cert-renewal*' 'remote-host-watch*'
sudo journalctl -u remote-host-watch.service -n 30 --no-pager  # 別ホストの見張り
sudo systemctl stop service-watchdog.timer               # 一時停止
```

> 注: このツールは EZOS 本体とは別レイヤ（root/systemd）。EZOS のアプリ更新(`sudo systemctl restart ezos`)とは独立に動く。
> Claude 連携（スキル/フック/メモリ）については `docs/CLAUDE_INTEGRATION.md` を参照。`ezstatus.sh` は本設定 `SERVICES` を再利用する。

## EZOS の乗っ取り防止の追加策(2026-11-13・R-091 の受容に伴う代替)
EZOS 本体の守り(パスキー・CSP・署名付き自己更新)に加え、root/systemd 側で次を動かす。設定は `service-watchdog.conf` の ntfy を共用。
- **node-refresh**(`node-refresh.timer` 04:30): `/etc/apt/apt.conf.d/52nodesource-unattended` で nodesource の nodejs も無人更新の対象にし、更新後に古い node で動き続けているサービス(`NODE_REFRESH_UNITS`、既定 ezos navlog notam navlog-swim-recv ogn-web takikawa-web)を夜間に再起動して通知。
- **ezos-guard**(`ezos-guard.timer` 毎分): EZOS の監査記録(journald)で 10 分に 5 回以上認証に失敗した送信元を 1 時間 iptables(`EZOS-GUARD` チェーン・`DOCKER-USER` の先頭から呼ぶ)で遮断し通知。VPN(10.66/16)・docker の網・localhost は遮断しない。`sudo ezos-guard.py list|unblock IP|block IP`。
- **ezos-integrity-check**(`ezos-integrity-check.timer` 04:10・debian で実行): HEAD の署名、app/ の稼働コードとコミットの一致(data/・node_modules/ を除く)、ezos の実行ファイルと作業ディレクトリ、`npm audit`(本番依存・high 以上)を確認し、違いがあれば高優先で通知。問題が無ければ journal に 1 行だけ。
- EZOS 本体(app/server.js)の通知強化: ログイン/パスキー登録・削除の通知に IP・端末(OS/ブラウザ)・パスキー名を含め、初めての端末からのログインと認証失敗の連続(10 分 5 回)を高優先で通知。
```sh
systemctl list-timers 'node-refresh*' 'ezos-*'
sudo journalctl -u ezos-guard -n 20 --no-pager
sudo systemctl start ezos-integrity-check.service && journalctl -u ezos-integrity-check -n 5 --no-pager
```
