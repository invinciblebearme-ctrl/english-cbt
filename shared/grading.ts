// 문제 검증과 자동 채점 (서버에서 실행되며, 프론트엔드에서는 미리보기 검사용으로만 사용)
import {
  CHOICE_TYPES,
  IMAGE_CHOICE_TYPES,
  LISTENING_TYPES,
  type AnswerKey,
  type ChoiceInput,
  type GradeOutcome,
  type QuestionType,
} from './types';

interface ValidatableQuestion {
  type: QuestionType;
  prompt: string;
  imageMediaId: string | null;
  audioMediaId: string | null;
  choices: ChoiceInput[];
  answer: AnswerKey;
  points: number;
}

/** 시험 공개 전에 누락된 자료를 찾습니다. 빈 배열이면 공개 가능. */
export function validateQuestion(q: ValidatableQuestion): string[] {
  const issues: string[] = [];
  const a = q.answer || {};
  if (!q.prompt.trim()) issues.push('문제 내용이 없습니다.');
  if (!(q.points > 0)) issues.push('배점이 0보다 커야 합니다.');
  if (LISTENING_TYPES.includes(q.type) && !q.audioMediaId) issues.push('듣기 음성 파일이 없습니다.');

  if (CHOICE_TYPES.includes(q.type)) {
    if (q.choices.length < 2) issues.push('선택지가 2개 이상 필요합니다.');
    if (IMAGE_CHOICE_TYPES.includes(q.type)) {
      q.choices.forEach((c, i) => {
        if (!c.mediaId) issues.push(`${i + 1}번 선택지 그림이 없습니다.`);
      });
    } else {
      q.choices.forEach((c, i) => {
        if (!c.text.trim() && !c.mediaId) issues.push(`${i + 1}번 선택지 내용이 없습니다.`);
      });
    }
    const picks = a.choices || [];
    if (!picks.length) issues.push('정답 선택지를 지정하세요.');
    else if (picks.some((n) => !Number.isInteger(n) || n < 1 || n > q.choices.length))
      issues.push('정답 번호가 선택지 범위를 벗어났습니다.');
  } else if (q.type === 'ox') {
    if (a.value !== 'O' && a.value !== 'X') issues.push('O 또는 X 정답을 지정하세요.');
  } else if (q.type === 'short') {
    if (!clean(a.accepted).length) issues.push('정답을 1개 이상 입력하세요.');
  } else if (q.type === 'sentence') {
    const mode = a.mode || 'exact';
    if (mode === 'exact' && !clean(a.accepted).length) issues.push('문장형 정답을 1개 이상 입력하세요.');
    if (mode === 'keywords' && !clean(a.keywords).length) issues.push('필수 낱말을 1개 이상 입력하세요.');
  } else if (q.type === 'arrange') {
    if (q.choices.filter((c) => c.text.trim()).length < 2) issues.push('배열할 카드(철자/낱말)가 2개 이상 필요합니다.');
  }
  return issues;
}

const clean = (list?: string[]) => (list || []).map((s) => s.trim()).filter(Boolean);

/** 비교용 문자열 정규화 */
export function normalizeText(s: string, a: Pick<AnswerKey, 'caseSensitive' | 'trimSpaces' | 'ignorePunctuation'>): string {
  let v = String(s ?? '').normalize('NFC').replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"');
  if (a.ignorePunctuation) v = v.replace(/[.,!?;:"]/g, ' ');
  if (a.trimSpaces !== false) v = v.trim().replace(/\s+/g, ' ');
  if (!a.caseSensitive) v = v.toLowerCase();
  return v;
}

/** 철자 배열: 학생이 고른 카드 순서("2,0,1": 화면에 섞여 보인 카드 번호)를 문장으로 바꿉니다. */
export function arrangeToText(response: string, choices: ChoiceInput[], perm: number[] | undefined, joiner = ''): string {
  if (!response.trim()) return '';
  const order = response.split(',').map((x) => Number(x));
  const parts: string[] = [];
  for (const shown of order) {
    if (!Number.isInteger(shown)) return '';
    const original = perm ? perm[shown] : shown;
    const c = choices[original];
    if (!c) return '';
    parts.push(c.text);
  }
  return parts.join(joiner);
}

/**
 * 한 문항을 채점합니다. 점수는 언제나 서버의 스냅샷 기준으로 계산합니다.
 * @param response 학생 응답 (객관식: 선택 번호, O/X: 'O'|'X', 철자 배열: 카드 순서)
 * @param perm 철자 배열에서 화면 카드 번호 → 원래 카드 번호 매핑
 */
export function gradeResponse(
  q: { type: QuestionType; choices: ChoiceInput[]; answer: AnswerKey },
  response: string | null | undefined,
  points: number,
  perm?: number[],
): GradeOutcome {
  const a = q.answer || {};
  const given = String(response ?? '');
  if (!given.trim()) return { score: 0, isCorrect: false, status: 'auto' };
  const right = (ok: boolean): GradeOutcome =>
    ok ? { score: points, isCorrect: true, status: 'auto' } : a.reviewIfIncorrect ? { score: 0, isCorrect: null, status: 'pending' } : { score: 0, isCorrect: false, status: 'auto' };

  if (CHOICE_TYPES.includes(q.type)) {
    const n = Number(given);
    return right(Number.isInteger(n) && (a.choices || []).includes(n));
  }
  if (q.type === 'ox') return right(given.trim().toUpperCase() === a.value);

  if (q.type === 'short') {
    const target = normalizeText(given, a);
    return right([...clean(a.accepted), ...clean(a.alternatives)].some((x) => normalizeText(x, a) === target));
  }

  if (q.type === 'sentence') {
    const mode = a.mode || 'exact';
    if (mode === 'manual') return { score: 0, isCorrect: null, status: 'pending' };
    const opts = { ...a, ignorePunctuation: a.ignorePunctuation ?? true };
    const target = normalizeText(given, opts);
    if (mode === 'exact') return right([...clean(a.accepted), ...clean(a.alternatives)].some((x) => normalizeText(x, opts) === target));
    const words = new Set(target.split(' '));
    const keys = clean(a.keywords).map((k) => normalizeText(k, opts));
    const hit = keys.filter((k) => (k.includes(' ') ? ` ${target} `.includes(` ${k} `) : words.has(k))).length;
    if (hit === keys.length) return right(true);
    if (a.partialCredit && hit > 0) {
      const partial = Math.round(((points * hit) / keys.length) * 100) / 100;
      return a.reviewIfIncorrect ? { score: partial, isCorrect: null, status: 'pending' } : { score: partial, isCorrect: false, status: 'auto' };
    }
    return right(false);
  }

  if (q.type === 'arrange') {
    const joiner = a.joiner ?? '';
    const text = arrangeToText(given, q.choices, perm, joiner);
    const opts = { caseSensitive: a.caseSensitive, trimSpaces: true };
    const accepted = clean(a.accepted).length ? clean(a.accepted) : [q.choices.map((c) => c.text).join(joiner)];
    return right(!!text && accepted.some((x) => normalizeText(x, opts) === normalizeText(text, opts)));
  }
  return { score: 0, isCorrect: null, status: 'pending' };
}
