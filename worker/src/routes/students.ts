import { fail, int, json, readJson, str, type Router } from '../http';
import { requireAdmin } from '../auth';
import { generateAccessCode, hmac, normalizeCode, uid } from '../crypto';
import { appSecret, audit, now } from '../db';

/** 한국 학년도: 3월~다음 해 2월 */
export function currentSchoolYear(t = Date.now()) {
  const d = new Date(t + 9 * 3600_000);
  return d.getUTCMonth() < 2 ? d.getUTCFullYear() - 1 : d.getUTCFullYear();
}

export const codeHash = (secret: string, studentId: string, code: string) => hmac(secret, `code:${studentId}:${normalizeCode(code)}`);

const cleanName = (v: unknown) => {
  const s = str(v, '이름', 40, true).normalize('NFC').trim().replace(/\s+/g, ' ');
  if (/[<>"'`\\]/.test(s)) fail(400, '이름에 사용할 수 없는 문자가 있습니다.');
  return s;
};

export function studentRoutes(r: Router) {
  // ----- 학급 -----
  r.get('/api/admin/classes', async (ctx) => {
    await requireAdmin(ctx);
    const rows = await ctx.env.DB.prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM students s WHERE s.class_id=c.id AND s.active=1) AS student_count
       FROM classes c ORDER BY c.school_year DESC, c.grade, c.class_no`,
    ).all();
    return rows.results;
  });

  r.post('/api/admin/classes', async (ctx) => {
    await requireAdmin(ctx);
    const b = await readJson(ctx.req);
    const year = b.schoolYear ? int(b.schoolYear, '학년도', 2000, 2100) : currentSchoolYear();
    const grade = int(b.grade, '학년', 1, 6);
    const classNo = int(b.classNo, '반', 1, 30);
    const dup = await ctx.env.DB.prepare('SELECT 1 FROM classes WHERE school_year=? AND grade=? AND class_no=?').bind(year, grade, classNo).first();
    if (dup) fail(409, '이미 등록된 학급입니다.');
    const id = uid();
    await ctx.env.DB.prepare('INSERT INTO classes(id,school_year,grade,class_no,name,created_at) VALUES(?,?,?,?,?,?)')
      .bind(id, year, grade, classNo, str(b.name, '학급 이름', 40).trim(), now())
      .run();
    await audit(ctx, 'class.create', 'class', id, { year, grade, classNo });
    return json({ id }, 201);
  });

  r.delete('/api/admin/classes/:id', async (ctx) => {
    await requireAdmin(ctx);
    const used = await ctx.env.DB.prepare('SELECT 1 FROM attempts a JOIN students s ON s.id=a.student_id WHERE s.class_id=? LIMIT 1').bind(ctx.params.id).first();
    if (used) fail(409, '응시 기록이 있는 학급은 삭제할 수 없습니다.');
    await ctx.env.DB.prepare('DELETE FROM classes WHERE id=?').bind(ctx.params.id).run();
    await audit(ctx, 'class.delete', 'class', ctx.params.id);
    return { ok: true };
  });

  // ----- 학생 -----
  r.get('/api/admin/students', async (ctx) => {
    await requireAdmin(ctx);
    const classId = ctx.url.searchParams.get('classId');
    const rows = await ctx.env.DB.prepare(
      `SELECT s.id, s.class_id, s.number, s.name, s.active, c.school_year, c.grade, c.class_no,
         ac.created_at AS code_issued_at, ac.first_used_at AS code_first_used_at, ac.last_used_at AS code_last_used_at, ac.use_count AS code_use_count,
         (SELECT COUNT(*) FROM access_codes x WHERE x.student_id=s.id) AS code_issue_count
       FROM students s JOIN classes c ON c.id=s.class_id
       LEFT JOIN access_codes ac ON ac.student_id=s.id AND ac.status='active'
       ${classId ? 'WHERE s.class_id=?' : ''}
       ORDER BY c.school_year DESC, c.grade, c.class_no, s.number`,
    )
      .bind(...(classId ? [classId] : []))
      .all();
    return rows.results;
  });

  r.post('/api/admin/students', async (ctx) => {
    await requireAdmin(ctx);
    const b = await readJson(ctx.req);
    const classId = str(b.classId, '학급', 64, true);
    const cls = await ctx.env.DB.prepare('SELECT id FROM classes WHERE id=?').bind(classId).first();
    if (!cls) fail(404, '학급을 찾을 수 없습니다.');
    const number = int(b.number, '번호', 1, 99);
    const dup = await ctx.env.DB.prepare('SELECT 1 FROM students WHERE class_id=? AND number=?').bind(classId, number).first();
    if (dup) fail(409, '같은 번호의 학생이 이미 있습니다.');
    const id = uid();
    await ctx.env.DB.prepare('INSERT INTO students(id,class_id,number,name,created_at) VALUES(?,?,?,?,?)').bind(id, classId, number, cleanName(b.name), now()).run();
    await audit(ctx, 'student.create', 'student', id);
    return json({ id }, 201);
  });

  r.put('/api/admin/students/:id', async (ctx) => {
    await requireAdmin(ctx);
    const b = await readJson(ctx.req);
    const cur = await ctx.env.DB.prepare('SELECT class_id FROM students WHERE id=?').bind(ctx.params.id).first<{ class_id: string }>();
    if (!cur) fail(404, '학생을 찾을 수 없습니다.');
    const number = int(b.number, '번호', 1, 99);
    const dup = await ctx.env.DB.prepare('SELECT 1 FROM students WHERE class_id=? AND number=? AND id<>?').bind(cur!.class_id, number, ctx.params.id).first();
    if (dup) fail(409, '같은 번호의 학생이 이미 있습니다.');
    await ctx.env.DB.prepare('UPDATE students SET number=?, name=?, active=? WHERE id=?')
      .bind(number, cleanName(b.name), b.active === false ? 0 : 1, ctx.params.id)
      .run();
    await audit(ctx, 'student.update', 'student', ctx.params.id);
    return { ok: true };
  });

  r.delete('/api/admin/students/:id', async (ctx) => {
    await requireAdmin(ctx);
    const used = await ctx.env.DB.prepare('SELECT 1 FROM attempts WHERE student_id=? LIMIT 1').bind(ctx.params.id).first();
    if (used) {
      // 성적 보존: 응시 기록이 있으면 비활성화만 합니다.
      await ctx.env.DB.batch([
        ctx.env.DB.prepare('UPDATE students SET active=0 WHERE id=?').bind(ctx.params.id),
        ctx.env.DB.prepare("UPDATE access_codes SET status='revoked', revoked_at=? WHERE student_id=? AND status='active'").bind(now(), ctx.params.id),
      ]);
      await audit(ctx, 'student.deactivate', 'student', ctx.params.id);
      return { ok: true, deactivated: true };
    }
    await ctx.env.DB.prepare('DELETE FROM students WHERE id=?').bind(ctx.params.id).run();
    await audit(ctx, 'student.delete', 'student', ctx.params.id);
    return { ok: true };
  });

  /** 일괄 등록: [{grade,classNo,number,name}] — 학급이 없으면 만들고, 같은 번호는 이름을 갱신 */
  r.post('/api/admin/students/bulk', async (ctx) => {
    await requireAdmin(ctx);
    const b = await readJson<{ rows?: unknown; schoolYear?: unknown }>(ctx.req);
    if (!Array.isArray(b.rows) || !b.rows.length || b.rows.length > 1000) fail(400, '등록할 학생 목록이 없거나 너무 많습니다. (최대 1000명)');
    const year = b.schoolYear ? int(b.schoolYear, '학년도', 2000, 2100) : currentSchoolYear();
    const errors: string[] = [];
    const rows: { grade: number; classNo: number; number: number; name: string }[] = [];
    (b.rows as Record<string, unknown>[]).forEach((row, i) => {
      try {
        rows.push({ grade: int(row.grade, '학년', 1, 6), classNo: int(row.classNo, '반', 1, 30), number: int(row.number, '번호', 1, 99), name: cleanName(row.name) });
      } catch (e) {
        errors.push(`${i + 1}번째 줄: ${(e as Error).message}`);
      }
    });
    if (errors.length) fail(400, '입력 오류가 있습니다.', { errors });
    const keys = new Set<string>();
    for (const r0 of rows) {
      const k = `${r0.grade}-${r0.classNo}-${r0.number}`;
      if (keys.has(k)) fail(400, `중복된 학생이 있습니다: ${r0.grade}학년 ${r0.classNo}반 ${r0.number}번`);
      keys.add(k);
    }

    const db = ctx.env.DB;
    const t = now();
    const classKeys = [...new Set(rows.map((r0) => `${r0.grade}-${r0.classNo}`))];
    await db.batch(
      classKeys.map((k) => {
        const [g, c] = k.split('-').map(Number);
        return db.prepare('INSERT OR IGNORE INTO classes(id,school_year,grade,class_no,name,created_at) VALUES(?,?,?,?,?,?)').bind(uid(), year, g, c, '', t);
      }),
    );
    const classes = await db.prepare('SELECT id, grade, class_no FROM classes WHERE school_year=?').bind(year).all<{ id: string; grade: number; class_no: number }>();
    const classMap = new Map(classes.results.map((c) => [`${c.grade}-${c.class_no}`, c.id]));
    const before = await db.prepare('SELECT COUNT(*) AS n FROM students').first<{ n: number }>();
    const stmts = rows.map((r0) =>
      db
        .prepare(
          `INSERT INTO students(id,class_id,number,name,created_at) VALUES(?,?,?,?,?)
           ON CONFLICT(class_id,number) DO UPDATE SET name=excluded.name, active=1`,
        )
        .bind(uid(), classMap.get(`${r0.grade}-${r0.classNo}`), r0.number, r0.name, t),
    );
    for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));
    const after = await db.prepare('SELECT COUNT(*) AS n FROM students').first<{ n: number }>();
    const created = (after?.n ?? 0) - (before?.n ?? 0);
    await audit(ctx, 'student.bulk', 'student', '', { total: rows.length, created });
    return { ok: true, total: rows.length, created, updated: rows.length - created };
  });

  /**
   * 응시 코드 발급/재발급. 평문 코드는 이 응답에서 한 번만 돌려주고 DB에는 HMAC만 저장합니다.
   * 재발급하면 이전 코드와 그 코드로 로그인한 세션은 즉시 무효가 됩니다.
   */
  r.post('/api/admin/students/codes', async (ctx) => {
    await requireAdmin(ctx);
    const b = await readJson<{ studentIds?: unknown; onlyMissing?: boolean }>(ctx.req);
    if (!Array.isArray(b.studentIds) || !b.studentIds.length || b.studentIds.length > 1000) fail(400, '코드를 발급할 학생을 선택하세요.');
    const ids = [...new Set((b.studentIds as unknown[]).map((x) => str(x, '학생', 64, true)))];
    const secret = appSecret(ctx.env);
    const db = ctx.env.DB;
    const out: { studentId: string; grade: number; classNo: number; number: number; name: string; code: string }[] = [];
    const t = now();
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const students = await db
        .prepare(
          `SELECT s.id, s.number, s.name, c.grade, c.class_no, (SELECT COUNT(*) FROM access_codes a WHERE a.student_id=s.id AND a.status='active') AS active_codes
           FROM students s JOIN classes c ON c.id=s.class_id WHERE s.active=1 AND s.id IN (${chunk.map(() => '?').join(',')})`,
        )
        .bind(...chunk)
        .all<{ id: string; number: number; name: string; grade: number; class_no: number; active_codes: number }>();
      const stmts: D1PreparedStatement[] = [];
      for (const s of students.results) {
        if (b.onlyMissing && s.active_codes) continue;
        const code = generateAccessCode();
        stmts.push(db.prepare("UPDATE access_codes SET status='revoked', revoked_at=? WHERE student_id=? AND status='active'").bind(t, s.id));
        stmts.push(
          db
            .prepare('INSERT INTO access_codes(id,student_id,code_hash,status,created_at,created_by) VALUES(?,?,?,?,?,?)')
            .bind(uid(), s.id, await codeHash(secret, s.id, code), 'active', t, ctx.admin!.id),
        );
        out.push({ studentId: s.id, grade: s.grade, classNo: s.class_no, number: s.number, name: s.name, code });
      }
      if (stmts.length) await db.batch(stmts);
    }
    await audit(ctx, 'code.issue', 'student', '', { count: out.length });
    out.sort((a, b2) => a.grade - b2.grade || a.classNo - b2.classNo || a.number - b2.number);
    return { codes: out };
  });

  /** 코드 사용 중지 */
  r.post('/api/admin/students/:id/revoke-code', async (ctx) => {
    await requireAdmin(ctx);
    await ctx.env.DB.prepare("UPDATE access_codes SET status='revoked', revoked_at=? WHERE student_id=? AND status='active'").bind(now(), ctx.params.id).run();
    await audit(ctx, 'code.revoke', 'student', ctx.params.id);
    return { ok: true };
  });

  /** 학생별 시험 응시 현황 */
  r.get('/api/admin/students/:id/attempts', async (ctx) => {
    await requireAdmin(ctx);
    const rows = await ctx.env.DB.prepare(
      `SELECT e.id AS exam_id, e.title, e.status AS exam_status, a.id AS attempt_id, a.status, a.started_at, a.submitted_at, a.total_score, a.max_score, a.grading_status
       FROM exam_targets t JOIN exams e ON e.id=t.exam_id AND e.deleted_at IS NULL
       LEFT JOIN attempts a ON a.exam_id=e.id AND a.student_id=t.student_id AND a.archived=0
       WHERE t.student_id=? ORDER BY e.created_at DESC`,
    )
      .bind(ctx.params.id)
      .all();
    return rows.results;
  });
}
