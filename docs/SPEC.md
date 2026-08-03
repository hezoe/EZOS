# EZOS 仕様書（現行実装ベース）

> 本書はコードベースを走査して作成した、**現時点で実際に動作している仕様**のまとめです。
> 導入手順は [INSTALL.md](INSTALL.md)、公開の実施記録は [ezos-domain-setup.md](ezos-domain-setup.md) を参照。
> 作成日: 2026-07-05 / 対象ビルド: `term.js (2026-07-05i)` / `ezbrowser.js (2026-07-05e)` / `ezeditor.js (2026-07-05g)`

---

## 1. 概要

**EZOS** は「ブラウザからClaude Codeを使うための自分専用コックピット」。パスキー認証付きで、どの端末のブラウザからでもVPS上の `claude` を対話実行できる。1つのアプリの中に3つのモードを持つ:

| モード | 実体ファイル | 役割 |
|---|---|---|
| **EZterminal** | `public/term.js` | xterm.js + WebSocket + node-pty + tmux。ブラウザがVPSのターミナルそのものになる |
| **EZbrowser** | `public/ezbrowser.js` | 内蔵ファイルブラウザ（`/home/debian` 配下） |
| **EZeditor** | `public/ezeditor.js` (+ `ezhl.js`) | 複数タブのテキストエディタ（シンタックスハイライト付き） |

- **認証**: WebAuthn パスキー（1Password 等対応）。初回登録のみセットアップキー必須。
- **表示切替**: サーバー側 UA 判定 + `?view=mobile|desktop|auto`（cookie `ezview`）。`window.EZ.view` が `mobile`/`desktop`。
- **永続性**: 各ターミナルは tmux セッションで永続。切断・再接続・別デバイスからの接続でも同一画面を共有。

---

## 2. システム構成

各インストールは **1 Node アプリ + systemd サービス + Caddy のサイト定義** で成立。

| 項目 | 基準機の例 |
|---|---|
| アプリ | `app/`（Node 20, `type:module`, ESM） |
| systemd サービス | `ezos`（`WorkingDirectory=app/`, `ExecStart=/usr/bin/node server.js`, `Restart=always`, `RestartSec=3`, `KillMode=process`） |
| 待受 | `127.0.0.1:<port>` と `172.17.0.1:<port>`（docker0。Caddyコンテナから `host.docker.internal` 経由で到達） |
| 公開 | Caddy が reverse_proxy + TLS 自動（例 `ezos.example.com`） |
| DB | 不使用。`app/data/*.json`（`.gitignore` 対象） |

- **ポート／ホスト bind**: `config.port`（既定3100）と `config.hosts`（既定 `["127.0.0.1","172.17.0.1"]`）。docker0 が未出現なら `EADDRNOTAVAIL` を検知し3秒ごとにリトライ。
- **`KillMode=process`**: Node 再起動で tmux セッションは殺さない（セッション継続）。
- **tmux ソケット分離**: `lib/tmux.js` が `-L ezos<port>` の専用ソケットを使い、同一ユーザーで複数インストールを動かしてもセッションが混ざらない（`txa()` が全 tmux 呼び出しに前置）。

```
app/
  server.js         HTTP/WSサーバー・ルーティング・ページ描画(UA判定)・認証
  setup.js          config.json 生成・セットアップキー発行(環境変数で値指定可)
  lib/store.js      JSONストレージ・config読込
  lib/term.js       WebSocket⇔pty(tmux)ブリッジ
  lib/termstate.js  tmuxペイン解析によるセッション状態取得・タイトル・CWD・キー送信
  lib/tmux.js       tmuxソケット分離(-L ezos<port>)ヘルパ
  lib/filemgr.js    EZbrowser/EZeditor のファイル操作バックエンド(パス安全化)
  lib/claude.js     claudeヘッドレス実行(残存チャットAPI用。認証後UIなし)
  lib/audit.js      監査ログ配信モジュール(現在サーバーに未接続)
  bin/ez-hook.sh    Claude Codeフック→ハートビート(送信先エンドポイントは現状未実装)
  public/           フロントエンド(term.js / ezbrowser.js / ezeditor.js / ezhl.js /
                    audit.js / app.js / app.css / ezeditor.css / favicon.svg)
  data/*.json       config / credentials / auth_tokens / terminals / conversations
```

---

## 3. 認証（WebAuthn パスキー）

- **登録（初回・端末追加）**
  1. `POST /api/reg-options` `{ setupKey }` → `{ options, challengeId }`（既に認証済みなら setupKey 不要。チャレンジは**5分TTL**でメモリ保持。setupKey 誤りは1.5秒遅延）
  2. ブラウザで `navigator.credentials.create()`
  3. `POST /api/reg-verify` `{ challengeId, attResp, label }` → `{ ok:true }` + `ezsess` cookie 発行。資格情報を `credentials.json` に保存（`id`, `publicKey`(base64), `counter`, `transports[]`, `label`, `createdAt`）
- **ログイン**
  1. `POST /api/login-options` `{}` → `{ options, challengeId }`（資格情報が1つ以上必要）
  2. `navigator.credentials.get()`
  3. `POST /api/login-verify` `{ challengeId, authResp }` → `{ ok:true }` + cookie。`counter` 更新（リプレイ対策）
- **ログアウト**: `POST /api/logout` → cookie 破棄
- **セッション cookie `ezsess`**: `auth_tokens.json` に格納したトークン（base64url 32バイト）。**TTL 30日**。`HttpOnly; Secure; SameSite=Lax; Path=/`。期限切れは新規発行時に掃除。
- **CSRF**: すべての POST に `X-Requested-With: ezos` ヘッダ必須（欠落は 400）。
- **Origin 検証**: WebSocket upgrade と WebAuthn は `config.origin` と一致を要求（不一致は 401）。

---

## 4. HTTP API 一覧

### 4.1 認証（無認証で到達可）
| メソッド | パス | ボディ/クエリ | 応答 |
|---|---|---|---|
| POST | `/api/reg-options` | `{setupKey}` | `{options, challengeId}` |
| POST | `/api/reg-verify` | `{challengeId, attResp, label}` | `{ok}` + cookie |
| POST | `/api/login-options` | `{}` | `{options, challengeId}` |
| POST | `/api/login-verify` | `{challengeId, authResp}` | `{ok}` + cookie |

### 4.2 認証必須（`ezsess` cookie）
| メソッド | パス | 用途 | 応答 |
|---|---|---|---|
| POST | `/api/logout` | ログアウト | `{ok}` |
| GET | `/api/status` | Claude Code ログイン状態（`~/.claude/.credentials.json` 有無） | `{claudeLoggedIn}` |
| GET | `/api/term/view` | 全ターミナルの一覧＋状態 | `{terminals:[{sid,title,state,question?,options?}]}` |
| GET | `/api/term/cwd?sid=` | ターミナルの現在ディレクトリ | `{cwd}` |
| POST | `/api/term/add` | ターミナル追加（`{title?,dir?,kind?}`。`kind:"claude"` は起動時に `claude` を投入） | `{terminal:{sid,title}}` |
| POST | `/api/term/remove` | ターミナル削除（tmux セッション `ez_<sid>` も破棄） | `{ok}` |
| POST | `/api/term/send` | 確認プルダウンの選択（`{sid,key}`。ホワイトリスト: 数字`1〜9`/`escape`/`enter`/`up`/`down`/`interrupt`=C-c） | `{ok}` |
| POST | `/api/upload?dir=&sid=&name=` | ファイルアップロード（最大25MB。保存名は `YYYYMMDDHHMMSS_<name>`。`dir` 指定なしは端末CWD配下 `docs/`） | `{path,name}` |

### 4.3 ファイル操作（`lib/filemgr.js`。全パスは `/home/debian` 配下に制限）
| メソッド | パス | 用途 |
|---|---|---|
| GET | `/api/fs/list?path=&hidden=0\|1` | ディレクトリ一覧（`{path,parent,root,entries[]}`。entry: `name,type,size,mtime,mode,isSymlink,editable`） |
| GET | `/api/fs/read?path=` | テキスト読込（最大2MB。NUL含むバイナリは 415） |
| POST | `/api/fs/write` | 上書き保存（最大4MB。`.eztmp`→rename の**アトミック書込**） |
| POST | `/api/fs/create` | 新規ファイル（名前衝突は `-2` 等で自動回避） |
| POST | `/api/fs/mkdir` | 新規フォルダ |
| POST | `/api/fs/rename` | リネーム/移動（任意で chmod） |
| POST | `/api/fs/chmod` | 権限変更（`0o000`〜`0o777`） |
| POST | `/api/fs/delete` | 削除（`{dir,names[]}`。再帰可。ルートは削除不可） |
| GET | `/api/fs/download?dir=&name=` | 単一ファイルDL（octet-stream, attachment） |
| POST | `/api/fs/archive` | 複数を tar.gz でDL（`tar` を spawn。シェル注入なし） |

### 4.4 残存 API（サーバーに実装あり・認証後UIは無し ＝ レガシー）
`lib/claude.js` の `runClaude` を用いた旧チャット機能。エンドポイントは動作するが、認証後アプリからは呼ばれない（`app.js` のチャットUIは無認証ログイン画面専用）。
| メソッド | パス | 用途 |
|---|---|---|
| GET | `/api/conversations` | 会話一覧 |
| GET | `/api/conversation?id=` | 会話取得 |
| POST | `/api/conversation-delete` | 会話削除 |
| POST | `/api/stop` | 実行中Claudeの停止 |
| POST | `/api/chat`（SSE） | Claude 実行＋ストリーム（`meta/init/delta/thinking/tool/done/error`、15秒ごと `: ping`） |

### 4.5 静的配信・ページ
- `GET /assets/*` → `public/` 配下。`GET /vendor/*` → node_modules の xterm.js。
- `GET /` → 認証状態に応じてログインUI or アプリ本体HTML（`view=mobile|desktop`）。

---

## 5. WebSocket ターミナルプロトコル `/ws/term`

- **URL**: `wss|ws://<host>/ws/term?s=<sid>&cols=<cols>&rows=<rows>`
  - `s`: セッション名（英数と `-`、最大20字、既定 `main`）→ tmux セッション `ez_<s>`
  - `cols`: 20〜500（既定80） / `rows`: 5〜200（既定24）
- **認証**: `ezsess` cookie + Origin 一致（不一致は 401）。
- **メッセージ（クライアント→サーバー, JSON）**
  - `{t:'i', d:'<data>'}` … 入力（pty へ書込）
  - `{t:'r', c:<cols>, r:<rows>}` … リサイズ
  - `{t:'ping'}` … アプリ層ハートビート
  - `{t:'kill'}` … セッション明示破棄（tmux セッションごと kill）
- **メッセージ（サーバー→クライアント）**
  - バイナリ … 端末出力
  - `{t:'pong'}` … ハートビート応答
  - `{t:'exit', code}` … プロセス/セッション終了（別デバイス接続でのデタッチ含む）
  - `{t:'err', m}` … 起動失敗等
- **キープアライブ（サーバー側）**: WebSocket プロトコル ping を **25秒**ごと送信。pong が **2回**連続で返らなければ（≈50秒）`terminate()` してゾンビ接続を回収（tmux は永続なので安全）。
- **tmux 設定**: `new-session -A -D`（既存があればアタッチ、他クライアントはデタッチ）、`window-size latest`（最後に操作した端末サイズに追従）、`mouse on`、`history-limit 10000`。起動 CWD は `~/workspace`（あれば）または `HOME`。`TERM=xterm-256color`, `LANG=C.UTF-8`。

---

## 6. EZterminal 仕様（`public/term.js`）

### 6.1 マルチタブ
- タブ構成の**正本はサーバー**。`/api/term/view` を **1.5秒間隔**でポーリング（`document.hidden` 時は休止、多重防止ロックあり）。
- `syncTerminals()` がローカルタブをサーバー一覧に同期（追加/タイトル更新/削除/並び替え。並びが変わった時だけ再配置し、アクティブ textarea の blur を避ける）。
- 閲覧中タブのみ localStorage `ez_active_sid` に保持。`＋`(`#btn-add-tab`) で `/api/term/add`、`×` で確認後 `/api/term/remove`。

### 6.2 タブの状態ドット（Claude状態）
`renderConfirm()` が `lib/termstate.js` の判定結果でドット色を更新。

| 状態 | クラス | 色 | 判定（tmux ペイン解析 `parsePane`） |
|---|---|---|---|
| idle | `st-idle` | 緑 `#57ab5a` | `? for shortcuts` を含む |
| running | `st-running` | 青 `#4c8dff` | `esc to interrupt` を含む |
| confirm | `st-confirm` | 赤 `#e5534b` | 番号メニュー（`1.` `2.`…＋カーソル `❯`＋疑問符） |
| unknown | `st-unknown` | 灰 `#8b93a7` | 上記以外 |

- **確認プルダウン**: confirm 状態のタブをタップすると `#tab-menu` を表示。質問文＋選択肢ボタン（`accept`=実行/緑, `accept_all`=すべて実行/青, `reject`=中止/赤）。クリックで `POST /api/term/send {sid,key}`。

### 6.3 入力欄と ON/OFF スイッチ
- スイッチ `.tw-switch`（キー行右端）。localStorage `ez_input_on`（`on`/`off`）。
- **ON**: `disableStdin=true`。`.tw-text`（2行 textarea）で編集し、`Ctrl/Cmd+Enter` で送信。直接入力はロック（IME安定）。
- **OFF**: `disableStdin=false`。入力欄と高さハンドルは非表示（`.term-wrap.input-off`）。`term.onData` が直接 tmux へ送出。
- 入力欄の高さは `--tw-input-h`（既定92px, 40px〜画面70%）を localStorage `ez_input_h` に保持。ドラッグハンドル `.tw-resize` で変更。

### 6.4 制御キー行（KEYROW）と Git ボタン
- キー: `⏎`(\r) `Tab`(\t) `⇧Tab`(\x1b[Z) `↑↓←→` `^C`(\x03) `^D`(\x04) `^End`(\x1b[1;5F) `Esc`(\x1b)。すべて `tabSendRaw` でプロンプトへ直接送出。
- **フォーカス制御**: PC は送出後に入力先へフォーカスを戻す。ただし `^C/^D/^End` は戻さない（カーソルが飛ぶため）。**スマホは一切フォーカスを戻さない**（ソフトキーボードが出ないように）。
- **Git ボタン**（Esc の右）: `G↓`= `git pull` / `G↑`= `git add -A && git commit -m "update $(date +%F_%T)" && git push`。いずれも **bracketed paste**（`\x1b[200~…\x1b[201~`）でコマンドを確定挿入し、独立した `\r` で実行。シェルでも Claude プロンプトでも動作。

### 6.5 音声入力（マイク 🎤 / Web Speech API）
- `setupMic()`。`webkitSpeechRecognition`、`lang='ja-JP'`, `interimResults=true`, `continuous=true`。非対応環境はボタン無効化（`.unsupported`）。開始前に `getUserMedia` で権限確認。録音中は `⏹`＋赤パルス（`.ib-btn.mic.rec`）。
- **配置**: スマホ=キー行の**入力切替スイッチのすぐ右**。PC=入力バー内。
- **入力先の分岐**:
  - **ON**: 認識結果（確定＋未確定）を入力欄 `.tw-text` に反映（送信は手動）。
  - **OFF**: 確定したセグメントをその都度 **ターミナルのカーソルへ** bracketed paste で流し込む（`streamToTerminal`）。onend で未確定の末尾を1回フラッシュ。Enter は送らない＝カーソル位置に文字が入るだけ。`onend` 依存をやめて逐次送出するため取りこぼしにくく、発話に応じて端末に文字が出る。
- エラーは種類別に日本語表示（`not-allowed`/`service-not-allowed`/`network`/`audio-capture`。`no-speech`/`aborted` は無視）。

### 6.6 ネットワーク耐性（機内Wi-Fi等の低速・高遅延・断続回線対策）
定数: `HB_MS=15000`, `DEAD_MS=50000`, `RECONNECT_BASE_MS=700`, `RECONNECT_MAX_MS=15000`, `API_TIMEOUT_MS=20000`, `SEND_QUEUE_MAX=5000`。

- **自動再接続**: 切断時に指数バックオフ＋ジッタ（0.7s→最大15s、`cap/2 + rand*cap/2`）で**無限リトライ**。`online`/`visibilitychange` では待ちを飛ばして即再接続（`kickReconnect`）。
- **ハートビート**: `{t:'ping'}` を15秒ごと送信。受信（端末データ含む）ごとに `lastRecv` 更新。**50秒**無通信ならゾンビ接続とみなし `ws.close()`→再接続。
- **送信キュー**: 入力は全て `tabSendRaw`→`enqueueInput`→キュー経由。未接続中は退避し、再接続の `onopen` でまとめて `flushQueue`（最大5000件、あふれは最古を破棄）。**打った内容を失わない**。
- **再接続ウォー回避**: `{t:'exit'}` を受けたら `gotExit=true` として**自動再接続しない**（別デバイスに切り替わった/セッション終了）。純粋な通信断（exit 無し）のみ自動再接続。→ 2台が互いを蹴り合う無限ループを防ぐ。
- **API タイムアウト**: `AbortSignal.timeout(20s)` でポーリング等の fetch が回線ハングで詰まらないようにする。
- ヘッダの接続ドット `#conn-state`（緑/赤）と `#btn-reconnect`（切断時のみ表示、押すとリロード）。

### 6.7 ファイルパス／URL のクリック
- 端末出力中のファイルパスを検出しクリックで **EZeditor** に開く（`provideFileLinks` + 正規表現 `FILE_LINK_RE`。全角混在行でも桁ズレしないようセル幅0を考慮）。相対パスは `/api/term/cwd` で解決、`~` は `/home/debian` に展開、末尾 `:line:col` は除去。→ `window.EZ.openFileInEditor(abs)`。
- URL は WebLinksAddon が担当し新規タブで開く。

### 6.8 入力送信・履歴・アップロード
- **送信**: `submitTab` は bracketed paste＋`\r`。履歴は localStorage `ez_input_history`（最大300件）。`⇧`/`⇩` ボタンで履歴移動（スマホはフォーカスを戻さない）。
- **添付/アップロード**: `📎` ボタン・貼り付け・ドラッグ&ドロップで `/api/upload` へ送信し、返ったパスを入力欄に挿入。アップロード中はボタンが `⏳`。

### 6.9 xterm.js・マウス・スクロール
- アドオン: FitAddon、ClipboardAddon（OSC 52。Claude 等のコピー/ペーストをシステムクリップボードへ）、WebLinksAddon。テーマは暗色（背景 `#14161c`、カーソル `#4c8dff`）。
- `mouseEventsRequireAlt=true`: 通常クリックは xterm 側でローカル処理（選択コピー・リンククリック）、アプリへマウス報告したい時は Alt＋操作。
- マウスアップで選択を即コピー（Claude 再描画で選択が消える前に取り込む）。ホイール/タッチドラッグは SGR マウス列（ボタン64/65）に変換して tmux 履歴スクロール（`TOUCH_STEP=24px`）。

### 6.10 スマホ最適化
- `visualViewport` に追従して `#term-app` の高さ/位置を補正（iOS のソフトキーボードでバーが潜り込むのを防ぐ `pinViewport`）。
- タブは全幅で別行（最大3段までスクロール、タブ幅130px）。端末フォント13px（PC15px）。プロンプト側ボタンはフォーカスを移さずキーボードを出さない。

---

## 7. EZbrowser 仕様（`public/ezbrowser.js`）

- `/home/debian` 配下のファイルブラウザ。`#ez-browser`。モードは `terminal→browser→editor→terminal` を `#mode-cycle` で循環（`body[data-mode]`）。
- **ナビゲーション**: パンくず `.ezb-crumbs`（先頭「🏠 debian」）。現在地は localStorage `ez_cwd`。
- **表示 3種**（localStorage `ez_view`）: 詳細（名前/サイズ/日時/権限）・リスト・アイコン（グリッド）。隠しファイル表示切替あり。
- **アイコン**: 📁ディレクトリ / 🔗シンボリックリンク / 🖼️画像 / 🗜️アーカイブ / 📄ファイル。
- **選択・操作**: PC=クリック/Ctrl+クリック/Shift+クリック/ダブルクリックで開く、右クリックでコンテキストメニュー。スマホ=タップでトグル/ダブルタップで開く/ロングタップ(500ms)でメニュー。
- **メニュー**: ファイル（新規フォルダ/新規テキスト/ダウンロード/アップロード）、編集（編集/削除）、表示（アイコン/リスト/詳細・隠しファイル）、ターミナル（この場所で CLI もしくは Claude ターミナルを新規作成）。
- **モーダル**: リネーム＋権限（3×3 の rwx グリッドで chmod）。トースト `.ezb-toast`（1.6秒）。
- **API**: 4.3 のファイル操作を使用。
- **EZeditor 連携**: `window.EZEditor.create(context)` で遅延生成。`window.EZ.openFileInEditor(path)` は端末のファイルリンクから呼ばれる。

---

## 8. EZeditor 仕様（`public/ezeditor.js`）

- スタンドアロン IIFE。`window.EZEditor = { create }` を公開。ホスト（ezbrowser）から context を受け取る。
- **2段ツールバー**: 上段＝開いているファイルタブ（`.eze-tabs`、`.active`/`.dirty`＝橙「●」）、下段＝File/Edit メニュー。
- **タブ状態**: `{id,path,name,content,dirty,lang,scrollTop,selStart,selEnd}`。タブ切替で scroll/選択位置を保存・復元。
- **シンタックスハイライト**: `.eze-hl`（`<pre>`）を透明な textarea の背後に重ね、スクロール/選択を同期。有効条件＝`window.EZHL` あり・ファイル≤400KB・言語認識可。
- **ファイル操作**: `open(entry)`/`openPath(path)`/`saveFile()`（`Ctrl/Cmd+S`）/`saveAs()`。保存は `POST /api/fs/write`、名前を付けて保存は `POST /api/fs/create`。
- **編集メニュー**: カット/コピー/ペースト（Clipboard API、非対応時は `execCommand` フォールバック）。
- **ダーティ管理**: 未保存でタブを閉じる時は `confirmClose`（保存/保存せず閉じる/キャンセル）。最後のタブを閉じると browser モードへ戻る。

---

## 9. シンタックスハイライタ（`public/ezhl.js`）

- API: `window.EZHL = { highlight(code, lang), langFor(filename) }`。
- 対応言語（拡張子→言語）: `js/mjs/cjs/jsx/ts/tsx→js`, `json→json`, `css→css`, `html/htm/xml/svg/vue→html`。
- トークン種別（One Dark 系配色）: `tok-kw`(紫) `tok-str`(緑) `tok-num`(橙) `tok-com`(灰斜体) `tok-fn`(青) `tok-tag`(赤) `tok-attr`(橙) `tok-prop`(シアン) `tok-punct`(淡)。
- 方式: sticky 正規表現（`y`フラグ）で先頭から優先順マッチ。HTML は `<script>` を JS、`<style>` を CSS として再帰ハイライト。

---

## 10. セッション状態判定（`lib/termstate.js`）

- **on-demand 方式**: `/api/term/view` のたびに各セッションの tmux ペインを `capture-pane` し `parsePane` で `confirm`/`running`/`idle`/`unknown` を判定。フックによる push（beat）は現状**使っていない**（→ 12章）。
- `getTitles()`: `pane_current_path` の末尾ディレクトリ名でタイトル自動命名（重複は連番）。`getCwd(sid)`、`createSession(sid,dir,kind)`（`kind:"claude"` は `claude` 投入）。
- `sendKey(sid,key)`: ホワイトリスト `KEY_MAP`（`1〜9` は `send-keys -l`、`escape/enter/up/down/interrupt(C-c)`）のみ。任意文字列注入は不可。
- 全 tmux 呼び出しは `txa()` でソケット `-L ezos<port>` を前置。

---

## 11. データファイル（`app/data/`、`0600`）

| ファイル | 内容 |
|---|---|
| `config.json` | `rpID`, `origin`, `port`, `setupKey`, `userName`, `hosts?` |
| `credentials.json` | 登録済みパスキー配列（`id, publicKey, counter, transports, label, createdAt`） |
| `auth_tokens.json` | 有効セッショントークン → 失効時刻(ms) のマップ |
| `terminals.json` | タブ登録（`{terminals:[{sid,title}], updatedAt}`。`sid` は `t`＋16進） |
| `conversations.json` | 旧チャット履歴（残存機能用。自動生成） |

- **`setup.js`**: 初回に `config.json` を生成。環境変数 `EZOS_RPID/EZOS_ORIGIN/EZOS_PORT/EZOS_USERNAME/EZOS_SETUP_KEY` を尊重。`--regen-setup-key` で setupKey のみ再発行。

---

## 12. レガシー / 未実装（README にあるが現状動いていないもの）

- **開発ハブ / セッション管制塔 / カンバン / 確認待ち受信箱**: `lib/hub.js`・`public/hub.js` は**存在しない**。UI 要素（`#hub-tabs` 等）も無し。README の記述は構想段階。
- **ハートビート（beat）パイプライン**: `bin/ez-hook.sh` は残るが、受け口の `POST /api/beat` は **server.js に未実装**。よって Claude フック → 状態 push は機能していない。現在の状態表示は 10章の on-demand ペイン解析に置き換わっている。
- **監査ログ（audit）**: `lib/audit.js`（配信）と `public/audit.js`（ビューア）は存在するが、サーバーに `/api/audit/*` エンドポイントが無く、ビューアは実在しない `#hub-tabs` を参照するため**未接続**。
- **チャットUI（`app.js`）**: 認証後アプリには読み込まれない（無認証ログイン画面専用）。`/api/chat` 等の API 自体は動作する（4.4）。

---

## 13. セキュリティ要点

- **パス安全化**（`filemgr.js`）: すべて `realpath` 展開後に `REAL_ROOT=/home/debian` 境界内を確認（シンボリックリンク・`..` を実体解決）。逸脱は 403、親不在は 404。ルートは削除不可。
- **CSRF**: POST に `X-Requested-With: ezos` 必須。**Origin**: WS/WebAuthn は `config.origin` 一致必須。
- **WebAuthn**: チャレンジ5分TTL、counter 増加検証（リプレイ対策）、ユーザー検証必須。
- **入力検証**: tmux セッション名（英数`-`最大20）、cols 20–500 / rows 5–200、mode `0o000–0o777`、JSON ボディ 1–4MB、アップロード 25MB、キー送信はホワイトリストのみ。
- **秘密情報**: `config.json`/`credentials.json`/`auth_tokens.json` は `0600`。トークンは base64url 32バイト、setupKey は 32桁 hex。

---

## 14. localStorage キー一覧

| キー | 値 | 用途 |
|---|---|---|
| `ez_active_sid` | sid | このブラウザで閲覧中のタブ |
| `ez_input_on` | `on`/`off` | 入力モード既定 |
| `ez_input_h` | px | 入力欄の高さ |
| `ez_input_history` | JSON配列 | 入力履歴（最大300） |
| `ez_cwd` | パス | EZbrowser の最後のディレクトリ |
| `ez_view` | `list`/`icon`/`detail` | EZbrowser 表示モード |
| （cookie）`ezview` | `mobile`/`desktop` | 表示モード上書き |

---

## 15. カラースキーム（CSS 変数）

```
--bg #14161c  --panel #1c1f28  --card #262a36  --card-hover #2d3240
--line #333846  --text #e6e9f0  --dim #8b93a7
--accent #4c8dff  --red #e5534b  --green #57ab5a
```

---

## 16. ビルドバージョンタグ（`console.info`）

- `term.js`: `…(mic-next-to-switch, prompt-btns-no-kbd, keyrow-no-kbd, mic-stream-to-terminal, resilient-net …)(2026-07-05i)`
- `ezbrowser.js`: `mode-cycle+explorer, rename, terminal-menu, editor-extracted(2026-07-05e)`
- `ezeditor.js`: `standalone editor, multi-tab(2段: tabs/menu), syntax-highlight(2026-07-05g)`
