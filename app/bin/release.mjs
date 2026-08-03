#!/usr/bin/env node
// EZOS リリース補助ツール。コミットのたびにパッチ版(1.0.x の x)を上げ、
// リリースノーツを app/public/releases.json の先頭に追記する。package.json も同期する。
//
// 使い方(各 --xx は繰り返し可。1回=1項目):
//   node app/bin/release.mjs --ja "変更点1" --ja "変更点2" --en "change 1" [--he "..."]
//   node app/bin/release.mjs --bump minor --ja "..." --en "..."   (patch 既定 / minor / major)
//
// 実行後の新バージョンを標準出力に出す。以後 git add -A && commit するだけ。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // .../app
const REL_PATH = path.join(APP_DIR, 'public', 'releases.json');
const PKG_PATH = path.join(APP_DIR, 'package.json');

const args = process.argv.slice(2);
const notes = { ja: [], en: [], he: [] };
let bump = 'patch';
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a === '--ja' || a === '--en' || a === '--he') {
    const v = args[i + 1]; i += 1;
    if (v == null) { console.error(`missing value for ${a}`); process.exit(1); }
    notes[a.slice(2)].push(v);
  } else if (a === '--bump') {
    bump = args[i + 1]; i += 1;
    if (!['patch', 'minor', 'major'].includes(bump)) { console.error(`--bump must be patch|minor|major`); process.exit(1); }
  } else {
    console.error(`unknown arg: ${a}`); process.exit(1);
  }
}

const data = JSON.parse(fs.readFileSync(REL_PATH, 'utf8'));
let [maj, min, pat] = String(data.current || '1.0.0').split('.').map((n) => parseInt(n, 10) || 0);
if (bump === 'major') { maj += 1; min = 0; pat = 0; }
else if (bump === 'minor') { min += 1; pat = 0; }
else { pat += 1; }
const version = `${maj}.${min}.${pat}`;

const d = new Date();
const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const noteObj = {};
for (const lg of ['ja', 'en', 'he']) if (notes[lg].length) noteObj[lg] = notes[lg];
if (!Object.keys(noteObj).length) {
  console.error('リリースノーツが空です(--ja / --en / --he を1つ以上指定してください)。');
  process.exit(1);
}

data.current = version;
data.releases.unshift({ version, date, notes: noteObj });
fs.writeFileSync(REL_PATH, JSON.stringify(data, null, 2) + '\n');

const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
pkg.version = version;
fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n');

console.log(version);
