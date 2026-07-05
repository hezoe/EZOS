# EZOS

**ブラウザからClaude Codeを使うための自分専用コックピット。** パスキー認証付きで、どの端末のブラウザからでもVPS上の `claude` を対話実行できる。

> **EZOS** はアプリ全体の名前。中に3つのモードを持つ:
> **EZterminal**(ターミナル) / **EZbrowser**(内蔵ブラウザ) / **EZeditor**(ファイル編集)。
> 新しいサーバーへ入れるときは **[docs/INSTALL.md](docs/INSTALL.md)** を参照(Claude Codeに読ませればほぼ自動で導入できる)。

- 🖥 **EZterminal**: xterm.js + WebSocket + node-pty + tmux。ブラウザがVPSのターミナルそのものになり、`claude` を対話実行できる。切断してもtmuxでセッション永続、PC/スマホで同一セッションに接続可。ターミナル/Claude出力中のファイルパスはクリックで**EZeditorに直接開く**(入力切替ON/OFFどちらでも動作。テキストの選択コピーも同様。アプリへマウス報告したい時はAlt+操作)
- 🗼 **開発ハブ**: 並列AI開発ダッシュボード
  - **セッション管制塔**: VPS上の全Claude Codeセッションの状態（🛑止まった/🔔あなた待ち/⚙️作業中/▶️処理中/⏳待機中）をフック経由で自動追跡。名札・色はセッションIDに紐づき永続。あなた待ちは待たせ時間が長い順
  - **カンバン**: 未着手/作業中/確認待ち/完了、D&D移動、プロジェクト横断、💬議論中/✋保留フラグ
  - **確認待ち受信箱**: 説明の「確認URL: …」を🔗ボタン化、✓完了ワンクリック+取り消しトースト、NEWバッジ
  - **自動追従**: セッションカードをクリックするとカンバンがそのプロジェクトに切替
- 🔑 **認証**: WebAuthnパスキー（1Password対応）。初回登録はセットアップキー必須
- 📱 **スマホ最適化**: サーバー側UA判定でレイアウト切替（`?view=mobile|desktop|auto`）

## 構成

各インストールは **1つの Node アプリ + systemd サービス + Caddy のサイト定義** で成り立つ。
下表はこのリポジトリの基準デプロイ例(値はインストールごとに変わる。実値は `app/data/config.json` と systemd/Caddy 側で決まる)。

| 項目 | 例(基準機) |
|---|---|
| リポジトリ | `github.com/hezoe/EZOS` |
| アプリ | `app/`(Node 20、`type:module`) |
| systemd サービス | `ezos`(WorkingDirectory=作業ツリーの `app/` を直接起動) |
| 待受(localhost) | `127.0.0.1:3100` |
| 公開ドメイン | `ezos.ezoe.net`(Caddy がreverse_proxy、証明書自動) |
| 認証設定 | `rpID`・`origin`・`port`・`setupKey` を `app/data/config.json` に保持 |

- **データ**: `app/data/*.json`（DB不使用、`.gitignore` 対象）。`config.json` にセットアップキー等の実行時設定
- **Claude Code**: グローバルインストール＋Pro/Maxアカウント認証（`~/.claude/.credentials.json`）が前提
- **セッション追跡**: `~/.claude/settings.json` のフック → `app/bin/ez-hook.sh` → `POST http://127.0.0.1:<port>/api/beat`（localhost限定・認証不要。ポートは同梱 `config.json` から自動取得）

```
app/
  server.js        HTTP/WSサーバー・ルーティング・ページ描画(UA判定)
  setup.js         初期セットアップ(config.json 生成・セットアップキー発行。環境変数で値指定可)
  lib/store.js     JSONストレージ・config読込
  lib/term.js      WebSocket⇔pty(tmux)ブリッジ
  lib/termstate.js tmuxセッション状態の取得
  lib/hub.js       開発ハブの状態ロジック(UI非依存)
  lib/filemgr.js   EZeditor(ファイル操作)のバックエンド
  lib/claude.js    claudeヘッドレス実行(旧チャットAPI用、現在UIなし)
  bin/ez-hook.sh   Claude Codeフック→ハートビート(送信先ポートはconfig.jsonから)
  public/          フロントエンド。EZterminal=term.js / EZbrowser=ezbrowser.js /
                   EZeditor=ezeditor.js(+シンタックスハイライタ ezhl.js, ezeditor.css) /
                   app.css / hub.js / app.js 等。EZeditorはEZbrowserからwindow.EZEditor経由で利用
```

## インストール / デプロイ

- **新規サーバーへの導入**: **[docs/INSTALL.md](docs/INSTALL.md)** を参照。
  作業者に確認すべき項目(IP・公開ホスト名・DNS・パスキー登録端末・ポート/サービス名)を先頭でまとめており、
  Claude Codeにこのリポジトリを渡せば対話的に確認しながらほぼ自動で導入できる。
- **既存の基準機での更新**: 作業ツリーを直接編集 → `sudo systemctl restart <サービス名>` で反映 → commit/push。
  依存追加時は `cd app && npm install --omit=dev` の後に restart。
- **実施記録の例**: `ezos.ezoe.net` を既存Caddyへ相乗りさせた実例は [docs/ezos-domain-setup.md](docs/ezos-domain-setup.md)。

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
