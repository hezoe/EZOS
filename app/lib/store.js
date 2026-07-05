// JSONファイルベースの簡易ストレージ (シングルプロセス前提)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DATA_DIR = path.join(ROOT, 'data');
export const WORKSPACE_DIR = path.join(path.dirname(ROOT), 'workspace');

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

export function readJson(name, fallback) {
  const file = path.join(DATA_DIR, name);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(name, data) {
  const file = path.join(DATA_DIR, name);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function loadConfig() {
  const cfg = readJson('config.json', null);
  if (!cfg) {
    console.error('data/config.json がありません。先に `node setup.js` を実行してください。');
    process.exit(1);
  }
  return cfg;
}
