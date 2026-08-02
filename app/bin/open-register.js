// パスキー登録の一時解錠ツール (break-glass)。SSHでサーバーに入れる人だけが実行できる。
//
// 通常、未認証からの新規パスキー登録はサーバー側で常時拒否される(ネット公開の穴を塞ぐため)。
// 全デバイスを失って締め出された等の場合に、このスクリプトで「登録ウィンドウ」を時限・使い捨てで
// 開き、新しいデバイスのブラウザからパスキーを登録できるようにする。
//
//   node bin/open-register.js [有効分数]   (既定15分・1〜120で指定可)
//
// 実行するとワンタイム登録キーを新規生成し data/reg-window.json に書き出す(稼働中サーバーは
// 都度これを読むので再起動不要)。ブラウザで登録が1件成功すると自動で消費・失効する。
// 期限切れでも無効化される。既に開いている場合は上書き(新しいキー・期限で再発行)。
import { randomBytes } from 'node:crypto';
import { writeJson, loadConfig, removeJson } from '../lib/store.js';

const arg = process.argv[2];
if (arg === '--close') {
  removeJson('reg-window.json');
  console.log('登録ウィンドウを閉じました(未認証からの登録を再び全面拒否)。');
  process.exit(0);
}

const minutes = Math.min(120, Math.max(1, Math.floor(Number(arg) || 15)));
const cfg = loadConfig();
const key = randomBytes(16).toString('hex');
const expires = Date.now() + minutes * 60 * 1000;
writeJson('reg-window.json', { key, expires, openedAt: Date.now() });

console.log('----------------------------------------');
console.log('パスキー登録を一時的に解錠しました。');
console.log(`  登録キー : ${key}`);
console.log(`  有効期限 : ${minutes} 分後まで (${new Date(expires).toISOString()})`);
console.log(`  登録URL  : ${cfg.origin}`);
console.log('----------------------------------------');
console.log('新しいデバイスのブラウザで上記URLを開き、ログイン画面の');
console.log('「新しい端末のパスキーを追加登録する」から上の登録キーを入力してください。');
console.log('登録が1件成功すると自動で無効化されます(期限切れでも無効)。');
console.log('今すぐ閉じるには: node bin/open-register.js --close');
