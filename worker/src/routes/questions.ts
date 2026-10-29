import { fail, int, json, readJson, str, type Ctx, type Router } from '../http';
import { requireAdmin } from '../auth';
import { uid } from '../crypto';
import { audit, now, parseJson } from '../db';
import { validateQuestion } from '../../../shared/grading';
import {
  DIFFICULTIES,
  DOMAINS,
  QUESTION_TYPES,
  type AnswerKey,
  type ChoiceInput,
  type QuestionInput,
  type QuestionSnapshot,
} from '../../../shared/types';

interface QuestionRow {
  id: string;
  grade: number;
  unit: number;
  domain: QuestionInput['domain'];
  type: QuestionInput['type'];
  prompt: string;
  passage: string;
  image_media_id: string | null;
  audio_media_id: string | null;
  answer: string;
  points: number;
  difficulty: QuestionInput['difficulty'];
  explanation: string;
  status: 'draft' | 'ready';
  created_at: number;
  updated_at: number;
}

export interface QuestionDto extends QuestionInput {
  id: string;
  issues: string[];
  createdAt: number;
  updatedAt: number;
}

const strList = (v: unknown, name: string): string[] => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 50) fail(400, `${name} 형식이 올바르지 않습니다.`);
  return (v as unknown[]).map((x) => str(x, name, 500).trim()).filter(Boolean);
};

/** 요청 본문을 검증해 문제 입력값으로 만듭니다. (자료 누락은 허용: 임시 저장) */
export function parseQuestionInput(b: Record<string, unknown>): QuestionInput {
  const type = b.type as QuestionInput['type'];
  if (!QUESTION_TYPES.includes(type)) fail(400, '문제 유형이 올바르지 않습니다.');
  const domain = b.domain as QuestionInput['domain'];
  if (!DOMAINS.includes(domain)) fail(400, '평가 영역이 올바르지 않습니다.');
  const difficulty = (b.difficulty || 'medium') as QuestionInput['difficulty'];
  if (!DIFFICULTIES.includes(difficulty)) fail(400, '난이도가 올바르지 않습니다.');
  const rawChoices = Array.isArray(b.choices) ? b.choices : [];
  if (rawChoices.length > 20) fail(400, '선택지(카드)는 20개까지 입력할 수 있습니다.');
  const choices: ChoiceInput[] = rawChoices.map((c: unknown) => {
    const o = (c && typeof c === 'object' ? c : { text: c }) as Record<string, unknown>;
    return { text: str(o.text, '선택지', 300), mediaId: o.mediaId ? str(o.mediaId, '선택지 그림', 64) : null };
  });
  const a = (b.answer && typeof b.answer === 'object' ? b.answer : {}) as Record<string, unknown>;
  const answer: AnswerKey = {};
  if (Array.isArray(a.choices)) answer.choices = a.choices.map((n) => int(n, '정답 번호', 1, 20));
  if (a.value === 'O' || a.value === 'X') answer.value = a.value;
  if (a.accepted !== undefined) answer.accepted = strList(a.accepted, '정답');
  if (a.alternatives !== undefined) answer.alternatives = strList(a.alternatives, '허용 답안');
  if (a.keywords !== undefined) answer.keywords = strList(a.keywords, '필수 낱말');
  for (const k of ['caseSensitive', 'trimSpaces', 'ignorePunctuation', 'partialCredit', 'reviewIfIncorrect'] as const) {
    if (typeof a[k] === 'boolean') answer[k] = a[k] as boolean;
  }
  if (a.mode === 'exact' || a.mode === 'keywords' || a.mode === 'manual') answer.mode = a.mode;
  if (typeof a.joiner === 'string') answer.joiner = a.joiner === ' ' ? ' ' : '';

  const points = Number(b.points ?? 5);
  if (!Number.isFinite(points) || points < 0 || points > 100) fail(400, '배점은 0~100 사이로 입력하세요.');
  return {
    grade: int(b.grade, '학년', 1, 6),
    unit: int(b.unit, '단원', 1, 30),
    domain,
    type,
    prompt: str(b.prompt, '문제 내용', 2000),
    passage: str(b.passage, '지문', 4000),
    imageMediaId: b.imageMediaId ? str(b.imageMediaId, '문제 그림', 64) : null,
    audioMediaId: b.audioMediaId ? str(b.audioMediaId, '문제 음성', 64) : null,
    choices,
    answer,
    points,
    difficulty,
    explanation: str(b.explanation, '해설', 4000),
    status: b.status === 'ready' ? 'ready' : 'draft',
  };
}

/** 연결된 미디어가 실제로 있고 종류가 맞는지 확인 */
async function checkMedia(ctx: Ctx, q: QuestionInput) {
  const wanted: [string, 'image' | 'audio'][] = [];
  if (q.imageMediaId) wanted.push([q.imageMediaId, 'image']);
  if (q.audioMediaId) wanted.push([q.audioMediaId, 'audio']);
  q.choices.forEach((c) => c.mediaId && wanted.push([c.mediaId, 'image']));
  for (const [id, kind] of wanted) {
    const m = await ctx.env.DB.prepare('SELECT kind FROM media WHERE id=?').bind(id).first<{ kind: string }>();
    if (!m || m.kind !== kind) fail(400, kind === 'image' ? '연결한 그림 파일을 찾을 수 없습니다.' : '연결한 음성 파일을 찾을 수 없습니다.');
  }
}

export async function loadQuestions(ctx: Ctx, ids?: string[]): Promise<QuestionDto[]> {
  let rows: QuestionRow[];
  if (ids) {
    if (!ids.length) return [];
    const ph = ids.map(() => '?').join(',');
    rows = (await ctx.env.DB.prepare(`SELECT * FROM questions WHERE id IN (${ph})`).bind(...ids).all<QuestionRow>()).results;
  } else {
    const f = ctx.url.searchParams;
    const where = ['deleted_at IS NULL'];
    const args: unknown[] = [];
    if (f.get('grade')) (where.push('grade=?'), args.push(Number(f.get('grade'))));
    if (f.get('unit')) (where.push('unit=?'), args.push(Number(f.get('unit'))));
    if (f.get('domain')) (where.push('domain=?'), args.push(f.get('domain')));
    if (f.get('type')) (where.push('type=?'), args.push(f.get('type')));
    if (f.get('status')) (where.push('status=?'), args.push(f.get('status')));
    if (f.get('q')) {
      where.push("(prompt LIKE ? ESCAPE '\\' OR passage LIKE ? ESCAPE '\\' OR explanation LIKE ? ESCAPE '\\')");
      const like = '%' + f.get('q')!.slice(0, 100).replace(/[\\%_]/g, (c) => '\\' + c) + '%';
      args.push(like, like, like);
    }
    rows = (
      await ctx.env.DB.prepare(`SELECT * FROM questions WHERE ${where.join(' AND ')} ORDER BY grade, unit, created_at DESC LIMIT 1000`)
        .bind(...args)
        .all<QuestionRow>()
    ).results;
  }
  if (!rows.length) return [];
  const choiceRows = await ctx.env.DB.prepare(
    `SELECT question_id, seq, text, media_id FROM question_choices WHERE question_id IN (${rows.map(() => '?').join(',')}) ORDER BY seq`,
  )
    .bind(...rows.map((r) => r.id))
    .all<{ question_id: string; seq: number; text: string; media_id: string | null }>();
  const byQ = new Map<string, ChoiceInput[]>();
  for (const c of choiceRows.results) {
    if (!byQ.has(c.question_id)) byQ.set(c.question_id, []);
    byQ.get(c.question_id)!.push({ text: c.text, mediaId: c.media_id });
  }
  return rows.map((r) => {
    const q: QuestionInput = {
      grade: r.grade,
      unit: r.unit,
      domain: r.domain,
      type: r.type,
      prompt: r.prompt,
      passage: r.passage,
      imageMediaId: r.image_media_id,
      audioMediaId: r.audio_media_id,
      choices: byQ.get(r.id) || [],
      answer: parseJson<AnswerKey>(r.answer, {}),
      points: r.points,
      difficulty: r.difficulty,
      explanation: r.explanation,
      status: r.status,
    };
    return { ...q, id: r.id, issues: validateQuestion(q), createdAt: r.created_at, updatedAt: r.updated_at };
  });
}

export const toSnapshot = (q: QuestionDto): QuestionSnapshot => ({
  questionId: q.id,
  type: q.type,
  domain: q.domain,
  prompt: q.prompt,
  passage: q.passage,
  imageMediaId: q.imageMediaId,
  audioMediaId: q.audioMediaId,
  choices: q.choices,
  answer: q.answer,
  explanation: q.explanation,
});

function writeStatements(ctx: Ctx, id: string, q: QuestionInput, isNew: boolean) {
  const t = now();
  const db = ctx.env.DB;
  const stmts = [
    isNew
      ? db
          .prepare(
            `INSERT INTO questions(id,grade,unit,domain,type,prompt,passage,image_media_id,audio_media_id,answer,points,difficulty,explanation,status,created_by,updated_by,created_at,updated_at)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .bind(id, q.grade, q.unit, q.domain, q.type, q.prompt, q.passage, q.imageMediaId, q.audioMediaId, JSON.stringify(q.answer), q.points, q.difficulty, q.explanation, q.status, ctx.admin!.id, ctx.admin!.id, t, t)
      : db
          .prepare(
            `UPDATE questions SET grade=?,unit=?,domain=?,type=?,prompt=?,passage=?,image_media_id=?,audio_media_id=?,answer=?,points=?,difficulty=?,explanation=?,status=?,updated_by=?,updated_at=?
             WHERE id=? AND deleted_at IS NULL`,
          )
          .bind(q.grade, q.unit, q.domain, q.type, q.prompt, q.passage, q.imageMediaId, q.audioMediaId, JSON.stringify(q.answer), q.points, q.difficulty, q.explanation, q.status, ctx.admin!.id, t, id),
    db.prepare('DELETE FROM question_choices WHERE question_id=?').bind(id),
    ...q.choices.map((c, i) => db.prepare('INSERT INTO question_choices(id,question_id,seq,text,media_id) VALUES(?,?,?,?,?)').bind(uid(), id, i + 1, c.text, c.mediaId)),
  ];
  return stmts;
}

export function questionRoutes(r: Router) {
  r.get('/api/admin/questions', async (ctx) => {
    await requireAdmin(ctx);
    return loadQuestions(ctx);
  });

  r.get('/api/admin/questions/:id', async (ctx) => {
    await requireAdmin(ctx);
    const [q] = await loadQuestions(ctx, [ctx.params.id]);
    if (!q) fail(404, '문제를 찾을 수 없습니다.');
    return q;
  });

  r.post('/api/admin/questions', async (ctx) => {
    await requireAdmin(ctx);
    const q = parseQuestionInput(await readJson(ctx.req));
    await checkMedia(ctx, q);
    const id = uid();
    await ctx.env.DB.batch(writeStatements(ctx, id, q, true));
    await audit(ctx, 'question.create', 'question', id, { status: q.status });
    const [saved] = await loadQuestions(ctx, [id]);
    return json(saved, 201);
  });

  r.put('/api/admin/questions/:id', async (ctx) => {
    await requireAdmin(ctx);
    const exists = await ctx.env.DB.prepare('SELECT 1 FROM questions WHERE id=? AND deleted_at IS NULL').bind(ctx.params.id).first();
    if (!exists) fail(404, '문제를 찾을 수 없습니다.');
    const q = parseQuestionInput(await readJson(ctx.req));
    await checkMedia(ctx, q);
    await ctx.env.DB.batch(writeStatements(ctx, ctx.params.id, q, false));
    await audit(ctx, 'question.update', 'question', ctx.params.id, { status: q.status });
    const [saved] = await loadQuestions(ctx, [ctx.params.id]);
    return saved;
  });

  r.post('/api/admin/questions/:id/duplicate', async (ctx) => {
    await requireAdmin(ctx);
    const [src] = await loadQuestions(ctx, [ctx.params.id]);
    if (!src) fail(404, '문제를 찾을 수 없습니다.');
    const id = uid();
    await ctx.env.DB.batch(writeStatements(ctx, id, { ...src, status: 'draft' }, true));
    await audit(ctx, 'question.duplicate', 'question', id, { from: src.id });
    const [saved] = await loadQuestions(ctx, [id]);
    return json(saved, 201);
  });

  /** 삭제: 이미 공개된 시험 버전에는 스냅샷이 남아 있으므로 문제은행에서만 숨깁니다. */
  r.delete('/api/admin/questions/:id', async (ctx) => {
    await requireAdmin(ctx);
    const used = await ctx.env.DB.prepare(
      `SELECT e.title FROM exam_items i JOIN exams e ON e.id=i.exam_id WHERE i.question_id=? AND e.deleted_at IS NULL AND e.status='draft' LIMIT 1`,
    )
      .bind(ctx.params.id)
      .first<{ title: string }>();
    if (used) fail(409, `편집 중인 시험 「${used.title}」에 포함된 문제입니다. 시험에서 먼저 빼 주세요.`);
    const res = await ctx.env.DB.prepare('UPDATE questions SET deleted_at=? WHERE id=? AND deleted_at IS NULL').bind(now(), ctx.params.id).run();
    if (!res.meta.changes) fail(404, '문제를 찾을 수 없습니다.');
    await audit(ctx, 'question.delete', 'question', ctx.params.id);
    return { ok: true };
  });
}
