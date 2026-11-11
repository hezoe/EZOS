// 認証トークンの純粋ロジック(ファイル入出力を持たないのでそのまま単体テストできる)。
// R-025: 平文保存をやめ SHA-256 で保存・無操作失効(滑り)と絶対失効の二段・サーバー側失効。
import { createHash, randomBytes } from 'node:crypto';

export const AUTH_TTL_MS = 30 * 24 * 3600 * 1000;   // 絶対期限(必ず失効)
export const AUTH_IDLE_MS = 7 * 24 * 3600 * 1000;   // 無操作での失効(滑り)
export const REAUTH_WINDOW_MS = 5 * 60 * 1000;      // 再認証が有効な時間(R-026)

// Cookie の値(生トークン)を照合時にハッシュする。保存されるのはこのハッシュだけ。
export function hashToken(raw) {
  return createHash('sha256').update(String(raw)).digest('base64url');
}

export function newToken() {
  return randomBytes(32).toString('base64url');
}

// 期限切れ(絶対・無操作)の記録を削除。旧形式(平文キー→数値)も扱う。tokens を破壊的に掃除。
export function pruneTokens(tokens, now = Date.now()) {
  for (const [k, rec] of Object.entries(tokens)) {
    if (typeof rec === 'number') {            // 旧形式: 平文キー → 絶対期限(数値)
      if (rec < now) delete tokens[k];
      continue;
    }
    if (!rec || typeof rec !== 'object'
        || (rec.abs || 0) < now
        || (rec.seen && now - rec.seen > AUTH_IDLE_MS)) {
      delete tokens[k];
    }
  }
  return tokens;
}

// 生トークンに対応する記録を返す。無効なら null。
// 旧形式(平文キー)のセッションは使用時にハッシュ形式へ移行する(tokens を書き換え migrated=true)。
// 返り値: { key, rec, migrated } | null
export function resolveSession(tokens, raw, now = Date.now()) {
  if (!raw) return null;
  const h = hashToken(raw);
  let rec = tokens[h];
  let migrated = false;
  if (rec === undefined && tokens[raw] !== undefined) {   // 旧形式からの移行
    const legacy = tokens[raw];
    rec = (typeof legacy === 'number') ? { abs: legacy, seen: now } : legacy;
    delete tokens[raw];
    tokens[h] = rec;
    migrated = true;
  }
  if (typeof rec === 'number') rec = { abs: rec, seen: now };
  if (!rec || typeof rec !== 'object' || (rec.abs || 0) < now) return null;
  if (rec.seen && now - rec.seen > AUTH_IDLE_MS) return null;   // 無操作で失効
  return { key: h, rec, migrated };
}
