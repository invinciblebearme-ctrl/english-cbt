import type { Env } from './env';
import type { Ctx } from './http';
import { now, parseJson } from './db';
import { signedMediaUrl } from './media';
import { gradeResponse } from '../../shared/grading';
import type { QuestionSnapshot, StudentItem } from '../../shared/types';

export interface AttemptRow {
  id: string;
  exam_id: string;
  version_id: string;
  student_id: string;
  status: 'in_progress' | 'submitted';
  layout: string;
  started_at: number;
  deadline_at: number;
  submitted_at: number | null;
  submit_reason: string | null;
  total_score: number | null;
  max_score: number;
  grading_status: 'none' | 'pending' | 'complete';
}

/** 응시별 화면 배치: 문항 순서와 철자 배열 카드 섞기 */
export interface Layout {
  order: string[];
  tiles: Record<string, number[]>;
}

export interface VersionItem {
  id: string;
  seq: number;
  points: number;
  snapshot: QuestionSnapshot;
}

export async function versionItems(env: Env, versionId: string): Promise<VersionItem[]> {
  const rows = await env.DB.prepare('SELECT id, seq, points, snapshot FROM exam_version_items WHERE version_id=? ORDER BY seq')
    .bind(versionId)
    .all<{ id: string; seq: number; points: number; snapshot: string }>();
  return rows.results.map((r) => ({ id: r.id, seq: r.seq, points: r.points, snapshot: JSON.parse(r.snapshot) }));
}

/**
 * 응시를 마감하고 서버 스냅샷 기준으로 채점합니다.
 * 이미 제출된 응시는 다시 채점하지 않습니다(중복 제출 방지).
 */
export async function finalizeAttempt(env: Env, attempt: AttemptRow, reason: 'student' | 'timeout' | 'teacher'): Promise<boolean> {
  const t = now();
  // 먼저 상태를 잠가 동시에 들어온 제출 요청 중 하나만 채점하도록 함
  const lock = await env.DB.prepare("UPDATE attempts SET status='submitted', submitted_at=?, submit_reason=? WHERE id=? AND status='in_progress'")
    .bind(Math.min(t, attempt.deadline_at + 60_000), reason, attempt.id)
    .run();
  if (!lock.meta.changes) return false;

  const items = await versionItems(env, attempt.version_id);
  const layout = parseJson<Layout>(attempt.layout, { order: [], tiles: {} });
  const answers = await env.DB.prepare('SELECT item_id, response FROM answers WHERE attempt_id=?').bind(attempt.id).all<{ item_id: string; response: string }>();
  const byItem = new Map(answers.results.map((a) => [a.item_id, a.response]));
  let total = 0;
  let pending = false;
  const stmts = items.map((it) => {
    const g = gradeResponse(it.snapshot, byItem.get(it.id), it.points, layout.tiles[it.id]);
    total += g.score;
    if (g.status === 'pending') pending = true;
    return env.DB.prepare(
      `INSERT INTO grading_results(attempt_id,item_id,auto_score,max_score,is_correct,status,graded_at) VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(attempt_id,item_id) DO UPDATE SET auto_score=excluded.auto_score, max_score=excluded.max_score, is_correct=excluded.is_correct, status=excluded.status, graded_at=excluded.graded_at`,
    ).bind(attempt.id, it.id, g.score, it.points, g.isCorrect === null ? null : g.isCorrect ? 1 : 0, g.status, t);
  });
  stmts.push(
    env.DB.prepare('UPDATE attempts SET total_score=?, grading_status=? WHERE id=?').bind(Math.round(total * 100) / 100, pending ? 'pending' : 'complete', attempt.id),
  );
  await env.DB.batch(stmts);
  return true;
}

/** 수동 채점 후 총점 다시 계산 */
export async function recomputeTotal(env: Env, attemptId: string) {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(COALESCE(manual_score, auto_score)),0) AS total, SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending
     FROM grading_results WHERE attempt_id=?`,
  )
    .bind(attemptId)
    .first<{ total: number; pending: number }>();
  await env.DB.prepare('UPDATE attempts SET total_score=?, grading_status=? WHERE id=?')
    .bind(Math.round((row?.total ?? 0) * 100) / 100, row?.pending ? 'pending' : 'complete', attemptId)
    .run();
}

/** 시간이 지난 응시(또는 지정한 시험의 모든 진행 중 응시)를 마감 */
export async function finalizeExpired(env: Env, examId?: string, reason: 'timeout' | 'teacher' = 'timeout') {
  const rows = examId
    ? reason === 'teacher'
      ? await env.DB.prepare("SELECT * FROM attempts WHERE exam_id=? AND status='in_progress'").bind(examId).all<AttemptRow>()
      : await env.DB.prepare("SELECT * FROM attempts WHERE exam_id=? AND status='in_progress' AND deadline_at<?").bind(examId, now()).all<AttemptRow>()
    : await env.DB.prepare("SELECT * FROM attempts WHERE status='in_progress' AND deadline_at<? LIMIT 200").bind(now()).all<AttemptRow>();
  for (const a of rows.results) await finalizeAttempt(env, a, reason);
  return rows.results.length;
}

/** 학생에게 보낼 문항 목록 (정답·해설 제외, 그림은 서명 URL) */
export async function studentItems(ctx: Ctx, attempt: AttemptRow, playLimit: number): Promise<StudentItem[]> {
  const items = await versionItems(ctx.env, attempt.version_id);
  const layout = parseJson<Layout>(attempt.layout, { order: [], tiles: {} });
  const plays = await ctx.env.DB.prepare('SELECT item_id, play_count FROM audio_plays WHERE attempt_id=?').bind(attempt.id).all<{ item_id: string; play_count: number }>();
  const playMap = new Map(plays.results.map((p) => [p.item_id, p.play_count]));
  const exp = attempt.deadline_at + 30 * 60_000;
  const sign = (id: string | null) => (id ? signedMediaUrl(ctx, id, attempt.id, exp) : Promise.resolve(null));
  const ordered = layout.order.length ? layout.order.map((id) => items.find((i) => i.id === id)!).filter(Boolean) : items;

  return Promise.all(
    ordered.map(async (it, idx): Promise<StudentItem> => {
      const s = it.snapshot;
      const isArrange = s.type === 'arrange';
      const perm = layout.tiles[it.id] || s.choices.map((_, i) => i);
      return {
        itemId: it.id,
        no: idx + 1,
        type: s.type,
        domain: s.domain,
        prompt: s.prompt,
        passage: s.passage,
        imageUrl: await sign(s.imageMediaId),
        hasAudio: !!s.audioMediaId,
        playLimit,
        playsUsed: playMap.get(it.id) ?? 0,
        choices: isArrange ? [] : await Promise.all(s.choices.map(async (c, i) => ({ no: i + 1, text: c.text, imageUrl: await sign(c.mediaId) }))),
        tiles: isArrange ? perm.map((orig, shown) => ({ index: shown, text: s.choices[orig].text })) : [],
        joiner: isArrange ? (s.answer.joiner ?? '') : '',
        points: it.points,
      };
    }),
  );
}
