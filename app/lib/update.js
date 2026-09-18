// EZOS 自己更新: GitHub 上の最新版を調べ、git pull で更新して再起動する。
// 設置先ごとにリポジトリ(フォーク)やブランチが違いうるので、更新元は git remote から自動判定する。
// data/config.json の updateUrl / updateBranch で上書きもできる。
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { ROOT, readJson } from './store.js';

const pexec = promisify(execFile);
const CACHE_MS = 10 * 60_000;          // 更新確認の結果を保持する時間
const LOG_FILE = path.join(ROOT, 'data', 'update.log');
const STATUS_FILE = path.join(ROOT, 'data', 'update-status.json');
const REPO_DIR = path.dirname(ROOT);   // app/ の1つ上 = リポジトリの作業ディレクトリ

let cache = null;                       // { at, result }

// 自分自身が属する systemd unit(複数の EZOS が同居していても取り違えないため)
export function ownUnit() {
  try {
    const m = /([A-Za-z0-9_.@\-]+\.service)/.exec(fs.readFileSync('/proc/self/cgroup', 'utf8'));
    return m ? m[1] : '';
  } catch { return ''; }
}

export function localVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || null; }
  catch { return null; }
}

// "1.2.3" の比較。a が b より新しければ 1、同じなら 0、古ければ -1
export function compareVersions(a, b) {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

async function git(args, timeout = 20_000) {
  const { stdout } = await pexec('git', ['-C', REPO_DIR, ...args], {
    timeout,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=10' },
  });
  return stdout.trim();
}

// git remote の URL から releases.json の取得先を組み立てる(GitHub 以外なら null)。
// raw.githubusercontent は5分キャッシュされ push 直後は古い版を返すため、
// 即時反映される Contents API を先に試し、失敗したら raw に切り替える。
export function updateUrlsFromRemote(remote, branch) {
  const m = /github\.com[:/]+([^/]+)\/([^/.]+)(\.git)?$/.exec(String(remote || '').trim());
  if (!m) return [];
  const [, owner, repo] = m;
  const ref = branch || 'main';
  return [
    `https://api.github.com/repos/${owner}/${repo}/contents/app/public/releases.json?ref=${encodeURIComponent(ref)}`,
    `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/app/public/releases.json`,
  ];
}
export const rawUrlFromRemote = (remote, branch) => updateUrlsFromRemote(remote, branch)[1] ?? null;

// この設置先の git 状態(更新できるか)
export async function repoState() {
  try {
    if ((await git(['rev-parse', '--is-inside-work-tree'])) !== 'true') {
      return { git: false, reason: 'not-a-git-repo' };
    }
    const [branch, remote, dirty] = await Promise.all([
      git(['rev-parse', '--abbrev-ref', 'HEAD']),
      git(['config', '--get', 'remote.origin.url']).catch(() => ''),
      git(['status', '--porcelain']),
    ]);
    const changes = dirty.split('\n').filter(Boolean);
    return {
      git: true,
      branch,
      remote,
      dirty: changes.length > 0,
      changes: changes.slice(0, 20),
      canUpdate: Boolean(remote) && changes.length === 0,
      reason: !remote ? 'no-remote' : changes.length ? 'local-changes' : null,
    };
  } catch (e) {
    return { git: false, reason: 'not-a-git-repo', error: e.message };
  }
}

/** 最新版を調べる。{ current, latest, updateAvailable, notes, repo, checkedAt, error } */
export async function checkUpdate({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.result;

  const cfg = readJson('config.json', {});
  const current = localVersion();
  const repo = await repoState();
  const urls = cfg.updateUrl ? [cfg.updateUrl] : updateUrlsFromRemote(repo.remote, cfg.updateBranch || repo.branch);

  const result = { current, latest: null, updateAvailable: false, notes: [], repo, url: urls[0] || null, checkedAt: Date.now(), error: null };
  if (!urls.length) {
    result.error = 'no-update-url';
    cache = { at: Date.now(), result };
    return result;
  }
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
        headers: { Accept: 'application/vnd.github.raw, application/json', 'User-Agent': 'EZOS-update-check' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      result.latest = data.current || null;
      result.updateAvailable = compareVersions(result.latest, current) > 0;
      // 手元より新しいリリースのノートだけ返す
      result.notes = (data.releases || []).filter((r) => compareVersions(r.version, current) > 0);
      result.url = url;
      result.error = null;
      break;
    } catch (e) {
      result.error = e.message;      // 次の取得先へ(最後まで失敗したらこの内容を返す)
    }
  }
  cache = { at: Date.now(), result };
  return result;
}

export function updateStatus() {
  const status = readJson('update-status.json', { state: 'idle' });
  let log = '';
  try { log = fs.readFileSync(LOG_FILE, 'utf8').slice(-8000); } catch { /* 未実行 */ }
  return { ...status, version: localVersion(), log };
}

/** 更新を開始する(bin/ezupdate.sh を切り離して起動)。完了時にサーバーは再起動される */
export function startUpdate({ force = false } = {}) {
  fs.mkdirSync(path.dirname(STATUS_FILE), { recursive: true });
  fs.writeFileSync(STATUS_FILE, JSON.stringify({ state: 'running', startedAt: Date.now(), fromVersion: localVersion() }));
  const out = fs.openSync(LOG_FILE, 'w');
  const child = spawn(path.join(ROOT, 'bin', 'ezupdate.sh'), [], {
    cwd: REPO_DIR,
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, EZOS_SERVER_PID: String(process.pid), EZOS_UNIT: ownUnit(), EZOS_FORCE: force ? '1' : '' },
  });
  child.unref();
  cache = null;
  return { started: true, pid: child.pid };
}
