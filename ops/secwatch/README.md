# secwatch — 新しい脆弱性を見つけたらすぐ調べて対策する

CVE-2026-98432(受信機の IP オプションの件)のように、公表された脆弱性へ素早く対応するための仕組み。
在庫(何を使っているか)を集めて脆弱性データベースと突き合わせ、前回までに無かったものを通知・記録し、
できる対策は自動で行い、重いものは Claude Code を無人で起動して調査させる。

## 照合する在庫と情報源
| 在庫 | 情報源 | 備考 |
|---|---|---|
| VPS の Debian パッケージ(bookworm) | debsecan(Debian セキュリティトラッカー) | 修正版が出ているものは apt で自動更新(`SECWATCH_AUTO_APT=1`) |
| 受信機の Debian パッケージ(Raspbian bullseye) | 到達できる受信機から dpkg の状態ファイルを週 1 回取得 → debsecan | 受信機はクラブ LAN 内。修正は受信機側の更新で |
| npm(EZOS / ogn-web / navlog / notam / Takikawa-WEB / flightlog / FEELDSCOPE webapp の lock) | OSV.dev | GitHub の Dependabot と二重。開発時のみの部品は (dev) 表示 |
| Python(pip --user) | OSV.dev(PyPI) | |
| docker コンテナ(Caddy / PostgreSQL の Alpine パッケージ) | OSV.dev(Alpine) | 対策はイメージの pull と up |
| Node.js 本体 | nodejs.org の脆弱性フィード | 更新は nodesource の無人更新+node-refresh が行う |

## 動き(`secwatch.timer` 08:30 / 20:30 JST)
1. 在庫 → 照合 → 新しい脆弱性(状態 `/var/lib/secwatch/state.json` に無いもの)を抽出
2. 報告書 `docs/security/secwatch/YYYY-MM-DD_HHMM.md` と `latest.json`
3. Debian の修正版を apt で適用(VPS のみ)
4. 新着があれば ntfy(高・重大があれば高優先)。通知には上位 6 件・自動対策・調査の要約・報告書の場所
5. 高・重大の新着があれば Claude Code を無人で起動し(読み取りのツールだけ・変更しない)、露出・緩和策・恒久対策・緊急度を調べて報告書に追記、要約を通知

## 運用
```sh
sudo systemctl start secwatch.service                 # 手動 1 回
journalctl -u secwatch -n 30 --no-pager
python3 /usr/local/bin/secwatch.py --dry --no-claude  # 通知・apt・Claude なしの試運転
python3 /usr/local/bin/secwatch.py --refresh-receiver # 受信機の在庫を取り直す
```
設定は `/etc/secwatch.env`(`SECWATCH_AUTO_APT` / `SECWATCH_CLAUDE` / `SECWATCH_RECEIVERS` / `SECWATCH_NPM_LOCKS` など)。
通知先は `service-watchdog.conf` の ntfy を共用。

## 注意
- debsecan の「未修正・低緊急度」は数千件あるが、通知するのは新しく現れたものだけ。初回は全件を「既知」として取り込むため、
  導入直後の報告書は大きい(通知には件数と上位だけ)。
- 無人の Claude 調査は提案まで。対策の適用(設定変更・更新)は EZOS から浩さんの指示で行う。
- 自動 apt は Debian の修正版(stable / security)だけ。再起動が要る更新(カーネル等)は通知で知らせる。
