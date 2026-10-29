import { useMemo, useState } from 'react';
import {
  CHOICE_TYPES,
  DIFFICULTIES,
  DIFFICULTY_LABELS,
  DOMAINS,
  IMAGE_CHOICE_TYPES,
  LISTENING_TYPES,
  QUESTION_TYPES,
  QUESTION_TYPE_LABELS,
  type AnswerKey,
  type QuestionInput,
  type QuestionType,
} from '../../../shared/types';
import { validateQuestion } from '../../../shared/grading';
import { adminApi, errorMessage } from '../lib/api';
import { Alert, Button, Field, Modal, cx, inputClass } from '../components/ui';
import QuestionView from '../components/QuestionView';
import MediaPicker from './MediaPicker';
import { correctChoiceOf, toPreviewItem, type Question } from './types';

export const emptyQuestion = (over: Partial<QuestionInput> = {}): QuestionInput => ({
  grade: 4,
  unit: 1,
  domain: '읽기',
  type: 'mc_text',
  prompt: '',
  passage: '',
  imageMediaId: null,
  audioMediaId: null,
  choices: [
    { text: '', mediaId: null },
    { text: '', mediaId: null },
    { text: '', mediaId: null },
    { text: '', mediaId: null },
  ],
  answer: {},
  points: 5,
  difficulty: 'medium',
  explanation: '',
  status: 'draft',
  ...over,
});

const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);

export default function QuestionEditor({ initial, onClose, onSaved }: { initial: Question | QuestionInput; onClose: () => void; onSaved: (q: Question) => void }) {
  const id = 'id' in initial ? initial.id : null;
  const [q, setQ] = useState<QuestionInput>(() => ({ ...initial }));
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const issues = useMemo(() => validateQuestion(q), [q]);

  const set = <K extends keyof QuestionInput>(k: K, v: QuestionInput[K]) => setQ((p) => ({ ...p, [k]: v }));
  const setA = (patch: Partial<AnswerKey>) => setQ((p) => ({ ...p, answer: { ...p.answer, ...patch } }));
  const isChoice = CHOICE_TYPES.includes(q.type);
  const isImageChoice = IMAGE_CHOICE_TYPES.includes(q.type);

  function changeType(t: QuestionType) {
    setQ((p) => {
      const next = { ...p, type: t };
      if (LISTENING_TYPES.includes(t)) next.domain = '듣기';
      if ((CHOICE_TYPES.includes(t) || t === 'arrange') && p.choices.length < 2) next.choices = emptyQuestion().choices;
      return next;
    });
  }

  async function save(status: 'draft' | 'ready') {
    setError('');
    if (status === 'ready' && issues.length) return setError('완성으로 저장하려면 아래 누락 항목을 먼저 채우세요.\n자료가 아직 없으면 「임시 저장」을 사용하세요.');
    setBusy(status);
    try {
      const body = { ...q, status, choices: isChoice || q.type === 'arrange' ? q.choices : [] };
      const saved = id ? await adminApi.put<Question>(`/api/admin/questions/${id}`, body) : await adminApi.post<Question>('/api/admin/questions', body);
      onSaved(saved);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy('');
    }
  }

  const moveChoice = (i: number, d: number) => {
    const c = [...q.choices];
    const j = i + d;
    if (j < 0 || j >= c.length) return;
    [c[i], c[j]] = [c[j], c[i]];
    // 정답 번호도 함께 이동
    const picks = (q.answer.choices || []).map((n) => (n === i + 1 ? j + 1 : n === j + 1 ? i + 1 : n));
    setQ((p) => ({ ...p, choices: c, answer: { ...p.answer, choices: picks } }));
  };
  const removeChoice = (i: number) => {
    const picks = (q.answer.choices || []).filter((n) => n !== i + 1).map((n) => (n > i + 1 ? n - 1 : n));
    setQ((p) => ({ ...p, choices: p.choices.filter((_, k) => k !== i), answer: { ...p.answer, choices: picks } }));
  };

  return (
    <Modal
      wide
      title={id ? '문제 수정' : '새 문제 등록'}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={() => setPreview(!preview)}>
            {preview ? '편집으로 돌아가기' : '👁 학생 화면 미리보기'}
          </Button>
          <Button variant="secondary" onClick={() => save('draft')} loading={busy === 'draft'}>
            임시 저장
          </Button>
          <Button onClick={() => save('ready')} loading={busy === 'ready'}>
            완성으로 저장
          </Button>
        </>
      }
    >
      {preview ? (
        <div className="rounded-2xl bg-slate-50 p-6">
          <QuestionView
            item={toPreviewItem(q)}
            value=""
            onChange={() => {}}
            correctChoice={correctChoiceOf(q)}
            audio={q.audioMediaId ? <audio controls src={`/api/media/${q.audioMediaId}`} className="w-full" /> : <Alert kind="warning">음성 파일이 아직 없습니다.</Alert>}
          />
          <p className="mt-4 text-sm text-slate-500">초록 테두리는 정답 표시입니다(교사 미리보기에서만 보임).</p>
        </div>
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
            <Field label="학년">
              {(i) => (
                <select id={i} className={inputClass} value={q.grade} onChange={(e) => set('grade', Number(e.target.value))}>
                  {[1, 2, 3, 4, 5, 6].map((g) => (
                    <option key={g} value={g}>
                      {g}학년
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="단원">{(i) => <input id={i} type="number" min={1} max={30} className={inputClass} value={q.unit} onChange={(e) => set('unit', Number(e.target.value))} />}</Field>
            <Field label="평가 영역">
              {(i) => (
                <select id={i} className={inputClass} value={q.domain} onChange={(e) => set('domain', e.target.value as QuestionInput['domain'])}>
                  {DOMAINS.map((d) => (
                    <option key={d}>{d}</option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="문제 유형" className="col-span-2 md:col-span-1">
              {(i) => (
                <select id={i} className={inputClass} value={q.type} onChange={(e) => changeType(e.target.value as QuestionType)}>
                  {QUESTION_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {QUESTION_TYPE_LABELS[t]}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="배점">{(i) => <input id={i} type="number" min={0} max={100} step={0.5} className={inputClass} value={q.points} onChange={(e) => set('points', Number(e.target.value))} />}</Field>
            <Field label="난이도">
              {(i) => (
                <select id={i} className={inputClass} value={q.difficulty} onChange={(e) => set('difficulty', e.target.value as QuestionInput['difficulty'])}>
                  {DIFFICULTIES.map((d) => (
                    <option key={d} value={d}>
                      {DIFFICULTY_LABELS[d]}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>

          <Field label="문제 내용 (발문)">
            {(i) => <textarea id={i} rows={2} className={inputClass + ' text-lg'} value={q.prompt} onChange={(e) => set('prompt', e.target.value)} placeholder="예: 대화를 듣고 알맞은 그림을 고르세요." />}
          </Field>
          <Field label="지문 / 보기 (선택)" hint="읽기 지문, 대화문 등. 비워 두면 표시하지 않습니다.">
            {(i) => <textarea id={i} rows={2} className={inputClass} value={q.passage} onChange={(e) => set('passage', e.target.value)} />}
          </Field>

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <div className="mb-1 text-sm font-semibold text-slate-700">문제 그림 (선택)</div>
              <MediaPicker kind="image" value={q.imageMediaId} onChange={(v) => set('imageMediaId', v)} label="문제" />
            </div>
            <div>
              <div className="mb-1 text-sm font-semibold text-slate-700">문제 음성 {LISTENING_TYPES.includes(q.type) ? <span className="text-red-600">(듣기 문제 필수)</span> : '(선택)'}</div>
              <MediaPicker kind="audio" value={q.audioMediaId} onChange={(v) => set('audioMediaId', v)} label="문제" />
            </div>
          </div>

          {isChoice && (
            <fieldset className="space-y-2">
              <legend className="mb-1 text-sm font-semibold text-slate-700">선택지와 정답 (정답에 체크)</legend>
              <div className={cx('grid gap-3', isImageChoice ? 'grid-cols-2 md:grid-cols-4' : 'grid-cols-1')}>
                {q.choices.map((c, i) => {
                  const checked = (q.answer.choices || []).includes(i + 1);
                  return (
                    <div key={i} className={cx('rounded-xl border-2 p-3', checked ? 'border-emerald-500 bg-emerald-50' : 'border-slate-200')}>
                      <div className="flex items-center gap-2">
                        <label className="flex shrink-0 items-center gap-1.5 font-bold">
                          <input type="radio" name="correct" checked={checked} onChange={() => setA({ choices: [i + 1] })} className="h-5 w-5" />
                          {i + 1}번
                        </label>
                        {!isImageChoice && (
                          <input className={inputClass} value={c.text} onChange={(e) => set('choices', q.choices.map((x, k) => (k === i ? { ...x, text: e.target.value } : x)))} aria-label={`${i + 1}번 선택지`} />
                        )}
                        <div className="ml-auto flex shrink-0">
                          <button type="button" className="px-1.5 text-slate-500 hover:text-slate-900" onClick={() => moveChoice(i, -1)} aria-label="위로">
                            ↑
                          </button>
                          <button type="button" className="px-1.5 text-slate-500 hover:text-slate-900" onClick={() => moveChoice(i, 1)} aria-label="아래로">
                            ↓
                          </button>
                          <button type="button" className="px-1.5 text-red-500 hover:text-red-700" onClick={() => removeChoice(i)} aria-label="삭제">
                            ✕
                          </button>
                        </div>
                      </div>
                      {isImageChoice && (
                        <div className="mt-2 space-y-2">
                          <MediaPicker compact kind="image" value={c.mediaId} onChange={(v) => set('choices', q.choices.map((x, k) => (k === i ? { ...x, mediaId: v } : x)))} label={`${i + 1}번 선택지`} />
                          <input
                            className={inputClass + ' text-sm'}
                            placeholder="그림 설명 (선택)"
                            value={c.text}
                            onChange={(e) => set('choices', q.choices.map((x, k) => (k === i ? { ...x, text: e.target.value } : x)))}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {q.choices.length < 10 && (
                <Button variant="ghost" size="sm" onClick={() => set('choices', [...q.choices, { text: '', mediaId: null }])}>
                  + 선택지 추가
                </Button>
              )}
            </fieldset>
          )}

          {q.type === 'ox' && (
            <fieldset>
              <legend className="mb-2 text-sm font-semibold text-slate-700">정답</legend>
              <div className="flex gap-3">
                {(['O', 'X'] as const).map((v) => (
                  <label key={v} className={cx('flex cursor-pointer items-center gap-2 rounded-xl border-2 px-6 py-3 text-2xl font-black', q.answer.value === v ? 'border-emerald-500 bg-emerald-50' : 'border-slate-200')}>
                    <input type="radio" name="ox" checked={q.answer.value === v} onChange={() => setA({ value: v })} className="h-5 w-5" />
                    {v}
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          {q.type === 'short' && (
            <div className="grid gap-4 md:grid-cols-2">
              <TextList label="정답 (한 줄에 하나, 여러 개면 모두 정답)" value={q.answer.accepted} onChange={(v) => setA({ accepted: v })} />
              <TextList label="추가로 허용할 답안 (선택)" value={q.answer.alternatives} onChange={(v) => setA({ alternatives: v })} hint="예: 축약형 I'm / I am" />
              <Options a={q.answer} setA={setA} keys={['caseSensitive', 'trimSpaces']} />
            </div>
          )}

          {q.type === 'sentence' && (
            <div className="space-y-4">
              <Field label="채점 기준">
                {(i) => (
                  <select id={i} className={inputClass} value={q.answer.mode || 'exact'} onChange={(e) => setA({ mode: e.target.value as AnswerKey['mode'] })}>
                    <option value="exact">정답 문장과 일치 (자동 채점)</option>
                    <option value="keywords">필수 낱말 포함 여부 (자동 채점)</option>
                    <option value="manual">교사가 직접 채점</option>
                  </select>
                )}
              </Field>
              {(q.answer.mode || 'exact') === 'exact' && (
                <div className="grid gap-4 md:grid-cols-2">
                  <TextList label="정답 문장 (한 줄에 하나)" value={q.answer.accepted} onChange={(v) => setA({ accepted: v })} />
                  <TextList label="추가로 허용할 문장 (선택)" value={q.answer.alternatives} onChange={(v) => setA({ alternatives: v })} />
                </div>
              )}
              {q.answer.mode === 'keywords' && (
                <div className="grid gap-4 md:grid-cols-2">
                  <TextList label="반드시 들어가야 할 낱말 (한 줄에 하나)" value={q.answer.keywords} onChange={(v) => setA({ keywords: v })} />
                  <Options a={q.answer} setA={setA} keys={['partialCredit']} />
                </div>
              )}
              {q.answer.mode !== 'manual' && <Options a={q.answer} setA={setA} keys={['caseSensitive', 'ignorePunctuation', 'reviewIfIncorrect']} />}
            </div>
          )}

          {q.type === 'arrange' && (
            <div className="space-y-3">
              <Alert kind="info">카드를 정답 순서대로 입력하세요. 학생 화면에는 학생마다 무작위로 섞여서 보입니다.</Alert>
              <Field label="카드 종류">
                {(i) => (
                  <select id={i} className={inputClass} value={q.answer.joiner ?? ''} onChange={(e) => setA({ joiner: e.target.value })}>
                    <option value="">철자 배열 (예: c-a-t → cat)</option>
                    <option value=" ">낱말 배열 (예: I / like / apples → I like apples)</option>
                  </select>
                )}
              </Field>
              <div className="flex flex-wrap gap-2">
                {q.choices.map((c, i) => (
                  <div key={i} className="flex items-center gap-1 rounded-xl border border-slate-300 bg-white p-1">
                    <span className="px-1 text-xs text-slate-400">{i + 1}</span>
                    <input
                      className="w-24 rounded-lg px-2 py-1.5 text-lg font-bold focus:ring-2 focus:ring-blue-200 focus:outline-none"
                      value={c.text}
                      onChange={(e) => set('choices', q.choices.map((x, k) => (k === i ? { ...x, text: e.target.value } : x)))}
                      aria-label={`${i + 1}번째 카드`}
                    />
                    <button type="button" className="px-1 text-red-500" onClick={() => removeChoice(i)} aria-label="카드 삭제">
                      ✕
                    </button>
                  </div>
                ))}
                <Button variant="ghost" size="sm" onClick={() => set('choices', [...q.choices, { text: '', mediaId: null }])}>
                  + 카드 추가
                </Button>
              </div>
              <p className="text-sm text-slate-600">
                정답: <b>{q.choices.map((c) => c.text).join(q.answer.joiner ?? '') || '-'}</b>
              </p>
              <TextList label="다른 정답도 인정 (선택)" value={q.answer.accepted} onChange={(v) => setA({ accepted: v })} hint="같은 카드로 만들 수 있는 다른 정답이 있으면 입력하세요." />
            </div>
          )}

          <Field label="해설 (교사용, 학생에게 보이지 않음)">{(i) => <textarea id={i} rows={2} className={inputClass} value={q.explanation} onChange={(e) => set('explanation', e.target.value)} />}</Field>

          {issues.length > 0 ? (
            <Alert kind="warning">
              <b>시험 공개 전에 채워야 할 항목</b>
              {'\n'}
              {issues.map((s) => `• ${s}`).join('\n')}
            </Alert>
          ) : (
            <Alert kind="success">필수 항목이 모두 채워졌습니다. 「완성으로 저장」할 수 있습니다.</Alert>
          )}
        </div>
      )}
      {error && (
        <div className="mt-4">
          <Alert>{error}</Alert>
        </div>
      )}
    </Modal>
  );
}

function TextList({ label, value, onChange, hint }: { label: string; value?: string[]; onChange: (v: string[]) => void; hint?: string }) {
  const [text, setText] = useState((value || []).join('\n'));
  return (
    <Field label={label} hint={hint}>
      {(i) => (
        <textarea
          id={i}
          rows={3}
          className={inputClass}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            onChange(lines(e.target.value));
          }}
        />
      )}
    </Field>
  );
}

const OPTION_LABELS: Record<string, [string, boolean]> = {
  caseSensitive: ['대소문자 구분', false],
  trimSpaces: ['앞뒤 공백 무시', true],
  ignorePunctuation: ['문장부호(. , ! ?) 무시', true],
  partialCredit: ['포함한 낱말 비율만큼 부분 점수', false],
  reviewIfIncorrect: ['자동 채점에서 틀리면 교사가 다시 확인', false],
};

function Options({ a, setA, keys }: { a: AnswerKey; setA: (p: Partial<AnswerKey>) => void; keys: (keyof AnswerKey)[] }) {
  return (
    <div className="flex flex-col gap-2">
      {keys.map((k) => {
        const [label, def] = OPTION_LABELS[k];
        const v = (a[k] as boolean | undefined) ?? def;
        return (
          <label key={k} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={v} onChange={(e) => setA({ [k]: e.target.checked })} className="h-4 w-4" />
            {label}
          </label>
        );
      })}
    </div>
  );
}
