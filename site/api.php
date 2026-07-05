<?php
declare(strict_types=1);

/**
 * EZ開発ハブ API
 *  - 認証: WebAuthn (パスキー / 1Password対応)
 *  - タスク: カンバン用CRUD (JSONファイル保存)
 *  - セッション: 並列AIセッションのハートビート受付と一覧
 */

require __DIR__ . '/bootstrap.php';

use lbuchs\WebAuthn\WebAuthn;

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

const TASK_STATUSES = ['todo', 'doing', 'review', 'done'];
const TASK_FLAGS    = ['none', 'discussion', 'hold'];
const BEAT_STATES   = ['working', 'running', 'waiting_user', 'idle', 'ended'];

// 作業中/処理中のままこの秒数ビートが無ければ「止まった」扱い
const STALL_SEC   = 300;
// この秒数ビートが無いセッションは一覧から消す
const EXPIRE_SEC  = 86400;

function out(array $data, int $code = 200): never
{
    http_response_code($code);
    echo json_encode(['ok' => $code < 400] + $data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function fail(string $msg, int $code = 400): never
{
    out(['error' => $msg], $code);
}

function body(): array
{
    $raw = file_get_contents('php://input');
    $v = json_decode((string)$raw, true);
    return is_array($v) ? $v : [];
}

function webauthn(array $cfg): WebAuthn
{
    // 'none' アテステーションのみ許可(1Password等のパスキーはこれで十分)
    return new WebAuthn('EZ開発ハブ', $cfg['rp_id'], ['none'], true);
}

$cfg = ez_config();
if ($cfg === null) {
    fail('未セットアップです。サーバーで setup.php を実行してください。', 500);
}

$action = $_GET['action'] ?? '';
$method = $_SERVER['REQUEST_METHOD'];

/* ---------- ハートビート (APIトークン認証・セッション不要) ---------- */

if ($action === 'beat') {
    if ($method !== 'POST') {
        fail('POST only', 405);
    }
    $token = $_SERVER['HTTP_X_API_TOKEN'] ?? ($_GET['token'] ?? '');
    if (!hash_equals($cfg['api_token'], (string)$token)) {
        fail('invalid token', 403);
    }
    $b = body();
    $id = trim((string)($b['id'] ?? ''));
    $state = (string)($b['state'] ?? '');
    if ($id === '' || mb_strlen($id) > 100) {
        fail('id required');
    }
    if (!in_array($state, BEAT_STATES, true)) {
        fail('state must be one of: ' . implode(', ', BEAT_STATES));
    }
    $now = time();
    ez_update_json(EZ_DATA_DIR . '/sessions.json', [], function ($all) use ($id, $state, $b, $now) {
        if (!is_array($all)) {
            $all = [];
        }
        if ($state === 'ended') {
            unset($all[$id]);
            return $all;
        }
        $s = $all[$id] ?? [
            'id' => $id, 'label' => '', 'color' => '',
            'firstSeen' => $now, 'waitingSince' => null,
        ];
        $prevState = $s['state'] ?? '';
        $s['state']    = $state;
        $s['lastBeat'] = $now;
        if ($state === 'waiting_user') {
            if ($prevState !== 'waiting_user' || empty($s['waitingSince'])) {
                $s['waitingSince'] = $now;
            }
        } else {
            $s['waitingSince'] = null;
        }
        // 名札はビートで上書きしない(初回のみ採用)。他の属性は毎回更新可
        if ($s['label'] === '' && !empty($b['label'])) {
            $s['label'] = mb_substr(trim((string)$b['label']), 0, 50);
        }
        foreach (['project', 'task', 'task_url', 'detail'] as $k) {
            if (array_key_exists($k, $b)) {
                $s[$k] = mb_substr(trim((string)$b[$k]), 0, 300);
            }
        }
        $all[$id] = $s;
        return $all;
    });
    out(['state' => $state]);
}

/* ---------- WebAuthn 認証 ---------- */

ez_session_start();

$authed = !empty($_SESSION['auth']);

// POST(状態変更系)はCSRF対策として独自ヘッダーを必須にする
if ($method === 'POST' && ($_SERVER['HTTP_X_REQUESTED_WITH'] ?? '') !== 'ezhub') {
    fail('bad request', 400);
}

switch ($action) {

case 'me':
    out(['authed' => $authed]);

case 'reg_challenge': {
    if ($method !== 'POST') {
        fail('POST only', 405);
    }
    $b = body();
    // 登録できるのは「ログイン済み」か「セットアップキー一致」のときだけ
    if (!$authed) {
        $key = (string)($b['setup_key'] ?? '');
        if (!hash_equals($cfg['setup_key'], $key)) {
            sleep(2);
            fail('セットアップキーが違います', 403);
        }
    }
    $wa = webauthn($cfg);
    $creds = ez_read_json(EZ_DATA_DIR . '/credentials.json', []);
    $exclude = array_map(fn($c) => base64_decode($c['id']), $creds);
    $args = $wa->getCreateArgs(
        hex2bin($cfg['user_id']),
        $cfg['user_name'],
        $cfg['user_name'],
        120,
        true,          // residentKey: パスキーとして保存させる
        'required',    // userVerification
        null,
        $exclude
    );
    $_SESSION['challenge'] = base64_encode($wa->getChallenge()->getBinaryString());
    $_SESSION['reg_ok'] = true;
    out(['args' => $args]);
}

case 'reg_finish': {
    if ($method !== 'POST') {
        fail('POST only', 405);
    }
    if (empty($_SESSION['reg_ok']) || empty($_SESSION['challenge'])) {
        fail('challenge missing', 400);
    }
    $b = body();
    try {
        $wa = webauthn($cfg);
        $data = $wa->processCreate(
            base64_decode((string)$b['clientDataJSON']),
            base64_decode((string)$b['attestationObject']),
            base64_decode((string)$_SESSION['challenge']),
            true,  // requireUserVerification
            true
        );
    } catch (Throwable $e) {
        fail('登録に失敗しました: ' . $e->getMessage(), 400);
    }
    unset($_SESSION['challenge'], $_SESSION['reg_ok']);
    $label = mb_substr(trim((string)($b['label'] ?? '')), 0, 60);
    ez_update_json(EZ_DATA_DIR . '/credentials.json', [], function ($creds) use ($data, $label) {
        if (!is_array($creds)) {
            $creds = [];
        }
        $creds[] = [
            'id'        => base64_encode($data->credentialId),
            'publicKey' => $data->credentialPublicKey,
            'signCount' => $data->signatureCounter ?? 0,
            'label'     => $label !== '' ? $label : 'passkey-' . date('Ymd-Hi'),
            'createdAt' => time(),
        ];
        return $creds;
    });
    // 登録できたらそのままログイン状態にする
    session_regenerate_id(true);
    $_SESSION['auth'] = true;
    out(['registered' => true]);
}

case 'login_challenge': {
    $creds = ez_read_json(EZ_DATA_DIR . '/credentials.json', []);
    if (!$creds) {
        fail('パスキーが未登録です。初期セットアップを行ってください。', 404);
    }
    $wa = webauthn($cfg);
    $ids = array_map(fn($c) => base64_decode($c['id']), $creds);
    $args = $wa->getGetArgs($ids, 120, true, true, true, true, true, 'required');
    $_SESSION['challenge'] = base64_encode($wa->getChallenge()->getBinaryString());
    out(['args' => $args]);
}

case 'login_finish': {
    if ($method !== 'POST') {
        fail('POST only', 405);
    }
    if (empty($_SESSION['challenge'])) {
        fail('challenge missing', 400);
    }
    $b = body();
    $credIdB64u = (string)($b['id'] ?? '');
    $credIdBin = base64_decode(strtr($credIdB64u, '-_', '+/'));
    $creds = ez_read_json(EZ_DATA_DIR . '/credentials.json', []);
    $found = null;
    foreach ($creds as $i => $c) {
        if (hash_equals(base64_decode($c['id']), $credIdBin)) {
            $found = $i;
            break;
        }
    }
    if ($found === null) {
        fail('未知のパスキーです', 403);
    }
    try {
        $wa = webauthn($cfg);
        $wa->processGet(
            base64_decode((string)$b['clientDataJSON']),
            base64_decode((string)$b['authenticatorData']),
            base64_decode((string)$b['signature']),
            $creds[$found]['publicKey'],
            base64_decode((string)$_SESSION['challenge']),
            null,   // signCount照合は同期パスキー(1Password)では常に0のため省略
            true    // requireUserVerification
        );
    } catch (Throwable $e) {
        fail('ログインに失敗しました: ' . $e->getMessage(), 403);
    }
    unset($_SESSION['challenge']);
    session_regenerate_id(true);
    $_SESSION['auth'] = true;
    out(['authed' => true]);
}

case 'logout':
    $_SESSION = [];
    session_destroy();
    out(['authed' => false]);
}

/* ---------- ここから下はログイン必須 ---------- */

if (!$authed) {
    fail('ログインが必要です', 401);
}

switch ($action) {

case 'state': {
    // タスク+セッションをまとめて返す(ポーリング用)
    $tasks = ez_read_json(EZ_DATA_DIR . '/tasks.json', ['seq' => 0, 'tasks' => []]);
    $sessions = ez_read_json(EZ_DATA_DIR . '/sessions.json', []);
    $now = time();
    $list = [];
    foreach ($sessions as $s) {
        if ($now - ($s['lastBeat'] ?? 0) > EXPIRE_SEC) {
            continue;
        }
        $state = $s['state'];
        if (in_array($state, ['working', 'running'], true) && $now - $s['lastBeat'] > STALL_SEC) {
            $state = 'stopped';
        }
        $s['effectiveState'] = $state;
        $list[] = $s;
    }
    out(['tasks' => $tasks['tasks'], 'sessions' => $list, 'now' => $now]);
}

case 'task_save': {
    if ($method !== 'POST') {
        fail('POST only', 405);
    }
    $b = body();
    $title = mb_substr(trim((string)($b['title'] ?? '')), 0, 200);
    if ($title === '') {
        fail('タイトルは必須です');
    }
    $status = (string)($b['status'] ?? 'todo');
    if (!in_array($status, TASK_STATUSES, true)) {
        fail('invalid status');
    }
    $flag = (string)($b['flag'] ?? 'none');
    if (!in_array($flag, TASK_FLAGS, true)) {
        fail('invalid flag');
    }
    $desc    = mb_substr((string)($b['desc'] ?? ''), 0, 5000);
    $project = mb_substr(trim((string)($b['project'] ?? '')), 0, 100);
    $url     = trim((string)($b['url'] ?? ''));
    // 説明文の「確認URL: https://...」を拾ってリンクにする
    if ($url === '' && preg_match('/確認\s*URL\s*[:：]\s*(https?:\/\/\S+)/iu', $desc, $m)) {
        $url = $m[1];
    }
    if ($url !== '' && !preg_match('#^https?://#i', $url)) {
        fail('URLはhttp(s)で指定してください');
    }
    $id = (int)($b['id'] ?? 0);
    $now = time();
    $saved = null;
    ez_update_json(EZ_DATA_DIR . '/tasks.json', ['seq' => 0, 'tasks' => []], function ($d) use (&$saved, $id, $title, $desc, $project, $status, $flag, $url, $now) {
        if (!is_array($d) || !isset($d['tasks'])) {
            $d = ['seq' => 0, 'tasks' => []];
        }
        if ($id > 0) {
            foreach ($d['tasks'] as &$t) {
                if ($t['id'] === $id) {
                    $t = ['id' => $id, 'title' => $title, 'desc' => $desc, 'project' => $project,
                          'status' => $status, 'flag' => $flag, 'url' => $url,
                          'createdAt' => $t['createdAt'], 'updatedAt' => $now];
                    $saved = $t;
                    break;
                }
            }
            unset($t);
        } else {
            $d['seq']++;
            $saved = ['id' => $d['seq'], 'title' => $title, 'desc' => $desc, 'project' => $project,
                      'status' => $status, 'flag' => $flag, 'url' => $url,
                      'createdAt' => $now, 'updatedAt' => $now];
            $d['tasks'][] = $saved;
        }
        return $d;
    });
    if ($saved === null) {
        fail('タスクが見つかりません', 404);
    }
    out(['task' => $saved]);
}

case 'task_status': {
    if ($method !== 'POST') {
        fail('POST only', 405);
    }
    $b = body();
    $id = (int)($b['id'] ?? 0);
    $status = (string)($b['status'] ?? '');
    if (!in_array($status, TASK_STATUSES, true)) {
        fail('invalid status');
    }
    $saved = null;
    ez_update_json(EZ_DATA_DIR . '/tasks.json', ['seq' => 0, 'tasks' => []], function ($d) use (&$saved, $id, $status) {
        foreach ($d['tasks'] ?? [] as &$t) {
            if ($t['id'] === $id) {
                $t['status'] = $status;
                $t['updatedAt'] = time();
                $saved = $t;
                break;
            }
        }
        unset($t);
        return $d;
    });
    if ($saved === null) {
        fail('タスクが見つかりません', 404);
    }
    out(['task' => $saved]);
}

case 'task_delete': {
    if ($method !== 'POST') {
        fail('POST only', 405);
    }
    $id = (int)(body()['id'] ?? 0);
    ez_update_json(EZ_DATA_DIR . '/tasks.json', ['seq' => 0, 'tasks' => []], function ($d) use ($id) {
        $d['tasks'] = array_values(array_filter($d['tasks'] ?? [], fn($t) => $t['id'] !== $id));
        return $d;
    });
    out(['deleted' => $id]);
}

case 'session_update': {
    if ($method !== 'POST') {
        fail('POST only', 405);
    }
    $b = body();
    $id = (string)($b['id'] ?? '');
    $updated = false;
    ez_update_json(EZ_DATA_DIR . '/sessions.json', [], function ($all) use (&$updated, $id, $b) {
        if (isset($all[$id])) {
            if (array_key_exists('label', $b)) {
                $all[$id]['label'] = mb_substr(trim((string)$b['label']), 0, 50);
            }
            if (array_key_exists('color', $b)) {
                $c = (string)$b['color'];
                $all[$id]['color'] = preg_match('/^#[0-9a-fA-F]{6}$/', $c) ? $c : '';
            }
            $updated = true;
        }
        return $all;
    });
    $updated ? out(['updated' => true]) : fail('セッションが見つかりません', 404);
}

case 'session_delete': {
    if ($method !== 'POST') {
        fail('POST only', 405);
    }
    $id = (string)(body()['id'] ?? '');
    ez_update_json(EZ_DATA_DIR . '/sessions.json', [], function ($all) use ($id) {
        unset($all[$id]);
        return $all;
    });
    out(['deleted' => $id]);
}

case 'conninfo': {
    // ハートビート連携用の情報(ログイン済みの人にだけ見せる)
    $scheme = 'https';
    $host = $_SERVER['HTTP_HOST'] ?? 'www.ezoe.net';
    $base = $scheme . '://' . $host . dirname($_SERVER['SCRIPT_NAME']);
    out([
        'endpoint' => rtrim($base, '/') . '/api.php?action=beat',
        'token'    => $cfg['api_token'],
        'states'   => BEAT_STATES,
    ]);
}

case 'passkeys': {
    $creds = ez_read_json(EZ_DATA_DIR . '/credentials.json', []);
    out(['passkeys' => array_map(fn($c) => [
        'label' => $c['label'], 'createdAt' => $c['createdAt'],
    ], $creds)]);
}

default:
    fail('unknown action', 404);
}
