// Claude Code CLI をヘッドレス実行して stream-json をイベントとして流す
import { spawn } from 'node:child_process';
import { WORKSPACE_DIR } from './store.js';

/**
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {string|null} opts.resumeSessionId  Claude Code のセッションID (継続時)
 * @param {boolean} opts.allowTools           true なら bypassPermissions で実行
 * @param {(ev: {type: string, [k: string]: any}) => void} opts.onEvent
 * @returns {{ kill: () => void, done: Promise<void> }}
 */
export function runClaude({ prompt, resumeSessionId, allowTools, onEvent }) {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
  ];
  if (resumeSessionId) {
    args.push('--resume', resumeSessionId);
  }
  args.push('--permission-mode', allowTools ? 'bypassPermissions' : 'default');

  const child = spawn('claude', args, {
    cwd: WORKSPACE_DIR,
    env: { ...process.env, HOME: process.env.HOME || '/home/debian' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  child.stdin.write(prompt);
  child.stdin.end();

  let buf = '';
  let stderrBuf = '';
  let gotResult = false;

  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      handleEvent(ev);
    }
  });

  child.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString('utf8');
    if (stderrBuf.length > 8000) stderrBuf = stderrBuf.slice(-8000);
  });

  function handleEvent(ev) {
    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init') {
          onEvent({ type: 'init', sessionId: ev.session_id, model: ev.model });
        }
        break;
      case 'stream_event': {
        const e = ev.event;
        if (e?.type === 'content_block_delta') {
          if (e.delta?.type === 'text_delta' && e.delta.text) {
            onEvent({ type: 'delta', text: e.delta.text });
          } else if (e.delta?.type === 'thinking_delta' && e.delta.thinking) {
            onEvent({ type: 'thinking', text: e.delta.thinking });
          }
        } else if (e?.type === 'content_block_start' && e.content_block?.type === 'tool_use') {
          onEvent({ type: 'tool', name: e.content_block.name });
        }
        break;
      }
      case 'assistant': {
        // 完成ブロック: ツール使用の通知のみ拾う(テキストはdeltaで送信済み)
        for (const block of ev.message?.content ?? []) {
          if (block.type === 'tool_use') {
            onEvent({ type: 'tool_done', name: block.name });
          }
        }
        break;
      }
      case 'result':
        gotResult = true;
        onEvent({
          type: 'result',
          sessionId: ev.session_id,
          isError: !!ev.is_error,
          text: typeof ev.result === 'string' ? ev.result : '',
          durationMs: ev.duration_ms,
          costUsd: ev.total_cost_usd,
        });
        break;
    }
  }

  const done = new Promise((resolve) => {
    child.on('close', (code) => {
      if (!gotResult) {
        onEvent({
          type: 'error',
          message: `claude が異常終了しました (code ${code})` +
            (stderrBuf ? `: ${stderrBuf.slice(-500)}` : ''),
        });
      }
      resolve();
    });
    child.on('error', (err) => {
      onEvent({ type: 'error', message: `claude を起動できません: ${err.message}` });
      resolve();
    });
  });

  return {
    kill: () => {
      try { child.kill('SIGTERM'); } catch { /* already dead */ }
    },
    done,
  };
}
