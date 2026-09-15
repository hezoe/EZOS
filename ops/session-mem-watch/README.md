# session-mem-watch — EZOS セッションメモリ早期警告

EZOS（`ezos.service` cgroup）内で動く Claude Code セッションが肥大化して **MemoryMax（cgroupハードキャップ）で OOM 強制終了される「前」に** ntfy へプッシュ通知し、`/next` での圧縮やセッション終了を促す監視ツール。EZOS 本体とは別レイヤ（root/systemd）で動く。

- 2026-09-10 に「1本のセッションが 2.7GB まで膨張して全体枯渇→OOM」した事象の再発防止。
- 監視: (A) 単一 `claude` セッションの RSS が `THRESHOLD_MB` 超 / (B) `ezos.service` cgroup の使用率が `CGROUP_PCT` 超。
- 通知は対象（PID/cgroup）ごとに `COOLDOWN` 秒に1回まで（スパム抑止）。

## 構成

| 役割 | 実体 |
|---|---|
| 監視スクリプト（正本） | `app/bin/session-mem-watch.sh`（install で `/usr/local/bin` へ設置） |
| 設定（実値・非公開） | `/etc/ezos-session-mem-watch.conf`（雛形＝`session-mem-watch.conf.example`） |
| 起動 | `session-mem-watch.timer`（10分毎）→ `session-mem-watch.service`（oneshot） |
| 状態 | `/var/lib/ezos/session-mem-watch.state`（通知済み記録） |

## インストール（初回・利用者が設定）

```bash
# 1) 設置（初回は install.sh が example から /etc/ezos-session-mem-watch.conf を生成）
sudo ops/session-mem-watch/install.sh
# 2) 通知先(ntfy)を自分専用の値に編集
sudo vi /etc/ezos-session-mem-watch.conf     # NTFY_TOPIC を推測困難な文字列に（必要なら閾値も）
# 3) 再実行（既存 /etc conf は保持される）
sudo ops/session-mem-watch/install.sh
```

環境変数でゼロタッチ導入も可能:
```bash
sudo EZOS_NTFY_TOPIC="ezos-mem-xxxxxxxx" ops/session-mem-watch/install.sh
```
`https://ntfy.sh/<NTFY_TOPIC>` を（アプリ/ブラウザで）購読すると通知が届く。

## 設定（`/etc/ezos-session-mem-watch.conf`）

`session-mem-watch.conf.example` 参照。主なもの:
- `NTFY_URL` / `NTFY_TOPIC` … 通知先（**未設定だと通知は飛ばない**）。
- `THRESHOLD_MB`（既定1600）… 単一セッションの警告RSS。`ezos.service` の `MemoryMax` より手前に。
- `CGROUP_PCT`（既定88）… cgroup 使用率の警告閾値。
- `COOLDOWN`（既定21600=6h）… 同一対象の再通知間隔。

> 後方互換: `/etc/ezos-session-mem-watch.conf` に `NTFY_TOPIC` が無い場合、既存の `/etc/vps-healthcheck.conf`（service-watchdog 等と共有）の ntfy 設定を流用する。

## 運用

```bash
sudo systemctl start session-mem-watch.service           # 手動1回
sudo journalctl -u session-mem-watch.service -n 30 --no-pager
systemctl list-timers 'session-mem-watch*'
sudo systemctl disable --now session-mem-watch.timer     # 一時停止
```

閾値の動作確認（実際に通知が飛ぶ）:
```bash
sudo env SMW_CONF=/etc/ezos-session-mem-watch.conf THRESHOLD_MB=50 COOLDOWN=1 /usr/local/bin/session-mem-watch.sh
```
※ テスト通知が実際に送信されるので注意。テスト後は `/var/lib/ezos/session-mem-watch.state` の擬似記録を消しておくとよい。
