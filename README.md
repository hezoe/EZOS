# EZeditor

**https://ezeditor.ezoe.net/** — ブラウザからClaude Codeを使うための自分専用コックピット。

- 🖥 **ターミナル**: xterm.js + WebSocket + node-pty + tmux。ブラウザがVPSのターミナルそのものになり、`claude` を対話実行できる。切断してもtmuxでセッション永続、PC/スマホで同一セッションに接続可
- 🗼 **開発ハブ**: 並列AI開発ダッシュボード
  - **セッション管制塔**: VPS上の全Claude Codeセッションの状態（🛑止まった/🔔あなた待ち/⚙️作業中/▶️処理中/⏳待機中）をフック経由で自動追跡。名札・色はセッションIDに紐づき永続。あなた待ちは待たせ時間が長い順
  - **カンバン**: 未着手/作業中/確認待ち/完了、D&D移動、プロジェクト横断、💬議論中/✋保留フラグ
  - **確認待ち受信箱**: 説明の「確認URL: …」を🔗ボタン化、✓完了ワンクリック+取り消しトースト、NEWバッジ
  - **自動追従**: セッションカードをクリックするとカンバンがそのプロジェクトに切替
- 🔑 **認証**: WebAuthnパスキー（1Password対応）。初回登録はセットアップキー必須
- 📱 **スマホ最適化**: サーバー側UA判定でレイアウト切替（`?view=mobile|desktop|auto`）

## 構成

- ホスト: さくらVPS `160.16.105.64`（Debian 12、`ssh 160.16.105.64` = user debian）
- アプリ: `/home/debian/ezeditor/app`（Node 20、systemdサービス `ezeditor`、127.0.0.1/172.17.0.1:3100）
- 公開: Caddy(Docker, `/home/debian/saas/caddy/sites/ezeditor.caddy`) が `ezeditor.ezoe.net` をreverse_proxy。証明書自動
- データ: `app/data/*.json`（DB不使用）。`config.json` にセットアップキー
- Claude Code: グローバルインストール、Pro/Maxアカウント認証済み（`~/.claude/.credentials.json`）
- セッション追跡: `~/.claude/settings.json` のフック → `app/bin/ez-hook.sh` → `POST http://127.0.0.1:3100/api/beat`（localhost限定・認証不要）

```
app/
  server.js        HTTP/WSサーバー・ルーティング・ページ描画(UA判定)
  lib/store.js     JSONストレージ
  lib/term.js      WebSocket⇔pty(tmux)ブリッジ
  lib/hub.js       開発ハブの状態ロジック(UI非依存)
  lib/claude.js    claudeヘッドレス実行(旧チャットAPI用、現在UIなし)
  bin/ez-hook.sh   Claude Codeフック→ハートビート
  public/          app.css / term.js / hub.js / app.js(ログイン画面)
  setup.js         初期セットアップ(セットアップキー生成)
```

## デプロイ

```sh
cd EZEditor
tar czf - -C app . | ssh 160.16.105.64 'tar xzf - -C ~/ezeditor/app && sudo systemctl restart ezeditor'
```

依存追加時は `ssh 160.16.105.64 'cd ~/ezeditor/app && npm install --omit=dev'`。

## セッション状態の判定（フック→状態マップ）

| フック | 状態 |
|--------|------|
| SessionStart / Stop | ⏳ idle |
| UserPromptSubmit / PostToolUse | ⚙️ working |
| PreToolUse (Bash系) | ▶️ running |
| PreToolUse (その他) | ⚙️ working |
| Notification | 🔔 waiting_user |
| SessionEnd | 削除 |
| working/runningのまま6分無応答 | 🛑 stopped (導出) |

## 将来拡張のメモ

- GitHub Issue同期（要PAT。lib/hub.jsの保存系に中継を挟む形で追加可能）
- パネルの自由レイアウト（ステップ④）
- 複数ターミナルタブ（tmuxセッション切替、`/ws/term?s=名前` は実装済み）
- チャットUIの復活（`/api/chat` はサーバーに残存）
