import { fail, json, readJson, str, type Ctx, type Router } from '../http';
import { createAdminSession, destroyAdminSession, requireAdmin, requireOwner, resolveAdmin } from '../auth';
import { hashPassword, safeEqual, uid, verifyPassword } from '../crypto';
import { audit, clearCounter, hitCounter, now, peekCounter } from '../db';

const passwordRule = (p: string) => {
  if (p.length < 10) fail(400, '비밀번호는 10자 이상이어야 합니다.');
  if (!/[A-Za-z]/.test(p) || !/[0-9]/.test(p)) fail(400, '비밀번호에 영문과 숫자를 모두 포함하세요.');
};

export function adminAuthRoutes(r: Router) {
  /** 로그인 화면이 필요한 정보 (공개) */
  r.get('/api/admin/auth/status', async (ctx) => {
    const count = await ctx.env.DB.prepare('SELECT COUNT(*) AS n FROM admins').first<{ n: number }>();
    const admin = await resolveAdmin(ctx);
    return {
      setupRequired: !count?.n,
      accessEnabled: !!(ctx.env.ACCESS_TEAM_DOMAIN && ctx.env.ACCESS_AUD),
      admin: admin ? { id: admin.id, username: admin.username, displayName: admin.display_name, role: admin.role } : null,
    };
  });

  /** 최초 관리자 생성: 관리자가 한 명도 없고 SETUP_TOKEN이 맞을 때만 */
  r.post('/api/admin/auth/setup', async (ctx) => {
    if (ctx.req.headers.get('x-cbt-admin') !== '1') fail(403, '허용되지 않은 요청입니다.');
    const b = await readJson<Record<string, string>>(ctx.req);
    const ipKey = `setup:${ctx.ip}`;
    if ((await hitCounter(ctx.env, ipKey, 15 * 60_000)) > 10) fail(429, '시도가 너무 많습니다. 잠시 후 다시 시도하세요.');
    const count = await ctx.env.DB.prepare('SELECT COUNT(*) AS n FROM admins').first<{ n: number }>();
    if (count?.n) fail(409, '이미 관리자 계정이 있습니다.');
    const expected = ctx.env.SETUP_TOKEN || '';
    if (!expected || !safeEqual(String(b.setupToken || ''), expected)) fail(403, '설정 토큰이 올바르지 않습니다.');
    const username = str(b.username, '아이디', 40, true).trim();
    if (!/^[a-zA-Z0-9._-]{3,40}$/.test(username)) fail(400, '아이디는 영문·숫자·._- 3~40자로 입력하세요.');
    const password = str(b.password, '비밀번호', 200, true);
    passwordRule(password);
    const id = uid();
    await ctx.env.DB.prepare("INSERT INTO admins(id,username,display_name,password_hash,role,created_at) VALUES(?,?,?,?,'owner',?)")
      .bind(id, username, str(b.displayName, '이름', 40).trim() || username, await hashPassword(password), now())
      .run();
    ctx.admin = { id, username, display_name: username, email: null, role: 'owner' };
    await audit(ctx, 'admin.setup', 'admin', id);
    await createAdminSession(ctx, id);
    return { ok: true };
  });

  r.post('/api/admin/auth/login', async (ctx) => {
    if (ctx.req.headers.get('x-cbt-admin') !== '1') fail(403, '허용되지 않은 요청입니다.');
    const b = await readJson<Record<string, string>>(ctx.req);
    const username = str(b.username, '아이디', 100, true).trim().toLowerCase();
    const password = str(b.password, '비밀번호', 200, true);
    const ipKey = `admin-login-ip:${ctx.ip}`;
    const userKey = `admin-login-user:${username}`;
    if ((await peekCounter(ctx.env, ipKey)) >= 30 || (await peekCounter(ctx.env, userKey)) >= 8)
      fail(429, '로그인 실패가 너무 많습니다. 15분 후 다시 시도하세요.');
    const row = await ctx.env.DB.prepare('SELECT id,username,display_name,email,role,password_hash FROM admins WHERE username=? AND active=1')
      .bind(username)
      .first<{ id: string; username: string; display_name: string; email: string | null; role: 'owner' | 'teacher'; password_hash: string | null }>();
    // 계정 유무와 관계없이 같은 계산을 해서 응답 시간으로 계정 존재를 알 수 없게 함
    const ok = await verifyPassword(password, row?.password_hash ?? 'pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    if (!row || !ok) {
      await hitCounter(ctx.env, ipKey, 15 * 60_000);
      await hitCounter(ctx.env, userKey, 15 * 60_000);
      fail(401, '아이디 또는 비밀번호가 올바르지 않습니다.');
    }
    await clearCounter(ctx.env, userKey);
    ctx.admin = { id: row!.id, username: row!.username, display_name: row!.display_name, email: row!.email, role: row!.role };
    await createAdminSession(ctx, row!.id);
    await audit(ctx, 'admin.login', 'admin', row!.id);
    return { ok: true };
  });

  r.post('/api/admin/auth/logout', async (ctx) => {
    if (ctx.req.headers.get('x-cbt-admin') !== '1') fail(403, '허용되지 않은 요청입니다.');
    ctx.admin = (await resolveAdmin(ctx)) ?? undefined;
    if (ctx.admin) await audit(ctx, 'admin.logout', 'admin', ctx.admin.id);
    await destroyAdminSession(ctx);
    return { ok: true };
  });

  r.post('/api/admin/auth/password', async (ctx) => {
    await requireAdmin(ctx);
    const b = await readJson<Record<string, string>>(ctx.req);
    const row = await ctx.env.DB.prepare('SELECT password_hash FROM admins WHERE id=?').bind(ctx.admin!.id).first<{ password_hash: string | null }>();
    if (row?.password_hash && !(await verifyPassword(String(b.currentPassword || ''), row.password_hash))) fail(400, '현재 비밀번호가 올바르지 않습니다.');
    const next = str(b.newPassword, '새 비밀번호', 200, true);
    passwordRule(next);
    await ctx.env.DB.batch([
      ctx.env.DB.prepare('UPDATE admins SET password_hash=? WHERE id=?').bind(await hashPassword(next), ctx.admin!.id),
      ctx.env.DB.prepare('DELETE FROM admin_sessions WHERE admin_id=?').bind(ctx.admin!.id),
    ]);
    await createAdminSession(ctx, ctx.admin!.id);
    await audit(ctx, 'admin.password_change', 'admin', ctx.admin!.id);
    return { ok: true };
  });

  // ----- 교사 계정 관리 (최고 관리자 전용) -----
  r.get('/api/admin/admins', async (ctx) => {
    await requireAdmin(ctx);
    requireOwner(ctx);
    const rows = await ctx.env.DB.prepare('SELECT id,username,display_name,email,role,active,created_at,last_login_at FROM admins ORDER BY created_at').all();
    return rows.results;
  });

  r.post('/api/admin/admins', async (ctx) => {
    await requireAdmin(ctx);
    requireOwner(ctx);
    const b = await readJson<Record<string, string>>(ctx.req);
    const username = str(b.username, '아이디', 40, true).trim();
    if (!/^[a-zA-Z0-9._-]{3,40}$/.test(username)) fail(400, '아이디는 영문·숫자·._- 3~40자로 입력하세요.');
    const password = str(b.password, '비밀번호', 200, true);
    passwordRule(password);
    const email = str(b.email, '이메일', 200).trim() || null;
    const exists = await ctx.env.DB.prepare('SELECT 1 FROM admins WHERE username=? OR (email IS NOT NULL AND email=?)').bind(username, email).first();
    if (exists) fail(409, '이미 사용 중인 아이디 또는 이메일입니다.');
    const id = uid();
    await ctx.env.DB.prepare("INSERT INTO admins(id,username,display_name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,'teacher',?)")
      .bind(id, username, str(b.displayName, '이름', 40).trim() || username, email, await hashPassword(password), now())
      .run();
    await audit(ctx, 'admin.create', 'admin', id, { username });
    return json({ id }, 201);
  });

  r.put('/api/admin/admins/:id', async (ctx: Ctx) => {
    await requireAdmin(ctx);
    requireOwner(ctx);
    const b = await readJson<{ active?: boolean }>(ctx.req);
    if (ctx.params.id === ctx.admin!.id) fail(400, '자기 자신의 계정은 비활성화할 수 없습니다.');
    await ctx.env.DB.batch([
      ctx.env.DB.prepare('UPDATE admins SET active=? WHERE id=?').bind(b.active ? 1 : 0, ctx.params.id),
      ctx.env.DB.prepare('DELETE FROM admin_sessions WHERE admin_id=?').bind(ctx.params.id),
    ]);
    await audit(ctx, b.active ? 'admin.activate' : 'admin.deactivate', 'admin', ctx.params.id);
    return { ok: true };
  });

  r.get('/api/admin/audit-logs', async (ctx) => {
    await requireAdmin(ctx);
    requireOwner(ctx);
    const rows = await ctx.env.DB.prepare(
      `SELECT l.id,l.action,l.target_type,l.target_id,l.detail,l.ip,l.created_at,a.display_name AS admin_name
       FROM audit_logs l LEFT JOIN admins a ON a.id=l.admin_id ORDER BY l.id DESC LIMIT 300`,
    ).all();
    return rows.results;
  });
}
