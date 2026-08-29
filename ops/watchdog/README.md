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
| 証明書更新の見届け | `cert-renewal-check.{sh,service,timer}`（任意・`CERTRENEW_HOST` 設定時） |

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
- `CERTRENEW_HOST` / `CERTRENEW_LASTDAY` ＋ `cert-renewal-check.timer` の `OnCalendar` — 証明書更新の見届け。

## ロジック（service-watchdog）
1. 全サービスを評価。
2. 同一巡回で `SYSTEMIC_THRESHOLD` 件以上同時失敗 → 基盤障害の疑いで個別再起動を抑止し通知1本。
3. それ以外は `FAIL_THRESHOLD` 回**連続**失敗のみ `restart_cmd` → `POST_RESTART_WAIT` 秒後に再チェック → **成否に関わらず通知**。
4. `COOLDOWN_SEC` 内は同一サービスへ再アクションしない（フラップ防止）。
5. 環境アラートは状態ベースで重複通知を抑制。

## 運用コマンド
```sh
sudo systemctl start service-watchdog.service            # 手動1回
sudo journalctl -u service-watchdog.service -n 30 --no-pager
systemctl list-timers 'service-watchdog*' 'db-backup*' 'cert-renewal*'
sudo systemctl stop service-watchdog.timer               # 一時停止
```

> 注: このツールは EZOS 本体とは別レイヤ（root/systemd）。EZOS のアプリ更新(`sudo systemctl restart ezos`)とは独立に動く。
> Claude 連携（スキル/フック/メモリ）については `docs/CLAUDE_INTEGRATION.md` を参照。`ezstatus.sh` は本設定 `SERVICES` を再利用する。
