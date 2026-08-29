# EZOS × Claude Code 連携セットアップ（インストールメモ）

EZOS は Claude Code を組み込んだ Web コックピットであり、**アプリ本体だけでなく Claude Code 側の設定
（フック / スキル / メモリ / statusLine）**に依存して初めて本来の使い勝手になる。
このメモは、**新しいホストに EZOS を導入する作業者が、Claude に何を導入すればよいか**をまとめたもの。

対象ファイルの場所（`${APPDIR}` = EZOS の設置先。既定 `/home/debian/EZOS`。`${HOME}` = 実行ユーザのホーム）:
- Claude Code 設定: `${HOME}/.claude/settings.json`
- スキル: `${HOME}/.claude/skills/<name>/SKILL.md`
- メモリ: `${HOME}/.claude/projects/<project-slug>/memory/`
- グローバルフック: `${HOME}/.claude/hooks/`
- 連携スクリプト本体: `${APPDIR}/app/bin/`（**リポジトリに同梱**。設置先パスに合わせて settings.json から参照する）

> 方針: **フック/statusLine の実体は `app/bin` に単一ソースで置き、settings.json からパス参照**する。
> `~/.claude/hooks/` に薄いラッパーを置く旧方式は、起動中セッションが古いパスを掴んで反映されない問題があるため使わない。

---

## 1. settings.json（`${HOME}/.claude/settings.json`）

`model` と `statusLine`、各 `hooks` を設定する。パスは設置先に合わせて置換すること。

```jsonc
{
  "model": "opus[1m]",
  "statusLine": { "type": "command", "command": "${APPDIR}/app/bin/usage-statusline.sh", "padding": 0 },
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "${APPDIR}/app/bin/ez-hook.sh idle session_start" }] },
      { "hooks": [{ "type": "command", "command": "${APPDIR}/app/bin/ezstatus-sessionstart.sh" }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "${APPDIR}/app/bin/ez-hook.sh working prompt" }] },
      { "hooks": [{ "type": "command", "command": "${APPDIR}/app/bin/ez-title.sh" }] },
      { "hooks": [{ "type": "command", "command": "/usr/bin/node ${HOME}/.claude/hooks/project-memory.js", "timeout": 30 }] }
    ],
    "PreToolUse":  [ { "hooks": [{ "type": "command", "command": "${APPDIR}/app/bin/ez-hook.sh pretool pretool" }] } ],
    "PostToolUse": [ { "hooks": [{ "type": "command", "command": "${APPDIR}/app/bin/ez-hook.sh working posttool" }] } ],
    "Notification":[ { "hooks": [{ "type": "command", "command": "${APPDIR}/app/bin/ez-hook.sh waiting_user notify" }] } ],
    "Stop":        [ { "hooks": [{ "type": "command", "command": "${APPDIR}/app/bin/ez-hook.sh idle stop" }] } ],
    "SessionEnd":  [ { "hooks": [{ "type": "command", "command": "${APPDIR}/app/bin/ez-hook.sh ended session_end" }] } ]
  }
}
```

各フックの役割:

| イベント | 呼ぶもの | 役割 |
|---|---|---|
| statusLine | `usage-statusline.sh` | 使用量(rate limits)を `app/data/usage.json` に書き GUI 上部ウィジェットへ供給（コンソール表示は意図的に空） |
| SessionStart | `ez-hook.sh idle session_start` | セッション開始をハブへ通知（状態=idle） |
| SessionStart | `ezstatus-sessionstart.sh` | **起動時にサーバ状態ダッシュボードを提示**（startup/clearのみ） |
| UserPromptSubmit | `ez-hook.sh working prompt` | 稼働状態をハブへ通知 |
| UserPromptSubmit | `ez-title.sh` | **端末タブ名を現在の作業内容へ自動追随**（毎ターン、非同期でLLM要約） |
| UserPromptSubmit | `project-memory.js` | プロンプトにプロジェクト名があれば**専用メモリ＋Git同期状況を自動注入** |
| PreToolUse | `ez-hook.sh pretool` | ツール実行開始（Bash等はrunning）を通知 |
| PostToolUse | `ez-hook.sh working posttool` | ツール完了を通知 |
| Notification | `ez-hook.sh waiting_user notify` | 確認待ち（waiting_user）を通知 |
| Stop / SessionEnd | `ez-hook.sh idle stop` / `ended session_end` | 応答終了 / セッション終了を通知 |

**任意**: 端末で Claude の away サマリ（"※recap:"）を消したい場合、EZOS の端末生成時に環境変数
`CLAUDE_CODE_ENABLE_AWAY_SUMMARY=0` を tmux セッションへ伝播させる（settings.json ではなくサーバ側で設定）。

---

## 2. リポジトリ同梱スクリプト（`${APPDIR}/app/bin/`）

settings.json / スキルから参照される実体。導入は「リポジトリを clone し、settings.json のパスを合わせる」だけ。

| スクリプト | 用途 |
|---|---|
| `ez-hook.sh` | 各フック→EZOSハブ(`/api/beat`)へハートビート。送信ポートは `app/data/config.json` から取得 |
| `ez-title.sh` + `ez-title.mjs` | 端末タブ名の作業要約。`ez-title.sh`(フック入口)が非同期起動→`ez-title.mjs`が直近会話を `claude -p --model haiku` で短い日本語見出しに要約し `app/data/titles/<tmuxセッション名>.json` に記録。サーバの `getTitles()` が pane_title より優先採用 |
| `ezstatus.sh` | サーバ状態ダッシュボード（稼働サービス/CPU/メモリ/スワップ/ディスク/ロード）。スキル `server-status` と起動時フックが利用 |
| `ezstatus-sessionstart.sh` | SessionStartフック入口。startup/clear時に `ezstatus.sh` の出力を追加コンテキストとして注入 |
| `usage-statusline.sh` | 使用量ウィジェット用データ生成（statusLine） |
| `release.mjs` | バージョン自動バンプ＋リリースノーツ追記（下記メモリ「versioning」参照） |

---

## 3. `EZOS_HOOK_SILENT` ガード規約（重要・触る前に必読）

`ez-title.mjs` は要約のために **headless `claude -p` を毎ターン起動**する。この子 claude もフックを発火するため、
無防備だと **UserPromptSubmit→ez-title.sh→また `claude -p`… の無限再帰**や、他フックの毎ターン空回りが起きる。

対策として、要約用 claude は環境変数 `EZOS_HOOK_SILENT=1` を立てて起動し、**各フックスクリプトの先頭で
`[ -n "$EZOS_HOOK_SILENT" ] && exit 0` により即終了**させている（`ez-title.sh` / `ez-hook.sh` /
`ezstatus-sessionstart.sh` / `project-memory.js` に実装済み）。

→ **新しいフックを追加するときは、必ず同じガードを先頭に入れること。** 入れ忘れると再帰・多重実行の温床になる。
（`claude --bare` は hooks を全スキップできるが OAuth 資格情報も読まず "Not logged in" になるため使わない。）

---

## 4. スキル（`${HOME}/.claude/skills/`）

### server-status — サーバ状態ダッシュボード
「サーバの状態」「server status」「サービス動いてる?」等で発動し、`ezstatus.sh` を実行して一覧表示する個人スキル。

設置: `${HOME}/.claude/skills/server-status/SKILL.md` を作成（内容は下記）。スクリプト本体はリポジトリ同梱の `ezstatus.sh`。

```markdown
---
name: server-status
description: サーバ(EZOS稼働ホスト)の状態を一覧表示する。稼働中の全サービスの状態(systemd/L7)、CPU・メモリ・スワップ・ディスク・ロードの使用状況をまとめて出す。「サーバの状態」「server status」「システム状態」「サーバの負荷/リソース/使用状況」「サービスは動いてる?」等で発動する。
---
# /server-status — サーバ状態ダッシュボード
1. `${APPDIR}/app/bin/ezstatus.sh` を Bash で実行する（数秒・root不要）。
2. 出力を**そのままフェンス付きコードブロックで**提示する（整列済みなので加工しない）。
3. 🔴 のサービスやリソース逼迫があれば一言添える。全て正常なら短くまとめる。
```

> `ezstatus.sh` の監視対象は、存在すれば `/etc/service-watchdog.conf` の `SERVICES` を再利用し、無ければ内蔵の既定リストを使う。
> **既定リストは設置環境ごとに実サービスへ調整すること**（ホスト固有のサービス名/ポートが入っている）。

---

## 5. メモリ（`${HOME}/.claude/projects/<project-slug>/memory/`）

EZOS 運用では Claude の**永続メモリ**を活用する。`project-memory.js`(UserPromptSubmitフック) が、プロンプトに
プロジェクト名を検出すると、そのプロジェクトの `memory/` と Git 同期状況を自動でコンテキストに注入する。

- **仕組み**: 各プロジェクトの `memory/MEMORY.md`(索引) ＋ 1ファイル1事実の md 群。`project-memory.js` 内の
  `MAP`(プロジェクト名→slug/dir) は**環境固有**なので、導入先のプロジェクト構成に合わせて編集する。
- **作法**: 1メモリ=1事実、frontmatter(`name`/`description`/`type`)付き。`type` は user / feedback / project / reference。
  追加したら `MEMORY.md` に1行の索引を足す。コードやGit履歴で分かることは書かない（非自明な意思決定・運用手順・罠を残す）。

### 導入時にまず用意したい EZOS 用シードメモリ（推奨トピック）
新規導入でも早めに持っておくと有益なもの（内容は各ホストの実値で作成）:

| トピック | 何を残すか |
|---|---|
| バージョン運用 | コミット毎に `app/bin/release.mjs` でパッチ自動バンプ＋リリースノーツ追記（上げ忘れると更新判定が働かない） |
| 稼働ポート | EZOS の実ポート（例: 3101。READMEの例と異なる場合の実値） |
| 稼働unitとリポジトリの差異 | `/etc/systemd/system` の手動カスタム版が正本で、リポジトリのunit編集は自動反映されない、等の運用差 |
| フック/statusLine構成 | 本メモの要点（app/bin単一ソース＋settings.json参照、`EZOS_HOOK_SILENT`ガード） |
| タブ名の仕組み | `ez-title` サイドチャネル方式（pane_titleは初回固着のため使わない） |
| 多言語/UI規約 | UI文字列は i18n の辞書へ両言語追加し `window.EZ.t()` 参照 |
| 公開リポジトリの秘匿規約 | 公開リポジトリに実ドメイン/実IP/秘密を書かない（例示値を使う） |
| manual iframe の罠 | Caddy の X-Frame-Options:DENY で iframe内遷移が拒否される等の既知の罠 |

---

## 6. 検証

- `${APPDIR}/app/bin/ezstatus.sh` が単体で状態一覧を出す。
- 端末で1往復すると数秒後にタブ名が作業内容に変わる（`app/data/titles/` にJSONができる）。
- `settings.json` を保存後、**新規セッション**でフックが効く（起動中セッションは起動時にフックを読むため要張り直し）。
- `server-status` スキルが「サーバの状態」で発動する。

## 7. 注意

- フック/スキルの変更は基本 **新規セッションから反映**。バックエンド（`app/server.js` 等）変更は `sudo systemctl restart ezos` が必要。
- `app/data/`（`titles/`・`usage.json`・`config.json`）は実行時データで gitignore 済み。
- 本メモは EZOS リポジトリ内の連携に限る。ホスト監視(ntfy等)は EZOS とは別系統のため本書には含めない。
