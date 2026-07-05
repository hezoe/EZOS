<?php
declare(strict_types=1);

/**
 * EZ開発ハブ 共通ブートストラップ
 * さくら共有サーバー (PHP 8.3) / データはJSONファイル保存
 */

const EZ_DATA_DIR = __DIR__ . '/data';

date_default_timezone_set('Asia/Tokyo');

// サーバーの ~/www/php.ini が mbstring.internal_encoding=EUC-JP (旧サイト用) のため明示的に上書きする
mb_internal_encoding('UTF-8');
mb_regex_encoding('UTF-8');

spl_autoload_register(function ($class) {
    if (str_starts_with($class, 'lbuchs\\WebAuthn\\')) {
        $path = __DIR__ . '/lib/WebAuthn/' . str_replace('\\', '/', substr($class, strlen('lbuchs\\WebAuthn\\'))) . '.php';
        if (is_file($path)) {
            require $path;
        }
    }
});

function ez_session_start(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }
    session_name('EZHUBSESS');
    session_set_cookie_params([
        'lifetime' => 60 * 60 * 24 * 30,
        'path'     => dirname($_SERVER['SCRIPT_NAME'] ?? '/') ?: '/',
        'secure'   => true,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
    session_start();
}

function ez_config(): ?array
{
    static $cfg = false;
    if ($cfg === false) {
        $cfg = ez_read_json(EZ_DATA_DIR . '/config.json', null);
    }
    return $cfg;
}

function ez_read_json(string $file, mixed $default): mixed
{
    if (!is_file($file)) {
        return $default;
    }
    $fp = @fopen($file, 'rb');
    if (!$fp) {
        return $default;
    }
    flock($fp, LOCK_SH);
    $raw = stream_get_contents($fp);
    flock($fp, LOCK_UN);
    fclose($fp);
    $v = json_decode((string)$raw, true);
    return $v === null && trim((string)$raw) !== 'null' ? $default : $v;
}

/**
 * 排他ロック付き read-modify-write。$fn(mixed $data): mixed が返した値を書き戻す。
 */
function ez_update_json(string $file, mixed $default, callable $fn): mixed
{
    $fp = fopen($file, 'c+b');
    if (!$fp) {
        throw new RuntimeException("cannot open $file");
    }
    flock($fp, LOCK_EX);
    $raw = stream_get_contents($fp);
    $data = json_decode((string)$raw, true);
    if ($data === null && trim((string)$raw) !== 'null') {
        $data = $default;
    }
    $data = $fn($data);
    $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
    if ($json === false) {
        flock($fp, LOCK_UN);
        fclose($fp);
        throw new RuntimeException('json_encode failed: ' . json_last_error_msg());
    }
    rewind($fp);
    ftruncate($fp, 0);
    fwrite($fp, $json);
    fflush($fp);
    flock($fp, LOCK_UN);
    fclose($fp);
    @chmod($file, 0600);
    return $data;
}

function ez_is_mobile_ua(string $ua): bool
{
    return (bool)preg_match('/iPhone|iPod|Windows Phone|webOS|BlackBerry|Android.+Mobile/i', $ua);
}

function ez_is_tablet_ua(string $ua): bool
{
    if (preg_match('/iPad/i', $ua)) {
        return true;
    }
    // iPadOS 13+ は Macintosh を名乗るがタッチ対応
    if (preg_match('/Macintosh/i', $ua) && preg_match('/Mobile/i', $ua)) {
        return true;
    }
    return (bool)(preg_match('/Android/i', $ua) && !preg_match('/Mobile/i', $ua));
}

/**
 * UAとクッキー/クエリから表示モードを決める。'mobile' | 'desktop'
 * ?view=mobile|desktop|auto で強制切替し、クッキーに記憶する。
 */
function ez_view_mode(): string
{
    $ua = $_SERVER['HTTP_USER_AGENT'] ?? '';
    $auto = ez_is_mobile_ua($ua) ? 'mobile' : 'desktop';

    $req = $_GET['view'] ?? null;
    if ($req === 'mobile' || $req === 'desktop') {
        setcookie('ez_view', $req, ['expires' => time() + 86400 * 365, 'path' => '/', 'secure' => true, 'samesite' => 'Lax']);
        return $req;
    }
    if ($req === 'auto') {
        setcookie('ez_view', '', ['expires' => 1, 'path' => '/', 'secure' => true, 'samesite' => 'Lax']);
        return $auto;
    }
    $ck = $_COOKIE['ez_view'] ?? '';
    if ($ck === 'mobile' || $ck === 'desktop') {
        return $ck;
    }
    return $auto;
}
