<?php
declare(strict_types=1);

/**
 * 初期セットアップ (CLI専用): 秘密情報を生成して data/config.json を作る
 *   ssh ezoe.net 'cd www/ezoe/EZOS && php setup.php'
 * 再実行しても既存の設定は上書きしない。--regen-setup-key でセットアップキーだけ再生成。
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('CLI only');
}

require __DIR__ . '/bootstrap.php';

if (!is_dir(EZ_DATA_DIR)) {
    mkdir(EZ_DATA_DIR, 0700, true);
}
@chmod(EZ_DATA_DIR, 0700);

$file = EZ_DATA_DIR . '/config.json';
$cfg = ez_read_json($file, null);

$regen = in_array('--regen-setup-key', $argv, true);

if ($cfg === null) {
    $cfg = [
        'rp_id'     => 'ezoe.net',
        'user_id'   => bin2hex(random_bytes(16)),
        'user_name' => 'hiroshi',
        'setup_key' => bin2hex(random_bytes(16)),
        'api_token' => bin2hex(random_bytes(24)),
    ];
    file_put_contents($file, json_encode($cfg, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
    chmod($file, 0600);
    echo "config.json を作成しました。\n";
} elseif ($regen) {
    $cfg['setup_key'] = bin2hex(random_bytes(16));
    file_put_contents($file, json_encode($cfg, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
    chmod($file, 0600);
    echo "setup_key を再生成しました。\n";
} else {
    echo "config.json は既に存在します(変更なし)。\n";
}

echo "----------------------------------------\n";
echo "セットアップキー (パスキー登録に必要): {$cfg['setup_key']}\n";
echo "APIトークン (ハートビート送信に必要): {$cfg['api_token']}\n";
echo "----------------------------------------\n";
