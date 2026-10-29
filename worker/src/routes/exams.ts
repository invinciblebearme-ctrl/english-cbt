import { fail, int, json, optionalTime, readJson, str, type Ctx, type Router } from '../http';
import { requireAdmin } from '../auth';
import { uid } from '../crypto';
import { audit, now } from '../db';
import { loadQuestions, toSnapshot } from './questions';
import { finalizeExpired } from '../attempts';
import type { ResultPolicy } from '../../../shared/types';

interface ExamRow {
  id: string;
  title: string;
  grade: number;
  unit: number;
  description: string;
  duration_min: number;
  audio_play_limit: number;
  shuffle_questions: number;
  start_at: number | null;
  end_at: number | null;
  result_policy: ResultPolicy;
  status: 'draft' | 'published' | 'closed';
  current_version_id: string | null;
  created_at: number;
  updated_at: number;
}

const examDto = (e: ExamRow, extra: Record<string, unknown> = {}) => ({
  id: e.id,
  title: e.title,
  grade: e.grade,
  unit: e.unit,
  description: e.description,
  durationMin: e.duration_min,
  audioPlayLimit: e.audio_play_limit,
  shuffleQuestions: !!e.shuffle_questions,
  startAt: e.start_at,
  endAt: e.end_at,
  resultPolicy: e.result_policy,
  status: e.status,
  currentVersionId: e.current_version_id,
  createdAt: e.created_at,
  updatedAt: e.updated_at,
  ...extra,
});

export async function getExam(ctx: Ctx, id: string): Promise<ExamRow> {
  const e = await ctx.env.DB.prepare('SELECT * FROM exams WHERE id=? AND deleted_at IS NULL').bind(id).first<ExamRow>();
  if (!e) fail(404, '시험을 찾을 수 없습니다.');
  return e!;
}

interface ExamSettings {
  title: string;
  grade: number;
  unit: number;
  description: string;
  durationMin: number;
  audioPlayLimit: number;
  shuffleQuestions: boolean;
  startAt: number | null;
  endAt: number | null;
  resultPolicy: ResultPolicy;
}

function parseSettings(b: Record<string, unknown>): ExamSettings {
  const policy = (b.resultPolicy || 'hidden') as ResultPolicy;
  if (!['hidden', 'score', 'review'].includes(policy)) fail(400, '결과 공개 방식이 올바르지 않습니다.');
  const s: ExamSettings = {
    title: str(b.title, '시험 제목', 100, true).trim(),
    grade: int(b.grade, '학년', 1, 6),
    unit: int(b.unit, '단원', 1, 30),
    description: str(b.description, '안내 문구', 1000),
    durationMin: int(b.durationMin ?? 40, '시험 시간', 1, 300),
    audioPlayLimit: int(b.audioPlayLimit ?? 2, '음성 재생 횟수', 0, 10),
    shuffleQuestions: !!b.shuffleQuestions,
    startAt: optionalTime(b.startAt, '시작 시간'),
    endAt: optionalTime(b.endAt, '종료 시간'),
    resultPolicy: policy,
  };
  if (s.startAt && s.endAt && s.endAt <= s.startAt) fail(400, '종료 시간은 시작 시간보다 늦어야 합니다.');
  return s;
}

function parseItems(b: Record<string, unknown>): { questionId: string; points: number }[] | null {
  if (b.items === undefined) return null;
  if (!Array.isArray(b.items) || b.items.length > 100) fail(400, '문항 목록 형식이 올바르지 않습니다.');
  const seen = new Set<string>();
  return (b.items as Record<string, unknown>[]).map((it) => {
    const questionId = str(it?.questionId, '문항', 64, true);
    if (seen.has(questionId)) fail(400, '같은 문제가 두 번 들어 있습니다.');
    seen.add(questionId);
    const points = Number(it.points);
    if (!Number.isFinite(points) || points <= 0 || points > 100) fail(400, '문항 배점은 0보다 크고 100 이하여야 합니다.');
    return { questionId, points };
  });
}

async function examItems(ctx: Ctx, examId: string) {
  return (
    await ctx.env.DB.prepare('SELECT question_id, seq, points FROM exam_items WHERE exam_id=? ORDER BY seq').bind(examId).all<{ question_id: string; seq: number; points: number }>()
  ).results;
}

async function attemptCount(ctx: Ctx, examId: string, versionId?: string | null) {
  const row = versionId
    ? await ctx.env.DB.prepare('SELECT COUNT(*) AS n FROM attempts WHERE version_id=?').bind(versionId).first<{ n: number }>()
    : await ctx.env.DB.prepare('SELECT COUNT(*) AS n FROM attempts WHERE exam_id=? AND archived=0').bind(examId).first<{ n: number }>();
  return row?.n ?? 0;
}

/** 공개 전 검사: 빈 시험, 삭제/미완성 문제, 누락 자료 */
async function publishIssues(ctx: Ctx, examId: string) {
  const items = await examItems(ctx, examId);
  const issues: { questionId: string | null; seq: number | null; messages: string[] }[] = [];
  if (!items.length) issues.push({ questionId: null, seq: null, messages: ['시험에 문제가 없습니다.'] });
  const qs = await loadQuestions(ctx, items.map((i) => i.question_id));
  const deleted = await ctx.env.DB.prepare(
    `SELECT id FROM questions WHERE deleted_at IS NOT NULL AND id IN (SELECT question_id FROM exam_items WHERE exam_id=?)`,
  )
    .bind(examId)
    .all<{ id: string }>();
  const deletedIds = new Set(deleted.results.map((d) => d.id));
  for (const it of items) {
    const q = qs.find((x) => x.id === it.question_id);
    const messages: string[] = [];
    if (!q || deletedIds.has(it.question_id)) messages.push('삭제된 문제입니다.');
    else {
      messages.push(...q.issues);
      if (q.status !== 'ready' && !q.issues.length) messages.push('임시 저장 상태입니다. 문제은행에서 \'완성\'으로 저장하세요.');
    }
    if (messages.length) issues.push({ questionId: it.question_id, seq: it.seq, messages });
  }
  return { items, qs, issues };
}

export function examRoutes(r: Router) {
  r.get('/api/admin/exams', async (ctx) => {
    await requireAdmin(ctx);
    const rows = await ctx.env.DB.prepare(
      `SELECT e.*,
        (SELECT COUNT(*) FROM exam_items i WHERE i.exam_id=e.id) AS item_count,
        (SELECT COUNT(*) FROM exam_targets t WHERE t.exam_id=e.id) AS target_count,
        (SELECT COUNT(*) FROM attempts a WHERE a.exam_id=e.id AND a.archived=0) AS attempt_count,
        (SELECT COUNT(*) FROM attempts a WHERE a.exam_id=e.id AND a.archived=0 AND a.status='submitted') AS submitted_count
       FROM exams e WHERE e.deleted_at IS NULL ORDER BY e.created_at DESC`,
    ).all<ExamRow & { item_count: number; target_count: number; attempt_count: number; submitted_count: number }>();
    return rows.results.map((e) =>
      examDto(e, { itemCount: e.item_count, targetCount: e.target_count, attemptCount: e.attempt_count, submittedCount: e.submitted_count }),
    );
  });

  r.get('/api/admin/exams/:id', async (ctx) => {
    await requireAdmin(ctx);
    const e = await getExam(ctx, ctx.params.id);
    const items = await examItems(ctx, e.id);
    const versions = await ctx.env.DB.prepare(
      `SELECT v.id, v.version_no, v.total_points, v.created_at, (SELECT COUNT(*) FROM attempts a WHERE a.version_id=v.id) AS attempt_count
       FROM exam_versions v WHERE v.exam_id=? ORDER BY v.version_no DESC`,
    )
      .bind(e.id)
      .all();
    const targets = await ctx.env.DB.prepare('SELECT student_id FROM exam_targets WHERE exam_id=?').bind(e.id).all<{ student_id: string }>();
    return examDto(e, {
      items: items.map((i) => ({ questionId: i.question_id, points: i.points })),
      versions: versions.results,
      targetStudentIds: targets.results.map((t) => t.student_id),
      attemptCount: await attemptCount(ctx, e.id),
    });
  });

  r.post('/api/admin/exams', async (ctx) => {
    await requireAdmin(ctx);
    const b = await readJson(ctx.req);
    const s = parseSettings(b);
    const items = parseItems(b) || [];
    const id = uid();
    const t = now();
    await ctx.env.DB.batch([
      ctx.env.DB.prepare(
        `INSERT INTO exams(id,title,grade,unit,description,duration_min,audio_play_limit,shuffle_questions,start_at,end_at,result_policy,status,created_by,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,'draft',?,?,?)`,
      ).bind(id, s.title, s.grade, s.unit, s.description, s.durationMin, s.audioPlayLimit, s.shuffleQuestions ? 1 : 0, s.startAt, s.endAt, s.resultPolicy, ctx.admin!.id, t, t),
      ...items.map((it, i) => ctx.env.DB.prepare('INSERT INTO exam_items(exam_id,question_id,seq,points) VALUES(?,?,?,?)').bind(id, it.questionId, i + 1, it.points)),
    ]);
    await audit(ctx, 'exam.create', 'exam', id, { title: s.title });
    return json({ id }, 201);
  });

  /**
   * 시험 수정. 공개 중에는 문항·배점·시간 등 시험 내용은 바꿀 수 없고
   * 제목, 시작/종료 시간, 결과 공개 방식만 바꿀 수 있습니다.
   */
  r.put('/api/admin/exams/:id', async (ctx) => {
    await requireAdmin(ctx);
    const e = await getExam(ctx, ctx.params.id);
    const b = await readJson(ctx.req);
    const s = parseSettings({ ...examDto(e), ...b });
    const items = parseItems(b);
    if (e.status === 'published') {
      const locked =
        s.grade !== e.grade ||
        s.unit !== e.unit ||
        s.durationMin !== e.duration_min ||
        s.audioPlayLimit !== e.audio_play_limit ||
        s.shuffleQuestions !== !!e.shuffle_questions ||
        items !== null;
      if (locked) fail(409, '공개 중인 시험은 문항·배점·시간 설정을 바꿀 수 없습니다. 먼저 비공개로 전환하세요.');
    }
    if (items) {
      const found = await loadQuestions(ctx, items.map((i) => i.questionId));
      if (found.length !== items.length) fail(400, '존재하지 않는 문제가 포함되어 있습니다.');
    }
    await ctx.env.DB.batch([
      ctx.env.DB.prepare(
        `UPDATE exams SET title=?,grade=?,unit=?,description=?,duration_min=?,audio_play_limit=?,shuffle_questions=?,start_at=?,end_at=?,result_policy=?,updated_at=? WHERE id=?`,
      ).bind(s.title, s.grade, s.unit, s.description, s.durationMin, s.audioPlayLimit, s.shuffleQuestions ? 1 : 0, s.startAt, s.endAt, s.resultPolicy, now(), e.id),
      ...(items
        ? [
            ctx.env.DB.prepare('DELETE FROM exam_items WHERE exam_id=?').bind(e.id),
            ...items.map((it, i) => ctx.env.DB.prepare('INSERT INTO exam_items(exam_id,question_id,seq,points) VALUES(?,?,?,?)').bind(e.id, it.questionId, i + 1, it.points)),
          ]
        : []),
    ]);
    await audit(ctx, 'exam.update', 'exam', e.id, { itemsChanged: !!items });
    return { ok: true };
  });

  r.get('/api/admin/exams/:id/check', async (ctx) => {
    await requireAdmin(ctx);
    await getExam(ctx, ctx.params.id);
    const { issues } = await publishIssues(ctx, ctx.params.id);
    return { ok: !issues.length, issues };
  });

  /**
   * 공개: 문항·정답을 시험 버전으로 고정합니다.
   * 현재 버전으로 응시한 학생이 있으면 새 버전을 만들고, 기존 응시는 이전 버전을 그대로 사용합니다.
   */
  r.post('/api/admin/exams/:id/publish', async (ctx) => {
    await requireAdmin(ctx);
    const e = await getExam(ctx, ctx.params.id);
    if (e.status === 'published') fail(409, '이미 공개된 시험입니다.');
    const { items, qs, issues } = await publishIssues(ctx, e.id);
    if (issues.length) fail(422, '공개할 수 없는 문제가 있습니다.', { issues });
    const targets = await ctx.env.DB.prepare('SELECT COUNT(*) AS n FROM exam_targets WHERE exam_id=?').bind(e.id).first<{ n: number }>();
    if (!targets?.n) fail(422, '응시 대상 학생을 먼저 지정하세요.', { issues: [{ questionId: null, seq: null, messages: ['응시 대상 학생이 없습니다.'] }] });

    const db = ctx.env.DB;
    const last = await db.prepare('SELECT MAX(version_no) AS v FROM exam_versions WHERE exam_id=?').bind(e.id).first<{ v: number | null }>();
    const versionId = uid();
    const total = items.reduce((s, i) => s + i.points, 0);
    const stmts = [
      db
        .prepare(
          'INSERT INTO exam_versions(id,exam_id,version_no,duration_min,audio_play_limit,shuffle_questions,total_points,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
        )
        .bind(versionId, e.id, (last?.v ?? 0) + 1, e.duration_min, e.audio_play_limit, e.shuffle_questions, total, ctx.admin!.id, now()),
      ...items.map((it) =>
        db
          .prepare('INSERT INTO exam_version_items(id,version_id,seq,question_id,points,snapshot) VALUES(?,?,?,?,?,?)')
          .bind(uid(), versionId, it.seq, it.question_id, it.points, JSON.stringify(toSnapshot(qs.find((q) => q.id === it.question_id)!))),
      ),
      db.prepare("UPDATE exams SET status='published', current_version_id=?, updated_at=? WHERE id=?").bind(versionId, now(), e.id),
    ];
    // 이전 버전에 응시 기록이 없으면 정리
    if (e.current_version_id && !(await attemptCount(ctx, e.id, e.current_version_id)))
      stmts.push(db.prepare('DELETE FROM exam_versions WHERE id=?').bind(e.current_version_id));
    await db.batch(stmts);
    await audit(ctx, 'exam.publish', 'exam', e.id, { versionId, items: items.length });
    return { ok: true, versionId };
  });

  r.post('/api/admin/exams/:id/unpublish', async (ctx) => {
    await requireAdmin(ctx);
    const e = await getExam(ctx, ctx.params.id);
    await ctx.env.DB.prepare("UPDATE exams SET status='draft', updated_at=? WHERE id=?").bind(now(), e.id).run();
    await audit(ctx, 'exam.unpublish', 'exam', e.id);
    return { ok: true };
  });

  /** 시험 종료: 응시 중인 학생도 즉시 마감·채점 */
  r.post('/api/admin/exams/:id/close', async (ctx) => {
    await requireAdmin(ctx);
    const e = await getExam(ctx, ctx.params.id);
    await ctx.env.DB.prepare("UPDATE exams SET status='closed', updated_at=? WHERE id=?").bind(now(), e.id).run();
    await finalizeExpired(ctx.env, e.id, 'teacher');
    await audit(ctx, 'exam.close', 'exam', e.id);
    return { ok: true };
  });

  r.post('/api/admin/exams/:id/duplicate', async (ctx) => {
    await requireAdmin(ctx);
    const e = await getExam(ctx, ctx.params.id);
    const items = await examItems(ctx, e.id);
    const id = uid();
    const t = now();
    await ctx.env.DB.batch([
      ctx.env.DB.prepare(
        `INSERT INTO exams(id,title,grade,unit,description,duration_min,audio_play_limit,shuffle_questions,start_at,end_at,result_policy,status,created_by,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,NULL,NULL,?,'draft',?,?,?)`,
      ).bind(id, `${e.title} (복사본)`.slice(0, 100), e.grade, e.unit, e.description, e.duration_min, e.audio_play_limit, e.shuffle_questions, e.result_policy, ctx.admin!.id, t, t),
      ...items.map((it) => ctx.env.DB.prepare('INSERT INTO exam_items(exam_id,question_id,seq,points) VALUES(?,?,?,?)').bind(id, it.question_id, it.seq, it.points)),
    ]);
    await audit(ctx, 'exam.duplicate', 'exam', id, { from: e.id });
    return json({ id }, 201);
  });

  r.delete('/api/admin/exams/:id', async (ctx) => {
    await requireAdmin(ctx);
    const e = await getExam(ctx, ctx.params.id);
    if (e.status === 'published') fail(409, '공개 중인 시험은 삭제할 수 없습니다. 먼저 비공개로 전환하세요.');
    if (await attemptCount(ctx, e.id)) {
      // 응시 기록이 있으면 성적 보존을 위해 숨김 처리만 합니다.
      await ctx.env.DB.prepare('UPDATE exams SET deleted_at=? WHERE id=?').bind(now(), e.id).run();
    } else {
      await ctx.env.DB.prepare('DELETE FROM exams WHERE id=?').bind(e.id).run();
    }
    await audit(ctx, 'exam.delete', 'exam', e.id, { title: e.title });
    return { ok: true };
  });

  /** 응시 대상 학생 지정 (전체 교체) */
  r.put('/api/admin/exams/:id/targets', async (ctx) => {
    await requireAdmin(ctx);
    const e = await getExam(ctx, ctx.params.id);
    const b = await readJson<{ studentIds?: unknown }>(ctx.req);
    if (!Array.isArray(b.studentIds) || b.studentIds.length > 2000) fail(400, '학생 목록 형식이 올바르지 않습니다.');
    const ids = [...new Set((b.studentIds as unknown[]).map((x) => str(x, '학생', 64, true)))];
    const t = now();
    const stmts = [ctx.env.DB.prepare('DELETE FROM exam_targets WHERE exam_id=?').bind(e.id)];
    for (const sid of ids)
      stmts.push(ctx.env.DB.prepare('INSERT INTO exam_targets(exam_id,student_id,added_at) SELECT ?,id,? FROM students WHERE id=?').bind(e.id, t, sid));
    await ctx.env.DB.batch(stmts);
    await audit(ctx, 'exam.targets', 'exam', e.id, { count: ids.length });
    return { ok: true, count: ids.length };
  });

  /** 미리보기: 학생 화면과 같은 형태 + 정답 (교사 전용) */
  r.get('/api/admin/exams/:id/preview', async (ctx) => {
    await requireAdmin(ctx);
    const e = await getExam(ctx, ctx.params.id);
    const items = await examItems(ctx, e.id);
    const qs = await loadQuestions(ctx, items.map((i) => i.question_id));
    return {
      exam: examDto(e),
      items: items.map((it) => ({ seq: it.seq, points: it.points, question: qs.find((q) => q.id === it.question_id) ?? null })),
    };
  });
}
