import type { AdminUser, Env, StudentUser } from './env';
import { fail, type Ctx } from './http';
import { fromB64url, randomToken, sha256, uid } from './crypto';
import { now } from './db';

export const ADMIN_COOKIE = 'cbt_admin';
const ADMIN_SESSION_TTL = 8 * 60 * 60 * 1000; // 최대 8시간
const ADMIN_IDLE_TTL = 2 * 60 * 60 * 1000; // 2시간 미사용 시 만료
const STUDENT_SESSION_TTL = 4 * 60 * 60 * 1000;

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

export function adminCookie(token: string, maxAgeSec: number) {
  return `${ADMIN_COOKIE}=${token}; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSec}`;
}

export async function createAdminSession(ctx: Ctx, adminId: string) {
  const token = randomToken();
  const t = now();
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('INSERT INTO admin_sessions(id,admin_id,created_at,expires_at,last_seen_at) VALUES(?,?,?,?,?)').bind(
      await sha256(token),
      adminId,
      t,
      t + ADMIN_SESSION_TTL,
      t,
    ),
    ctx.env.DB.prepare('UPDATE admins SET last_login_at=? WHERE id=?').bind(t, adminId),
  ]);
  ctx.headers.append('set-cookie', adminCookie(token, ADMIN_SESSION_TTL / 1000));
}

export async function destroyAdminSession(ctx: Ctx) {
  const token = readCookie(ctx.req, ADMIN_COOKIE);
  if (token) await ctx.env.DB.prepare('DELETE FROM admin_sessions WHERE id=?').bind(await sha256(token)).run();
  ctx.headers.append('set-cookie', adminCookie('', 0));
}

/** 쿠키 세션 또는 Cloudflare Access JWT로 관리자를 확인합니다. */
export async function resolveAdmin(ctx: Ctx): Promise<AdminUser | null> {
  const { env, req } = ctx;
  const token = readCookie(req, ADMIN_COOKIE);
  if (token) {
    const id = await sha256(token);
    const row = await env.DB.prepare(
      `SELECT s.expires_at, s.last_seen_at, a.id, a.username, a.display_name, a.email, a.role
       FROM admin_sessions s JOIN admins a ON a.id=s.admin_id WHERE s.id=? AND a.active=1`,
    )
      .bind(id)
      .first<AdminUser & { expires_at: number; last_seen_at: number }>();
    const t = now();
    if (row && row.expires_at > t && t - row.last_seen_at < ADMIN_IDLE_TTL) {
      if (t - row.last_seen_at > 60_000) await env.DB.prepare('UPDATE admin_sessions SET last_seen_at=? WHERE id=?').bind(t, id).run();
      return { id: row.id, username: row.username, display_name: row.display_name, email: row.email, role: row.role };
    }
    if (row) await env.DB.prepare('DELETE FROM admin_sessions WHERE id=?').bind(id).run();
  }

  if (env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) {
    const jwt = req.headers.get('cf-access-jwt-assertion');
    const email = jwt ? await verifyAccessJwt(jwt, env) : null;
    if (email) {
      let admin = await env.DB.prepare('SELECT id,username,display_name,email,role FROM admins WHERE email=? AND active=1')
        .bind(email)
        .first<AdminUser>();
      const allowed = (env.ADMIN_EMAILS || '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      if (!admin && allowed.includes(email.toLowerCase())) {
        const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM admins').first<{ n: number }>();
        admin = { id: uid(), username: email, display_name: email.split('@')[0], email, role: count?.n ? 'teacher' : 'owner' };
        await env.DB.prepare('INSERT INTO admins(id,username,display_name,email,role,created_at) VALUES(?,?,?,?,?,?)')
          .bind(admin.id, admin.username, admin.display_name, admin.email, admin.role, now())
          .run();
      }
      if (admin) return admin;
    }
  }
  return null;
}

let jwksCache: { at: number; keys: (JsonWebKey & { kid?: string })[] } | null = null;

/** Cloudflare Access JWT(RS256) 서명·만료·대상(aud)·발급자 검증 */
export async function verifyAccessJwt(token: string, env: Env): Promise<string | null> {
  try {
    const [h, p, s] = token.split('.');
    const header = JSON.parse(new TextDecoder().decode(fromB64url(h)));
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(p)));
    if (header.alg !== 'RS256') return null;
    const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
    if (!jwksCache || now() - jwksCache.at > 60 * 60 * 1000) {
      const res = await fetch(`${issuer}/cdn-cgi/access/certs`);
      jwksCache = { at: now(), keys: ((await res.json()) as { keys: never[] }).keys };
    }
    const jwk = jwksCache.keys.find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromB64url(s), new TextEncoder().encode(`${h}.${p}`));
    if (!ok) return null;
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(env.ACCESS_AUD) || payload.iss !== issuer || !(payload.exp * 1000 > now())) return null;
    return typeof payload.email === 'string' ? payload.email : null;
  } catch {
    return null;
  }
}

/** 관리자 API 공통 검사: 인증 + 쿠키 기반 요청 위조(CSRF) 방지 */
export async function requireAdmin(ctx: Ctx): Promise<AdminUser> {
  if (ctx.req.method !== 'GET' && ctx.req.method !== 'HEAD') {
    if (ctx.req.headers.get('x-cbt-admin') !== '1') fail(403, '허용되지 않은 요청입니다.');
    const origin = ctx.req.headers.get('origin');
    if (origin && origin !== ctx.url.origin) fail(403, '허용되지 않은 출처의 요청입니다.');
  }
  const admin = await resolveAdmin(ctx);
  if (!admin) fail(401, '관리자 로그인이 필요합니다.');
  ctx.admin = admin!;
  return admin!;
}

export function requireOwner(ctx: Ctx) {
  if (ctx.admin?.role !== 'owner') fail(403, '최고 관리자만 사용할 수 있는 기능입니다.');
}

export async function createStudentSession(env: Env, studentId: string, accessCodeId: string): Promise<string> {
  const token = randomToken();
  const t = now();
  await env.DB.prepare('INSERT INTO student_sessions(id,student_id,access_code_id,created_at,expires_at,last_seen_at) VALUES(?,?,?,?,?,?)')
    .bind(await sha256(token), studentId, accessCodeId, t, t + STUDENT_SESSION_TTL, t)
    .run();
  return token;
}

/** 학생 세션: Authorization: Bearer <token>. 코드가 재발급(폐기)되면 세션도 무효 */
export async function requireStudent(ctx: Ctx): Promise<StudentUser> {
  const token = (ctx.req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) fail(401, '다시 로그인하세요.');
  const id = await sha256(token);
  const row = await ctx.env.DB.prepare(
    `SELECT ss.expires_at, s.id AS student_id, s.name, s.number, c.grade, c.class_no
     FROM student_sessions ss
     JOIN students s ON s.id=ss.student_id AND s.active=1
     JOIN classes c ON c.id=s.class_id
     JOIN access_codes ac ON ac.id=ss.access_code_id AND ac.status='active'
     WHERE ss.id=?`,
  )
    .bind(id)
    .first<{ expires_at: number; student_id: string; name: string; number: number; grade: number; class_no: number }>();
  if (!row || row.expires_at < now()) fail(401, '로그인 시간이 만료되었습니다. 다시 로그인하세요.');
  ctx.student = { sessionId: id, studentId: row!.student_id, name: row!.name, grade: row!.grade, classNo: row!.class_no, number: row!.number };
  return ctx.student;
}
