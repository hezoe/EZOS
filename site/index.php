<?php
declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

ez_session_start();

$cfg      = ez_config();
$authed   = !empty($_SESSION['auth']);
$view     = ez_view_mode();               // 'mobile' | 'desktop' (UA判定+クッキー)
$hasCreds = is_file(EZ_DATA_DIR . '/credentials.json')
            && (ez_read_json(EZ_DATA_DIR . '/credentials.json', []) !== []);
?><!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="theme-color" content="#14161c">
<title>EZ開発ハブ</title>
<link rel="stylesheet" href="assets/app.css">
</head>
<body class="view-<?= htmlspecialchars($view) ?> <?= $authed ? 'authed' : 'anon' ?>">

<?php if ($cfg === null): ?>
  <div class="login-wrap"><div class="login-box">
    <h1>EZ開発ハブ</h1>
    <p class="err">未セットアップです。サーバーで <code>php setup.php</code> を実行してください。</p>
  </div></div>

<?php elseif (!$authed): ?>
  <div class="login-wrap"><div class="login-box">
    <h1>🛠 EZ開発ハブ</h1>
    <p class="sub">並列AI開発ダッシュボード</p>

    <?php if ($hasCreds): ?>
      <button id="btn-login" class="btn primary big">🔑 パスキーでログイン</button>
      <p class="hint">1Passwordなどに保存したパスキーで認証します</p>
      <details class="setup-details">
        <summary>新しい端末のパスキーを追加登録する</summary>
        <input id="setup-key" type="password" placeholder="セットアップキー" autocomplete="off">
        <input id="reg-label" type="text" placeholder="端末名 (例: iPhone)" autocomplete="off">
        <button id="btn-register" class="btn">パスキーを登録</button>
      </details>
    <?php else: ?>
      <p class="sub">初期セットアップ: 最初のパスキーを登録してください</p>
      <input id="setup-key" type="password" placeholder="セットアップキー" autocomplete="off">
      <input id="reg-label" type="text" placeholder="端末名 (例: メインPC)" autocomplete="off">
      <button id="btn-register" class="btn primary big">🔐 パスキーを登録</button>
      <p class="hint">セットアップキーはサーバーの setup.php 実行時に表示されたものです</p>
    <?php endif; ?>
    <p id="login-msg" class="err" hidden></p>
  </div></div>

<?php else: ?>
  <header id="topbar">
    <span class="brand">🛠 EZ開発ハブ</span>
    <select id="project-filter" title="プロジェクトで絞り込み"><option value="">全プロジェクト</option></select>
    <span class="spacer"></span>
    <button id="btn-new-task" class="btn small primary">＋ タスク</button>
    <button id="btn-conninfo" class="btn small" title="セッション連携情報">📡</button>
    <a class="btn small" href="?view=<?= $view === 'mobile' ? 'desktop' : 'mobile' ?>"
       title="表示切替"><?= $view === 'mobile' ? '🖥' : '📱' ?></a>
    <button id="btn-logout" class="btn small" title="ログアウト">⏻</button>
  </header>

  <main id="layout">
    <section class="panel" id="panel-sessions" data-tab="sessions">
      <h2>🗼 セッション管制塔 <span id="sess-count" class="count"></span></h2>
      <div id="sessions-body" class="panel-body"></div>
    </section>

    <section class="panel" id="panel-kanban" data-tab="kanban">
      <h2>📋 カンバン</h2>
      <div id="kanban-body" class="panel-body kanban-cols"></div>
    </section>

    <section class="panel" id="panel-inbox" data-tab="inbox">
      <h2>📥 確認待ち受信箱 <span id="inbox-count" class="count"></span></h2>
      <div id="inbox-body" class="panel-body"></div>
    </section>
  </main>

  <nav id="tabbar">
    <button data-tab="sessions" class="active">🗼<span>管制塔</span><i id="tab-badge-sessions" hidden></i></button>
    <button data-tab="kanban">📋<span>カンバン</span></button>
    <button data-tab="inbox">📥<span>確認待ち</span><i id="tab-badge-inbox" hidden></i></button>
  </nav>

  <dialog id="task-dialog">
    <form method="dialog" id="task-form">
      <h3 id="task-dialog-title">タスク</h3>
      <input type="hidden" id="task-id">
      <label>タイトル<input id="task-title" required maxlength="200"></label>
      <label>プロジェクト<input id="task-project" list="project-list" maxlength="100"></label>
      <datalist id="project-list"></datalist>
      <label>説明 <small>「確認URL: https://…」と書くとリンクボタンになります</small>
        <textarea id="task-desc" rows="5"></textarea></label>
      <label>確認URL<input id="task-url" type="url" placeholder="https:// (説明文からも自動抽出)"></label>
      <div class="row">
        <label>状態<select id="task-status">
          <option value="todo">未着手</option><option value="doing">作業中</option>
          <option value="review">確認待ち</option><option value="done">完了</option>
        </select></label>
        <label>フラグ<select id="task-flag">
          <option value="none">なし</option><option value="discussion">💬 議論中</option>
          <option value="hold">✋ 保留</option>
        </select></label>
      </div>
      <div class="dialog-btns">
        <button type="button" class="btn danger" id="task-delete" hidden>削除</button>
        <span class="spacer"></span>
        <button type="button" class="btn" data-close>キャンセル</button>
        <button type="submit" class="btn primary">保存</button>
      </div>
    </form>
  </dialog>

  <dialog id="session-dialog">
    <form method="dialog" id="session-form">
      <h3>セッション設定</h3>
      <input type="hidden" id="sess-id">
      <label>名札<input id="sess-label" maxlength="50"></label>
      <label>色<div id="sess-colors" class="colors"></div></label>
      <div class="dialog-btns">
        <button type="button" class="btn danger" id="sess-delete">一覧から削除</button>
        <span class="spacer"></span>
        <button type="button" class="btn" data-close>キャンセル</button>
        <button type="submit" class="btn primary">保存</button>
      </div>
    </form>
  </dialog>

  <dialog id="conn-dialog">
    <div class="conn-body">
      <h3>📡 セッション連携 (ハートビート)</h3>
      <p>各AIセッションから下のエンドポイントに状態をPOSTすると管制塔に表示されます。</p>
      <pre id="conn-example">読み込み中…</pre>
      <p class="hint">state: <code>working</code>(作業中) / <code>running</code>(処理中) /
        <code>waiting_user</code>(あなた待ち) / <code>idle</code>(待機中) / <code>ended</code>(終了・一覧から消す)。
        5分間ビートが無い working / running は「🛑 止まった」扱いになります。</p>
      <div class="dialog-btns">
        <button type="button" class="btn" id="conn-copy">コピー</button>
        <span class="spacer"></span>
        <button type="button" class="btn primary" data-close>閉じる</button>
      </div>
    </div>
  </dialog>

  <div id="toast" hidden></div>
<?php endif; ?>

<script>
window.EZ = {
  authed: <?= $authed ? 'true' : 'false' ?>,
  view: <?= json_encode($view) ?>,
  hasCreds: <?= $hasCreds ? 'true' : 'false' ?>
};
</script>
<script src="assets/app.js"></script>
</body>
</html>
