import type { QuestionInput, StudentItem } from '../../../shared/types';

export interface Question extends QuestionInput {
  id: string;
  issues: string[];
  createdAt: number;
  updatedAt: number;
}

export const mediaUrl = (id: string | null) => (id ? `/api/media/${id}` : null);

/** 교사 미리보기용: 문제 데이터를 학생 화면 형식으로 변환 */
export function toPreviewItem(q: QuestionInput, no = 1, points = q.points): StudentItem {
  return {
    itemId: 'preview',
    no,
    type: q.type,
    domain: q.domain,
    prompt: q.prompt || '(문제 내용 없음)',
    passage: q.passage,
    imageUrl: mediaUrl(q.imageMediaId),
    hasAudio: ['listen_mc', 'listen_image'].includes(q.type) || !!q.audioMediaId,
    playLimit: 0,
    playsUsed: 0,
    choices: q.type === 'arrange' ? [] : q.choices.map((c, i) => ({ no: i + 1, text: c.text, imageUrl: mediaUrl(c.mediaId) })),
    // 미리보기에서는 카드를 뒤집어 보여 줌 (실제 시험은 학생마다 무작위)
    tiles: q.type === 'arrange' ? q.choices.map((c, i) => ({ index: i, text: c.text })).reverse() : [],
    joiner: q.answer.joiner ?? '',
    points,
  };
}

export function correctChoiceOf(q: QuestionInput): string | undefined {
  if (q.type === 'ox') return q.answer.value || undefined;
  if (q.answer.choices?.length) return String(q.answer.choices[0]);
  return undefined;
}

export function answerSummary(q: QuestionInput): string {
  const a = q.answer;
  switch (q.type) {
    case 'ox':
      return a.value || '-';
    case 'short':
    case 'sentence':
      if (q.type === 'sentence' && a.mode === 'manual') return '교사 채점';
      if (q.type === 'sentence' && a.mode === 'keywords') return `필수 낱말: ${(a.keywords || []).join(', ')}`;
      return [...(a.accepted || []), ...(a.alternatives || [])].join(' / ') || '-';
    case 'arrange':
      return (a.accepted?.length ? a.accepted : [q.choices.map((c) => c.text).join(a.joiner ?? '')]).join(' / ');
    default:
      return a.choices?.length ? a.choices.map((n) => `${n}번`).join(', ') : '-';
  }
}
