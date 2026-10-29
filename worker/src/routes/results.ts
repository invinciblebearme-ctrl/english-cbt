import { fail, readJson, str, type Router } from '../http';
import { requireAdmin } from '../auth';
import { audit, now, parseJson } from '../db';
import { finalizeAttempt, finalizeExpired, recomputeTotal, versionItems, type AttemptRow, type Layout } from '../attempts';
import { getExam } from './exams';
import { arrangeToText } from '../../../shared/grading';

export function resultRoutes(r: Router) {
  r.get('/api/admin/dashboard', async (ctx) => {
    await requireAdmin(ctx);
    await finalizeExpired(ctx.env);
    const db = ctx.env.DB;
    const t = now();
    const [q, e, s, live, done, recent, pending] = await db.batch([
      db.prepare('SELECT COUNT(*) AS n, SUM(CASE WHEN status=\'draft\' THEN 1 ELSE 0 END) AS drafts FROM questions WHERE deleted_at IS NULL'),
      db.prepare('SELECT COUNT(*) AS n FROM exams WHERE deleted_at IS NULL'),
      db.prepare('SELECT COUNT(*) AS n FROM students WHERE active=1'),
      db.prepare(
        `SELECT e.id, e.title, e.end_at,
           (SELECT COUNT(*) FROM exam_targets t WHERE t.exam_id=e.id) AS targets,
           (SELECT COUNT(*) FROM attempts a WHERE a.exam_id=e.id AND a.archived=0 AND a.status='in_progress') AS in_progress,
           (SELECT COUNT(*) FROM attempts a WHERE a.exam_id=e.id AND a.archived=0 AND a.status='submitted') AS submitted
         FROM exams e WHERE e.deleted_at IS NULL AND e.status='published' AND (e.start_at IS NULL OR e.start_at<=?1) AND (e.end_at IS NULL OR e.end_at>?1)
         ORDER BY e.created_at DESC`,
      ).bind(t),
      db.prepare("SELECT COUNT(DISTINCT student_id) AS n FROM attempts WHERE status='submitted' AND archived=0"),
      db.prepare(
        `SELECT a.id, a.total_score, a.max_score, a.submitted_at, a.grading_status, e.title, s.name, s.number, c.grade, c.class_no
         FROM attempts a JOIN exams e ON e.id=a.exam_id JOIN students s ON s.id=a.student_id JOIN classes c ON c.id=s.class_id
         WHERE a.status='submitted' AND a.archived=0 ORDER BY a.submitted_at DESC LIMIT 10`,
      ),
      db.prepare("SELECT COUNT(*) AS n FROM grading_results g JOIN attempts a ON a.id=g.attempt_id WHERE g.status='pending' AND a.archived=0"),
    ]);
    const first = (x: D1Result) => (x.results[0] || {}) as Record<string, number>;
    return {
      questionCount: first(q).n ?? 0,
      draftQuestionCount: first(q).drafts ?? 0,
      examCount: first(e).n ?? 0,
      studentCount: first(s).n ?? 0,
      liveExams: live.results,
      submittedStudentCount: first(done).n ?? 0,
      pendingGradingCount: first(pending).n ?? 0,
      recentResults: recent.results,
    };
  });

  /** 시험 성적 전체: 통계, 학생별 점수·정오, 문항별 정답률, 미응시·응시 중 목록 */
  r.get('/api/admin/exams/:id/results', async (ctx) => {
    await requireAdmin(ctx);
    const exam = await getExam(ctx, ctx.params.id);
    await finalizeExpired(ctx.env, exam.id);
    const db = ctx.env.DB;
    const [targets, attempts, grades] = await db.batch([
      db
        .prepare(
          `SELECT s.id, s.name, s.number, c.grade, c.class_no FROM exam_targets t JOIN students s ON s.id=t.student_id JOIN classes c ON c.id=s.class_id
           WHERE t.exam_id=? ORDER BY c.grade, c.class_no, s.number`,
        )
        .bind(exam.id),
      db
        .prepare(
          `SELECT a.id, a.student_id, a.version_id, a.status, a.started_at, a.deadline_at, a.submitted_at, a.submit_reason, a.total_score, a.max_score, a.grading_status,
             s.name, s.number, c.grade, c.class_no
           FROM attempts a JOIN students s ON s.id=a.student_id JOIN classes c ON c.id=s.class_id
           WHERE a.exam_id=? AND a.archived=0 ORDER BY c.grade, c.class_no, s.number`,
        )
        .bind(exam.id),
      db
        .prepare(
          `SELECT g.attempt_id, g.item_id, COALESCE(g.manual_score, g.auto_score) AS score, g.max_score, g.is_correct, g.status
           FROM grading_results g JOIN attempts a ON a.id=g.attempt_id WHERE a.exam_id=? AND a.archived=0`,
        )
        .bind(exam.id),
    ]);
    type A = { id: string; student_id: string; version_id: string; status: string; total_score: number | null; [k: string]: unknown };
    const atts = attempts.results as A[];
    const versionIds = [...new Set(atts.map((a) => a.version_id).concat(exam.current_version_id ? [exam.current_version_id] : []))];
    const itemsByVersion: Record<string, { itemId: string; seq: number; points: number; prompt: string; type: string; questionId: string }[]> = {};
    for (const v of versionIds)
      itemsByVersion[v] = (await versionItems(ctx.env, v)).map((it) => ({
        itemId: it.id,
        seq: it.seq,
        points: it.points,
        prompt: it.snapshot.prompt,
        type: it.snapshot.type,
        questionId: it.snapshot.questionId,
      }));

    const gradesByAttempt = new Map<string, Record<string, unknown>[]>();
    for (const g of grades.results as Record<string, unknown>[]) {
      const k = g.attempt_id as string;
      if (!gradesByAttempt.has(k)) gradesByAttempt.set(k, []);
      gradesByAttempt.get(k)!.push(g);
    }

    // 문항별 정답률 (문항 번호 기준으로 버전을 합산)
    const itemStats = new Map<number, { seq: number; prompt: string; type: string; points: number; answered: number; correct: number; scoreSum: number; pending: number }>();
    for (const a of atts.filter((x) => x.status === 'submitted')) {
      const items = itemsByVersion[a.version_id] || [];
      for (const g of gradesByAttempt.get(a.id) || []) {
        const it = items.find((i) => i.itemId === g.item_id);
        if (!it) continue;
        const st = itemStats.get(it.seq) || { seq: it.seq, prompt: it.prompt, type: it.type, points: it.points, answered: 0, correct: 0, scoreSum: 0, pending: 0 };
        st.answered++;
        if (g.is_correct === 1) st.correct++;
        if (g.status === 'pending') st.pending++;
        st.scoreSum += Number(g.score) || 0;
        itemStats.set(it.seq, st);
      }
    }

    const scores = atts.filter((a) => a.status === 'submitted' && a.total_score !== null).map((a) => Number(a.total_score));
    const attempted = new Set(atts.map((a) => a.student_id));
    const round = (n: number) => Math.round(n * 10) / 10;
    return {
      exam: { id: exam.id, title: exam.title, status: exam.status, resultPolicy: exam.result_policy, grade: exam.grade, unit: exam.unit },
      items: exam.current_version_id ? itemsByVersion[exam.current_version_id] : [],
      itemsByVersion,
      stats: {
        targetCount: targets.results.length,
        submittedCount: scores.length,
        inProgressCount: atts.filter((a) => a.status === 'in_progress').length,
        notStartedCount: targets.results.filter((t) => !attempted.has((t as { id: string }).id)).length,
        average: scores.length ? round(scores.reduce((s, x) => s + x, 0) / scores.length) : null,
        max: scores.length ? Math.max(...scores) : null,
        min: scores.length ? Math.min(...scores) : null,
        pendingGrading: atts.filter((a) => a.grading_status === 'pending').length,
      },
      itemStats: [...itemStats.values()]
        .sort((a, b) => a.seq - b.seq)
        .map((s) => ({ ...s, correctRate: s.answered ? round((s.correct / s.answered) * 100) : null, avgScore: s.answered ? round(s.scoreSum / s.answered) : null })),
      attempts: atts.map((a) => ({ ...a, grades: gradesByAttempt.get(a.id) || [] })),
      notStarted: targets.results.filter((t) => !attempted.has((t as { id: string }).id)),
      inProgress: atts.filter((a) => a.status === 'in_progress'),
    };
  });

  /** 학생 한 명의 정오표 (응답·정답·해설 포함, 교사 전용) */
  r.get('/api/admin/attempts/:id', async (ctx) => {
    await requireAdmin(ctx);
    const a = await ctx.env.DB.prepare(
      `SELECT a.*, s.name, s.number, c.grade, c.class_no, e.title FROM attempts a JOIN students s ON s.id=a.student_id JOIN classes c ON c.id=s.class_id
       JOIN exams e ON e.id=a.exam_id WHERE a.id=?`,
    )
      .bind(ctx.params.id)
      .first<AttemptRow & Record<string, unknown>>();
    if (!a) fail(404, '응시 기록을 찾을 수 없습니다.');
    const items = await versionItems(ctx.env, a!.version_id);
    const layout = parseJson<Layout>(a!.layout, { order: [], tiles: {} });
    const [answers, grades, plays] = await ctx.env.DB.batch([
      ctx.env.DB.prepare('SELECT item_id, response, saved_at FROM answers WHERE attempt_id=?').bind(a!.id),
      ctx.env.DB.prepare('SELECT * FROM grading_results WHERE attempt_id=?').bind(a!.id),
      ctx.env.DB.prepare('SELECT item_id, play_count FROM audio_plays WHERE attempt_id=?').bind(a!.id),
    ]);
    const find = <T>(rows: T[], id: string) => rows.find((x) => (x as { item_id: string }).item_id === id);
    return {
      attempt: a,
      items: items.map((it) => {
        const ans = find(answers.results as { item_id: string; response: string; saved_at: number }[], it.id);
        const raw = ans?.response ?? '';
        const display = it.snapshot.type === 'arrange' ? arrangeToText(raw, it.snapshot.choices, layout.tiles[it.id], it.snapshot.answer.joiner ?? '') : raw;
        return {
          itemId: it.id,
          seq: it.seq,
          points: it.points,
          question: it.snapshot,
          response: raw,
          responseText: display,
          savedAt: ans?.saved_at ?? null,
          plays: (find(plays.results as { item_id: string; play_count: number }[], it.id)?.play_count as number) ?? 0,
          grade: find(grades.results, it.id) ?? null,
        };
      }),
    };
  });

  /** 수동 채점 */
  r.put('/api/admin/attempts/:id/grades/:itemId', async (ctx) => {
    await requireAdmin(ctx);
    const b = await readJson<{ score?: unknown; feedback?: unknown }>(ctx.req);
    const g = await ctx.env.DB.prepare(
      "SELECT g.max_score FROM grading_results g JOIN attempts a ON a.id=g.attempt_id WHERE g.attempt_id=? AND g.item_id=? AND a.status='submitted'",
    )
      .bind(ctx.params.id, ctx.params.itemId)
      .first<{ max_score: number }>();
    if (!g) fail(404, '채점할 답안을 찾을 수 없습니다.');
    const score = Number(b.score);
    if (!Number.isFinite(score) || score < 0 || score > g!.max_score) fail(400, `점수는 0~${g!.max_score} 사이로 입력하세요.`);
    await ctx.env.DB.prepare(
      "UPDATE grading_results SET manual_score=?, is_correct=?, status='manual', feedback=?, graded_by=?, graded_at=? WHERE attempt_id=? AND item_id=?",
    )
      .bind(score, score >= g!.max_score ? 1 : 0, str(b.feedback, '메모', 500), ctx.admin!.id, now(), ctx.params.id, ctx.params.itemId)
      .run();
    await recomputeTotal(ctx.env, ctx.params.id);
    await audit(ctx, 'grade.manual', 'attempt', ctx.params.id, { itemId: ctx.params.itemId, score });
    return { ok: true };
  });

  /** 교사가 응시를 강제 마감 */
  r.post('/api/admin/attempts/:id/force-submit', async (ctx) => {
    await requireAdmin(ctx);
    const a = await ctx.env.DB.prepare('SELECT * FROM attempts WHERE id=?').bind(ctx.params.id).first<AttemptRow>();
    if (!a) fail(404, '응시 기록을 찾을 수 없습니다.');
    const done = await finalizeAttempt(ctx.env, a!, 'teacher');
    await audit(ctx, 'attempt.force_submit', 'attempt', a!.id);
    return { ok: true, finalized: done };
  });

  /** 재응시 허용: 기존 응시는 보관(archived)하고 새로 응시할 수 있게 함 */
  r.post('/api/admin/attempts/:id/reset', async (ctx) => {
    await requireAdmin(ctx);
    const a = await ctx.env.DB.prepare('SELECT id, status, total_score FROM attempts WHERE id=? AND archived=0').bind(ctx.params.id).first<{ id: string; status: string; total_score: number | null }>();
    if (!a) fail(404, '응시 기록을 찾을 수 없습니다.');
    await ctx.env.DB.prepare("UPDATE attempts SET archived=1, status='submitted', submit_reason=COALESCE(submit_reason,'teacher') WHERE id=?").bind(a!.id).run();
    await audit(ctx, 'attempt.reset', 'attempt', a!.id, { previousStatus: a!.status, previousScore: a!.total_score });
    return { ok: true };
  });
}
