// 初期セットアップ: data/config.json を生成してセットアップキーを表示する
// 再実行しても既存設定は上書きしない。--regen-setup-key でキーのみ再生成。
//
// 新規インストール時は環境変数で値を渡せる(未指定なら既定値=この本番機の設定):
//   EZOS_RPID       WebAuthn の rpID(親ドメイン)          既定: ezoe.net
//   EZOS_ORIGIN     公開オリジン(https://<host>)           既定: https://ezos.ezoe.net
//   EZOS_PORT       localhost 待受ポート                    既定: 3100
//   EZOS_USERNAME   パスキーの表示ユーザー名                 既定: hiroshi
//   EZOS_SETUP_KEY  セットアップキーを指定(通常は自動生成)
// 例) EZOS_ORIGIN=https://ezos.ezoe.net EZOS_PORT=3101 node setup.js
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
    rpID: process.env.EZOS_RPID || 'ezoe.net',
    origin: process.env.EZOS_ORIGIN || 'https://ezos.ezoe.net',
    port: Number(process.env.EZOS_PORT) || 3100,
    setupKey: process.env.EZOS_SETUP_KEY || randomBytes(16).toString('hex'),
    userName: process.env.EZOS_USERNAME || 'hiroshi',
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
console.log('パスキーの登録(初回/新デバイス追加)は、セキュリティのため常時は受け付けません。');
console.log('登録するときだけサーバー上で次を実行し、表示されるワンタイムキーで登録してください:');
console.log('  node bin/open-register.js        (15分だけ登録を解錠)');
console.log('※ ログイン済みの端末からは、解錠なしでそのまま新パスキーを追加できます。');
console.log('----------------------------------------');
