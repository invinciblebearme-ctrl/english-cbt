import type { Env } from './env';
import { fail, type Ctx } from './http';

export const now = () => Date.now();

export function appSecret(env: Env): string {
  const s = env.APP_SECRET;
  if (!s || s.length < 32) fail(500, '서버 설정 오류: APP_SECRET(32자 이상)이 설정되지 않았습니다.');
  return s!;
}

export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/** 관리자 활동 기록 (응시 코드·비밀번호 등 비밀값은 기록하지 않음) */
export async function audit(ctx: Ctx, action: string, targetType = '', targetId = '', detail: Record<string, unknown> = {}) {
  await ctx.env.DB.prepare('INSERT INTO audit_logs(admin_id,action,target_type,target_id,detail,ip,created_at) VALUES(?,?,?,?,?,?,?)')
    .bind(ctx.admin?.id ?? null, action, targetType, targetId, JSON.stringify(detail), ctx.ip, now())
    .run();
}

/** 고정 시간 창 카운터를 1 올리고 현재 값을 돌려줍니다. */
export async function hitCounter(env: Env, key: string, windowMs: number): Promise<number> {
  const t = now();
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits(key,count,reset_at) VALUES(?1,1,?2)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN rate_limits.reset_at <= ?3 THEN 1 ELSE rate_limits.count + 1 END,
       reset_at = CASE WHEN rate_limits.reset_at <= ?3 THEN ?2 ELSE rate_limits.reset_at END
     RETURNING count`,
  )
    .bind(key, t + windowMs, t)
    .first<{ count: number }>();
  return row?.count ?? 1;
}

export async function peekCounter(env: Env, key: string): Promise<number> {
  const row = await env.DB.prepare('SELECT count, reset_at FROM rate_limits WHERE key=?').bind(key).first<{ count: number; reset_at: number }>();
  if (!row || row.reset_at <= now()) return 0;
  return row.count;
}

export async function clearCounter(env: Env, key: string) {
  await env.DB.prepare('DELETE FROM rate_limits WHERE key=?').bind(key).run();
}

/** 요청 제한: 창 안에서 limit 회를 넘으면 429 */
export async function rateLimit(env: Env, key: string, limit: number, windowMs: number) {
  const n = await hitCounter(env, key, windowMs);
  if (n > limit) fail(429, '요청이 너무 많습니다. 잠시 후 다시 시도하세요.');
}

/** 만료된 세션·카운터 정리 (cron) */
export async function cleanup(env: Env) {
  const t = now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM rate_limits WHERE reset_at < ?').bind(t),
    env.DB.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').bind(t),
    env.DB.prepare('DELETE FROM student_sessions WHERE expires_at < ?').bind(t),
  ]);
}
