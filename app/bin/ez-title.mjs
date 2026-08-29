#!/usr/bin/env node
/* EZOS: ターミナルタブ用「現在の作業ラベル」を毎ターン生成するサイドチャネル。
   UserPromptSubmit フックから ez-title.sh 経由で非同期起動される(stdin=フックイベントJSON)。
   Claude Code の pane_title は初回タスクのテキストで固着し外部上書きも即奪還されるため、
   ここでは pane_title を触らず、別ファイルに「今の作業」を書く → getTitles() が最優先で表示。
   要約は `claude -p`(OAuth利用) + haiku。呼び出し時に EZOS_HOOK_SILENT=1 を立て、
   各フック先頭のガードで再帰(要約claudeが再び本フックを起動)と他フック汚染を防ぐ。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'data', 'titles');

function readStdin() { try { return fs.readFileSync(0, 'utf8'); } catch { return ''; } }

// 自分の属する tmux セッション名(ez_<sid>)。フックは pane 内で動くので取得できる。
function tmuxSession() {
  try {
    const pane = process.env.TMUX_PANE;
    const a = pane ? ['display-message', '-p', '-t', pane, '#{session_name}'] : ['display-message', '-p', '#{session_name}'];
    return execFileSync('tmux', a, { encoding: 'utf8' }).trim();
  } catch { return ''; }
}

// transcript(JSONL)末尾から直近の user/assistant の本文を数件、要約の文脈として拾う。
function recentContext(transcriptPath) {
  try {
    const lines = fs.readFileSync(transcriptPath, 'utf8').trimEnd().split('\n');
    const msgs = [];
    for (const line of lines.slice(-120)) {
      let d; try { d = JSON.parse(line); } catch { continue; }
      if (d.type !== 'user' && d.type !== 'assistant') continue;
      const m = d.message; if (!m || typeof m !== 'object') continue;
      const c = m.content; let txt = '';
      if (typeof c === 'string') txt = c;
      else if (Array.isArray(c)) for (const b of c) if (b && b.type === 'text') txt += b.text || '';
      txt = txt.replace(/\s+/g, ' ').trim();
      if (txt) msgs.push(`${m.role === 'user' ? 'ユーザ' : 'アシスタント'}: ${txt.slice(0, 400)}`);
    }
    return msgs.slice(-6).join('\n');
  } catch { return ''; }
}

function main() {
  let ev = {}; try { ev = JSON.parse(readStdin() || '{}'); } catch { /* noop */ }
  const session = tmuxSession();
  if (!session.startsWith('ez_')) return;                 // EZOS のターミナルのみ対象
  const prompt = String(ev.prompt || '').replace(/\s+/g, ' ').trim();
  const ctx = recentContext(ev.transcript_path || '');
  const material = [ctx, prompt ? `ユーザ(最新): ${prompt.slice(0, 400)}` : ''].filter(Boolean).join('\n');
  if (!material) return;

  const instruction =
    '次はターミナルで進行中の開発作業の会話ログです。' +
    '今まさに取り組んでいる作業を、日本語で最大18文字・体言止め・記号や引用符なしの短いタブ見出しにしてください。' +
    '説明や前置きは一切書かず、見出しの一行だけを出力すること。\n\n---\n' + material;

  let label = '';
  try {
    label = execFileSync('claude', ['-p', '--model', 'haiku'], {
      input: instruction, encoding: 'utf8', timeout: 25000,
      cwd: os.tmpdir(),                                   // workspace の CLAUDE.md/メモリを読ませない(軽量化)
      env: { ...process.env, EZOS_HOOK_SILENT: '1' },     // 要約claudeのフックを全て無効化(再帰防止)
    }).trim();
  } catch { return; }                                     // 失敗時は更新しない(既存表示を維持)

  // 最初の非空行のみ・markdown強調/引用符/括弧を除去・長さ制限
  label = (label.split('\n').map((s) => s.trim()).find(Boolean) || '')
    .replace(/[*_`"'「」『』]/g, '').trim().slice(0, 40);
  if (!label) return;

  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, `${session}.json`), JSON.stringify({ label, ts: Date.now() }));
  } catch { /* noop */ }
}
main();
