import { fail, int, readJson, str, type Ctx, type Router } from '../http';
import { createStudentSession, requireStudent } from '../auth';
import { randomPermutation, safeEqual, uid } from '../crypto';
import { appSecret, clearCounter, hitCounter, now, peekCounter, rateLimit } from '../db';
import { finalizeAttempt, studentItems, versionItems, type AttemptRow, type Layout } from '../attempts';
import { signedMediaUrl } from '../media';
import { codeHash } from './students';

const GENERIC_LOGIN_ERROR = '입력한 정보가 맞지 않습니다. 학년·반·번호·이름과 응시 코드를 다시 확인하세요.';
const nameKey = (s: string) => s.normalize('NFC').replace(/\s+/g, '');

interface ExamForStudent {
  id: string;
  title: string;
  description: string;
  status: string;
  start_at: number | null;
  end_at: number | null;
  result_policy: 'hidden' | 'score' | 'review';
  current_version_id: string | null;
  duration_min: number;
}

async function loadAttempt(ctx: Ctx): Promise<AttemptRow> {
  const a = await ctx.env.DB.prepare('SELECT * FROM attempts WHERE id=? AND student_id=? AND archived=0')
    .bind(ctx.params.id, ctx.student!.studentId)
    .first<AttemptRow>();
  if (!a) fail(404, '응시 기록을 찾을 수 없습니다.');
  // 서버 시간 기준으로 시간이 지났으면 즉시 마감·채점
  if (a!.status === 'in_progress' && now() > a!.deadline_at) {
    await finalizeAttempt(ctx.env, a!, 'timeout');
    return (await ctx.env.DB.prepare('SELECT * FROM attempts WHERE id=?').bind(a!.id).first<AttemptRow>())!;
  }
  return a!;
}

/** 결과 공개 방식에 따라 학생에게 보여줄 결과 */
async function studentResult(ctx: Ctx, a: AttemptRow) {
  const exam = await ctx.env.DB.prepare('SELECT result_policy FROM exams WHERE id=?').bind(a.exam_id).first<{ result_policy: string }>();
  const policy = exam?.result_policy ?? 'hidden';
  if (policy === 'hidden') return { policy };
  const base = { policy, gradingPending: a.grading_status === 'pending', score: a.total_score, maxScore: a.max_score };
  if (policy !== 'review') return base;
  const layout = JSON.parse(a.layout || '{}') as Layout;
  const grades = await ctx.env.DB.prepare('SELECT item_id, COALESCE(manual_score, auto_score) AS score, max_score, is_correct, status FROM grading_results WHERE attempt_id=?')
    .bind(a.id)
    .all<{ item_id: string; score: number; max_score: number; is_correct: number | null; status: string }>();
  const order = layout.order?.length ? layout.order : (await versionItems(ctx.env, a.version_id)).map((i) => i.id);
  return {
    ...base,
    items: order.map((id, i) => {
      const g = grades.results.find((x) => x.item_id === id);
      return { no: i + 1, score: g?.score ?? 0, maxScore: g?.max_score ?? 0, correct: g?.status === 'pending' ? null : g?.is_correct === 1 };
    }),
  };
}

export function studentRoutes(r: Router) {
  /**
   * 학생 로그인: 학년·반·번호·이름 + 개인 응시 코드.
   * 무차별 대입 방지: 학생별 실패 5회/15분, IP별 실패 60회/15분 (학교는 한 IP를 공유하므로 넉넉하게)
   */
  r.post('/api/student/login', async (ctx) => {
    const b = await readJson<Record<string, unknown>>(ctx.req);
    const grade = int(b.grade, '학년', 1, 6);
    const classNo = int(b.classNo, '반', 1, 30);
    const number = int(b.number, '번호', 1, 99);
    const name = str(b.name, '이름', 40, true);
    const code = str(b.code, '응시 코드', 40, true);
    const stuKey = `stu-login:${grade}-${classNo}-${number}`;
    const ipKey = `stu-login-ip:${ctx.ip}`;
    if ((await peekCounter(ctx.env, stuKey)) >= 5) fail(429, '로그인 실패가 5번 넘었습니다. 15분 뒤에 다시 하거나 선생님께 말씀하세요.');
    if ((await peekCounter(ctx.env, ipKey)) >= 60) fail(429, '로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.');

    const candidates = await ctx.env.DB.prepare(
      `SELECT s.id, s.name, ac.id AS code_id, ac.code_hash FROM students s JOIN classes c ON c.id=s.class_id
       JOIN access_codes ac ON ac.student_id=s.id AND ac.status='active'
       WHERE c.grade=? AND c.class_no=? AND s.number=? AND s.active=1 ORDER BY c.school_year DESC`,
    )
      .bind(grade, classNo, number)
      .all<{ id: string; name: string; code_id: string; code_hash: string }>();
    const secret = appSecret(ctx.env);
    let match: { id: string; code_id: string } | null = null;
    for (const c of candidates.results) {
      const h = await codeHash(secret, c.id, code);
      if (safeEqual(h, c.code_hash) && nameKey(c.name) === nameKey(name)) match = c;
    }
    if (!match) {
      await hitCounter(ctx.env, stuKey, 15 * 60_000);
      await hitCounter(ctx.env, ipKey, 15 * 60_000);
      fail(401, GENERIC_LOGIN_ERROR);
    }
    await clearCounter(ctx.env, stuKey);
    const t = now();
    await ctx.env.DB.prepare('UPDATE access_codes SET first_used_at=COALESCE(first_used_at,?), last_used_at=?, use_count=use_count+1 WHERE id=?')
      .bind(t, t, match!.code_id)
      .run();
    const token = await createStudentSession(ctx.env, match!.id, match!.code_id);
    return { token, student: { grade, classNo, number, name: candidates.results.find((c) => c.id === match!.id)!.name } };
  });

  r.post('/api/student/logout', async (ctx) => {
    const s = await requireStudent(ctx);
    await ctx.env.DB.prepare('DELETE FROM student_sessions WHERE id=?').bind(s.sessionId).run();
    return { ok: true };
  });

  /** 응시 가능한 시험 목록 */
  r.get('/api/student/exams', async (ctx) => {
    const s = await requireStudent(ctx);
    const rows = await ctx.env.DB.prepare(
      `SELECT e.id, e.title, e.description, e.status, e.start_at, e.end_at, e.duration_min, e.result_policy,
         (SELECT COUNT(*) FROM exam_version_items i WHERE i.version_id=e.current_version_id) AS item_count,
         a.id AS attempt_id, a.status AS attempt_status, a.deadline_at
       FROM exam_targets t JOIN exams e ON e.id=t.exam_id AND e.deleted_at IS NULL
       LEFT JOIN attempts a ON a.exam_id=e.id AND a.student_id=t.student_id AND a.archived=0
       WHERE t.student_id=? AND (e.status='published' OR a.id IS NOT NULL)
       ORDER BY e.start_at IS NULL, e.start_at, e.created_at DESC`,
    )
      .bind(s.studentId)
      .all<Record<string, unknown>>();
    const t = now();
    return {
      student: { name: s.name, grade: s.grade, classNo: s.classNo, number: s.number },
      serverNow: t,
      exams: rows.results.map((e) => {
        let state = 'available';
        if (e.attempt_status === 'submitted') state = 'submitted';
        else if (e.attempt_status === 'in_progress') state = (e.deadline_at as number) > t ? 'in_progress' : 'submitted';
        else if (e.status !== 'published') state = 'closed';
        else if (e.start_at && (e.start_at as number) > t) state = 'upcoming';
        else if (e.end_at && (e.end_at as number) <= t) state = 'closed';
        return {
          id: e.id,
          title: e.title,
          description: e.description,
          startAt: e.start_at,
          endAt: e.end_at,
          durationMin: e.duration_min,
          itemCount: e.item_count,
          attemptId: e.attempt_id,
          state,
        };
      }),
    };
  });

  /** 시험 시작 또는 이어서 풀기 */
  r.post('/api/student/exams/:id/start', async (ctx) => {
    const s = await requireStudent(ctx);
    const db = ctx.env.DB;
    const target = await db.prepare('SELECT 1 FROM exam_targets WHERE exam_id=? AND student_id=?').bind(ctx.params.id, s.studentId).first();
    if (!target) fail(403, '응시 대상이 아닌 시험입니다.');
    const existing = await db.prepare('SELECT * FROM attempts WHERE exam_id=? AND student_id=? AND archived=0').bind(ctx.params.id, s.studentId).first<AttemptRow>();
    if (existing) {
      if (existing.status === 'submitted') fail(409, '이미 제출한 시험입니다. 다시 볼 수 없습니다.');
      return { attemptId: existing.id };
    }
    const e = await db.prepare('SELECT * FROM exams WHERE id=? AND deleted_at IS NULL').bind(ctx.params.id).first<ExamForStudent>();
    const t = now();
    if (!e || e.status !== 'published' || !e.current_version_id) fail(403, '지금은 응시할 수 없는 시험입니다.');
    if (e!.start_at && t < e!.start_at) fail(403, '아직 시험 시작 시간이 아닙니다.');
    if (e!.end_at && t >= e!.end_at) fail(403, '시험 응시 기간이 끝났습니다.');
    const v = await db.prepare('SELECT * FROM exam_versions WHERE id=?').bind(e!.current_version_id).first<{ id: string; duration_min: number; shuffle_questions: number; total_points: number }>();
    const items = await versionItems(ctx.env, v!.id);
    const order = v!.shuffle_questions ? randomPermutation(items.length).map((i) => items[i].id) : items.map((i) => i.id);
    const tiles: Record<string, number[]> = {};
    for (const it of items) {
      if (it.snapshot.type !== 'arrange') continue;
      let perm = randomPermutation(it.snapshot.choices.length);
      // 정답 순서 그대로 보이지 않도록 다시 섞음
      for (let k = 0; k < 5 && perm.every((x, i) => x === i) && perm.length > 1; k++) perm = randomPermutation(perm.length);
      tiles[it.id] = perm;
    }
    const layout: Layout = { order, tiles };
    const deadline = Math.min(t + v!.duration_min * 60_000, e!.end_at ?? Infinity);
    const id = uid();
    try {
      await db
        .prepare(
          `INSERT INTO attempts(id,exam_id,version_id,student_id,status,layout,started_at,deadline_at,last_active_at,max_score) VALUES(?,?,?,?,'in_progress',?,?,?,?,?)`,
        )
        .bind(id, e!.id, v!.id, s.studentId, JSON.stringify(layout), t, deadline, t, v!.total_points)
        .run();
    } catch {
      // 동시에 두 번 시작한 경우: 먼저 만들어진 응시를 사용
      const again = await db.prepare('SELECT id, status FROM attempts WHERE exam_id=? AND student_id=? AND archived=0').bind(e!.id, s.studentId).first<{ id: string; status: string }>();
      if (!again) throw new Error('응시를 시작하지 못했습니다.');
      if (again.status === 'submitted') fail(409, '이미 제출한 시험입니다.');
      return { attemptId: again.id };
    }
    return { attemptId: id };
  });

  /** 응시 화면 데이터: 문항(정답 제외), 저장된 답안, 남은 시간 */
  r.get('/api/student/attempts/:id', async (ctx) => {
    await requireStudent(ctx);
    const a = await loadAttempt(ctx);
    const exam = await ctx.env.DB.prepare('SELECT title FROM exams WHERE id=?').bind(a.exam_id).first<{ title: string }>();
    const base = { attemptId: a.id, title: exam?.title ?? '', status: a.status, serverNow: now(), deadline: a.deadline_at };
    if (a.status === 'submitted') return { ...base, result: await studentResult(ctx, a) };
    const v = await ctx.env.DB.prepare('SELECT audio_play_limit FROM exam_versions WHERE id=?').bind(a.version_id).first<{ audio_play_limit: number }>();
    const answers = await ctx.env.DB.prepare('SELECT item_id, response, client_rev FROM answers WHERE attempt_id=?').bind(a.id).all();
    return { ...base, items: await studentItems(ctx, a, v?.audio_play_limit ?? 0), answers: answers.results };
  });

  /**
   * 답안 저장 (여러 개를 한 번에). 오프라인에서 쌓인 답안도 이 API로 동기화합니다.
   * client_rev가 더 큰 값만 반영해 순서가 뒤바뀐 요청이 최신 답안을 덮어쓰지 않게 합니다.
   */
  r.put('/api/student/attempts/:id/answers', async (ctx) => {
    await requireStudent(ctx);
    await rateLimit(ctx.env, `save:${ctx.params.id}`, 300, 60_000);
    const a = await loadAttempt(ctx);
    if (a.status !== 'in_progress') fail(409, '시험이 종료되어 더 이상 답안을 저장할 수 없습니다.', { status: a.status });
    const b = await readJson<{ answers?: unknown }>(ctx.req);
    if (!Array.isArray(b.answers) || b.answers.length > 200) fail(400, '답안 형식이 올바르지 않습니다.');
    const valid = new Set(
      (await ctx.env.DB.prepare('SELECT id FROM exam_version_items WHERE version_id=?').bind(a.version_id).all<{ id: string }>()).results.map((x) => x.id),
    );
    const t = now();
    const saved: string[] = [];
    const stmts = (b.answers as Record<string, unknown>[]).map((x) => {
      const itemId = str(x.itemId, '문항', 64, true);
      if (!valid.has(itemId)) fail(400, '이 시험의 문항이 아닙니다.');
      const rev = Number(x.rev) || 0;
      saved.push(itemId);
      return ctx.env.DB.prepare(
        `INSERT INTO answers(attempt_id,item_id,response,client_rev,saved_at) VALUES(?,?,?,?,?)
         ON CONFLICT(attempt_id,item_id) DO UPDATE SET response=excluded.response, client_rev=excluded.client_rev, saved_at=excluded.saved_at
         WHERE excluded.client_rev >= answers.client_rev`,
      ).bind(a.id, itemId, str(x.response, '답안', 2000), rev, t);
    });
    stmts.push(ctx.env.DB.prepare('UPDATE attempts SET last_active_at=? WHERE id=?').bind(t, a.id));
    await ctx.env.DB.batch(stmts);
    return { saved, serverNow: t, deadline: a.deadline_at };
  });

  /** 듣기 재생 요청: 재생 횟수를 서버에서 세고, 남아 있으면 짧게 유효한 음성 주소를 줍니다. */
  r.post('/api/student/attempts/:id/items/:itemId/play', async (ctx) => {
    await requireStudent(ctx);
    const a = await loadAttempt(ctx);
    if (a.status !== 'in_progress') fail(409, '시험이 종료되었습니다.', { status: a.status });
    const item = await ctx.env.DB.prepare('SELECT snapshot FROM exam_version_items WHERE id=? AND version_id=?').bind(ctx.params.itemId, a.version_id).first<{ snapshot: string }>();
    if (!item) fail(404, '문항을 찾을 수 없습니다.');
    const audioId = JSON.parse(item!.snapshot).audioMediaId as string | null;
    if (!audioId) fail(404, '이 문항에는 음성이 없습니다.');
    const v = await ctx.env.DB.prepare('SELECT audio_play_limit FROM exam_versions WHERE id=?').bind(a.version_id).first<{ audio_play_limit: number }>();
    const limit = v?.audio_play_limit ?? 0;
    const t = now();
    // 한도 안에서만 1 증가 (동시 요청에도 한도를 넘지 않음)
    const row = await ctx.env.DB.prepare(
      `INSERT INTO audio_plays(attempt_id,item_id,play_count,last_played_at) VALUES(?1,?2,1,?3)
       ON CONFLICT(attempt_id,item_id) DO UPDATE SET play_count=audio_plays.play_count+1, last_played_at=?3
       WHERE ?4=0 OR audio_plays.play_count < ?4
       RETURNING play_count`,
    )
      .bind(a.id, ctx.params.itemId, t, limit)
      .first<{ play_count: number }>();
    if (!row) fail(409, '들을 수 있는 횟수를 모두 사용했습니다.', { playsUsed: limit, playLimit: limit });
    const url = await signedMediaUrl(ctx, audioId!, a.id, t + 20 * 60_000);
    return { url, playsUsed: row!.play_count, playLimit: limit };
  });

  /** 최종 제출: 남은 답안을 함께 받아 저장한 뒤 서버에서 채점 */
  r.post('/api/student/attempts/:id/submit', async (ctx) => {
    await requireStudent(ctx);
    const a = await loadAttempt(ctx);
    if (a.status === 'submitted') return { status: 'submitted', alreadySubmitted: true, result: await studentResult(ctx, a) };
    const b = await readJson<{ answers?: Record<string, unknown>[] }>(ctx.req);
    if (Array.isArray(b.answers) && b.answers.length) {
      const valid = new Set(
        (await ctx.env.DB.prepare('SELECT id FROM exam_version_items WHERE version_id=?').bind(a.version_id).all<{ id: string }>()).results.map((x) => x.id),
      );
      const t = now();
      await ctx.env.DB.batch(
        b.answers
          .filter((x) => valid.has(String(x.itemId)))
          .slice(0, 200)
          .map((x) =>
            ctx.env.DB.prepare(
              `INSERT INTO answers(attempt_id,item_id,response,client_rev,saved_at) VALUES(?,?,?,?,?)
               ON CONFLICT(attempt_id,item_id) DO UPDATE SET response=excluded.response, client_rev=excluded.client_rev, saved_at=excluded.saved_at
               WHERE excluded.client_rev >= answers.client_rev`,
            ).bind(a.id, String(x.itemId), str(x.response, '답안', 2000), Number(x.rev) || 0, t),
          ),
      );
    }
    await finalizeAttempt(ctx.env, a, 'student');
    const done = (await ctx.env.DB.prepare('SELECT * FROM attempts WHERE id=?').bind(a.id).first<AttemptRow>())!;
    return { status: 'submitted', result: await studentResult(ctx, done) };
  });
}
