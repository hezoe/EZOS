// R-025 認証トークンの純粋ロジックの単体試験。 node app/lib/authtokens.test.mjs
import {
  AUTH_TTL_MS, AUTH_IDLE_MS, hashToken, pruneTokens, newToken, resolveSession,
} from './authtokens.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK ', m); } else { fail++; console.log('  NG ', m); } };

const NOW = 1_000_000_000_000;

// 新規トークン発行→照合
{
  const tok = newToken();
  const tokens = { [hashToken(tok)]: { abs: NOW + AUTH_TTL_MS, seen: NOW } };
  const s = resolveSession(tokens, tok, NOW);
  ok(s && s.key === hashToken(tok), '発行したトークンで照合できる');
  ok(!tokens[tok], '平文トークンはキーとして保存されない(ハッシュのみ)');
  ok(resolveSession(tokens, 'wrong', NOW) === null, '別トークンは無効');
}

// 絶対期限切れ
{
  const tok = newToken();
  const tokens = { [hashToken(tok)]: { abs: NOW - 1, seen: NOW } };
  ok(resolveSession(tokens, tok, NOW) === null, '絶対期限を過ぎたら無効');
}

// 無操作失効(滑り)
{
  const tok = newToken();
  const tokens = { [hashToken(tok)]: { abs: NOW + AUTH_TTL_MS, seen: NOW - AUTH_IDLE_MS - 1 } };
  ok(resolveSession(tokens, tok, NOW) === null, '無操作が AUTH_IDLE_MS を超えたら無効');
  const tokens2 = { [hashToken(tok)]: { abs: NOW + AUTH_TTL_MS, seen: NOW - AUTH_IDLE_MS + 1000 } };
  ok(resolveSession(tokens2, tok, NOW) !== null, '無操作が範囲内なら有効');
}

// 旧形式(平文キー→数値)の後方互換＋移行
{
  const tok = 'legacyRawToken123';
  const tokens = { [tok]: NOW + AUTH_TTL_MS };   // 旧: 平文キー → 絶対期限
  const s = resolveSession(tokens, tok, NOW);
  ok(s !== null, '旧形式(平文キー)のセッションも照合できる(ログアウトさせない)');
  ok(tokens[tok] === undefined && tokens[hashToken(tok)] !== undefined, '使用時にハッシュ形式へ移行する');
  ok(s.migrated === true, '移行フラグが立つ(呼び出し側で保存する)');
  ok(typeof tokens[hashToken(tok)] === 'object' && tokens[hashToken(tok)].seen === NOW,
     '移行後は {abs, seen} 形式で seen が入る');
}

// 旧形式の期限切れ
{
  const tok = 'oldExpired';
  const tokens = { [tok]: NOW - 1 };
  ok(resolveSession(tokens, tok, NOW) === null, '旧形式でも絶対期限切れは無効');
}

// pruneTokens: 期限切れ(新旧)を掃除、有効は残す
{
  const good = newToken();
  const tokens = {
    [hashToken(good)]: { abs: NOW + AUTH_TTL_MS, seen: NOW },
    'oldDead': NOW - 1,
    'hashDeadAbs': { abs: NOW - 1, seen: NOW },
    'hashDeadIdle': { abs: NOW + AUTH_TTL_MS, seen: NOW - AUTH_IDLE_MS - 1 },
  };
  pruneTokens(tokens, NOW);
  ok(Object.keys(tokens).length === 1 && tokens[hashToken(good)], '期限切れ(新旧)は掃除され有効のみ残る');
}

// hashToken は決定的で平文を復元できない形
{
  ok(hashToken('abc') === hashToken('abc'), 'hashToken は決定的');
  ok(hashToken('abc') !== 'abc', 'hashToken は平文と異なる');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
