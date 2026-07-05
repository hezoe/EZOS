// ターミナル(タブ)一覧のサーバー側レジストリ。
// 全ブラウザ・全デバイスで共有され、ブラウザを閉じても保持される「タブ構成」の正本。
// 各ターミナルの実体は tmux セッション ez_<sid> (状態は termstate.js が解決)。
import { randomBytes } from 'node:crypto';
import { readJson, writeJson } from './store.js';
import { listSids, killSession } from './termstate.js';

const FILE = 'terminals.json';

function load() {
  const r = readJson(FILE, null);
  if (r && Array.isArray(r.terminals)) return r;
  return { terminals: [] };
}

function save(reg) {
  reg.updatedAt = Date.now();
  writeJson(FILE, reg);
  return reg;
}

const newSid = () => 't' + randomBytes(5).toString('hex');

function nextTitle(reg) {
  return `ターミナル ${reg.terminals.length + 1}`;
}

/** レジストリ + 稼働中tmuxセッションを突き合わせた一覧を返す。空なら既定を1つ用意 */
export async function listTerminals() {
  const reg = load();
  const known = new Set(reg.terminals.map((t) => t.sid));
  let changed = false;

  // レジストリ外で稼働しているtmuxセッションも取り込む(他経路で作られた等)
  for (const sid of await listSids()) {
    if (!known.has(sid)) {
      reg.terminals.push({ sid, title: nextTitle(reg) });
      known.add(sid);
      changed = true;
    }
  }
  // 完全に空なら既定のターミナルを1つ用意 (常に1枚は存在させる)
  if (reg.terminals.length === 0) {
    reg.terminals.push({ sid: newSid(), title: 'ターミナル' });
    changed = true;
  }
  if (changed) save(reg);
  return reg.terminals.map((t) => ({ sid: t.sid, title: t.title }));
}

export function addTerminal(title) {
  const reg = load();
  const t = { sid: newSid(), title: String(title || '').slice(0, 50) || nextTitle(reg) };
  reg.terminals.push(t);
  save(reg);
  return t;
}

export async function removeTerminal(sid) {
  const reg = load();
  reg.terminals = reg.terminals.filter((t) => t.sid !== sid);
  save(reg);
  await killSession(sid); // tmuxセッションごと破棄 → 全ブラウザから消える
}
