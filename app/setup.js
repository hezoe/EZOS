// 初期セットアップ: data/config.json を生成してセットアップキーを表示する
// 再実行しても既存設定は上書きしない。--regen-setup-key でキーのみ再生成。
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, 'data');
const FILE = path.join(DATA, 'config.json');

fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });

let cfg = null;
if (fs.existsSync(FILE)) {
  cfg = JSON.parse(fs.readFileSync(FILE, 'utf8'));
}

if (!cfg) {
  cfg = {
    rpID: 'ezoe.net',
    origin: 'https://ezeditor.ezoe.net',
    port: 3100,
    setupKey: randomBytes(16).toString('hex'),
    userName: 'hiroshi',
  };
  fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  console.log('config.json を作成しました。');
} else if (process.argv.includes('--regen-setup-key')) {
  cfg.setupKey = randomBytes(16).toString('hex');
  fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  console.log('setup_key を再生成しました。');
} else {
  console.log('config.json は既に存在します(変更なし)。');
}

console.log('----------------------------------------');
console.log(`セットアップキー (パスキー登録に必要): ${cfg.setupKey}`);
console.log('----------------------------------------');
