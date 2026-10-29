import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { DOMAINS, QUESTION_TYPE_LABELS, RESULT_POLICY_LABELS, type ExamStatus, type ResultPolicy } from '../../../shared/types';
import { adminApi } from '../lib/api';
import { formatFullDateTime, fromLocalInput, toLocalInput } from '../lib/format';
import { Alert, Badge, Button, Card, Empty, Field, Modal, Spinner, cx, inputClass } from '../components/ui';
import QuestionView from '../components/QuestionView';
import { statusBadge } from './Exams';
import { correctChoiceOf, toPreviewItem, type Question } from './types';
import { useAction, useLoad } from './useLoad';
import type { ClassRow, StudentRow } from './Students';

interface ExamDetail {
  id: string;
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
  status: ExamStatus;
  items: { questionId: string; points: number }[];
  versions: { id: string; version_no: number; total_points: number; created_at: number; attempt_count: number }[];
  targetStudentIds: string[];
  attemptCount: number;
}

type Issue = { questionId: string | null; seq: number | null; messages: string[] };

export default function ExamEditor() {
  const { id = '' } = useParams();
  const { data, error, reload } = useLoad(
    async () => {
      const [exam, questions, students, classes] = await Promise.all([
        adminApi.get<ExamDetail>(`/api/admin/exams/${id}`),
        adminApi.get<Question[]>('/api/admin/questions'),
        adminApi.get<StudentRow[]>('/api/admin/students'),
        adminApi.get<ClassRow[]>('/api/admin/classes'),
      ]);
      return { exam, questions, students, classes };
    },
    [id],
  );
  const [form, setForm] = useState<ExamDetail | null>(null);
  const [targets, setTargets] = useState<Set<string>>(new Set());
  const [dirty, setDirty] = useState(false);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [preview, setPreview] = useState(false);
  const act = useAction();

  useEffect(() => {
    if (!data) return;
    setForm(data.exam);
    setTargets(new Set(data.exam.targetStudentIds));
    setDirty(false);
  }, [data]);

  if (error && !data) return <Alert>{error}</Alert>;
  if (!data || !form) return <Spinner />;

  const published = form.status === 'published';
  const qMap = new Map(data.questions.map((q) => [q.id, q]));
  const total = form.items.reduce((s, i) => s + i.points, 0);
  const update = (patch: Partial<ExamDetail>) => {
    setForm({ ...form, ...patch });
    setDirty(true);
  };

  async function save() {
    return act.run(
      'save',
      async () => {
        const body: Record<string, unknown> = {
          title: form!.title,
          grade: form!.grade,
          unit: form!.unit,
          description: form!.description,
          durationMin: form!.durationMin,
          audioPlayLimit: form!.audioPlayLimit,
          shuffleQuestions: form!.shuffleQuestions,
          startAt: form!.startAt,
          endAt: form!.endAt,
          resultPolicy: form!.resultPolicy,
        };
        if (!published) body.items = form!.items;
        await adminApi.put(`/api/admin/exams/${id}`, body);
        await adminApi.put(`/api/admin/exams/${id}/targets`, { studentIds: [...targets] });
        await reload();
      },
      '저장했습니다.',
    );
  }

  async function publish() {
    if (dirty && !(await save())) return;
    setIssues([]);
    const ok = await act.run('publish', async () => {
      try {
        await adminApi.post(`/api/admin/exams/${id}/publish`);
      } catch (e) {
        const d = (e as { data?: { issues?: Issue[] } }).data;
        if (d?.issues) setIssues(d.issues);
        throw e;
      }
      await reload();
    });
    if (ok) act.setNotice('시험을 공개했습니다. 대상 학생이 응시할 수 있습니다.');
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link to="/admin/exams" className="text-sm text-blue-700 hover:underline">
            ← 시험 목록
          </Link>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            {form.title} {statusBadge(form.status)}
          </h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setPreview(true)} disabled={!form.items.length}>
            👁 시험 미리보기
          </Button>
          <Button variant="secondary" onClick={save} loading={act.busy === 'save'} disabled={!dirty}>
            저장
          </Button>
          {form.status !== 'published' ? (
            <Button onClick={publish} loading={act.busy === 'publish'}>
              공개하기
            </Button>
          ) : (
            <>
              <Button variant="secondary" onClick={() => confirm('비공개로 바꾸면 학생이 새로 시작할 수 없습니다. (응시 중인 학생은 계속 풀 수 있습니다)') && act.run('unpub', () => adminApi.post(`/api/admin/exams/${id}/unpublish`).then(reload), '비공개로 전환했습니다.')} loading={act.busy === 'unpub'}>
                비공개로 전환
              </Button>
              <Button variant="danger" onClick={() => confirm('시험을 종료할까요? 응시 중인 학생도 즉시 제출·채점됩니다.') && act.run('close', () => adminApi.post(`/api/admin/exams/${id}/close`).then(reload), '시험을 종료했습니다.')} loading={act.busy === 'close'}>
                시험 종료
              </Button>
            </>
          )}
        </div>
      </div>

      <Alert onClose={() => act.setError('')}>{act.error}</Alert>
      <Alert kind="success" onClose={() => act.setNotice('')}>
        {act.notice}
      </Alert>
      {issues.length > 0 && (
        <Alert kind="warning">
          <b>공개 전에 고쳐야 할 내용</b>
          {'\n'}
          {issues.map((i) => `• ${i.seq ? `${i.seq}번 문항: ` : ''}${i.messages.join(' ')}`).join('\n')}
        </Alert>
      )}
      {published && <Alert kind="info">공개 중인 시험은 문항·배점·시간을 바꿀 수 없습니다. 바꾸려면 「비공개로 전환」 후 수정하고 다시 공개하세요. 이미 응시한 학생의 시험지와 정답은 그대로 보존됩니다.</Alert>}

      <Card title="1. 기본 설정">
        <div className="grid gap-4 md:grid-cols-4">
          <Field label="시험 제목" className="md:col-span-2">
            {(i) => <input id={i} className={inputClass} value={form.title} onChange={(e) => update({ title: e.target.value })} maxLength={100} />}
          </Field>
          <Field label="학년">
            {(i) => (
              <select id={i} className={inputClass} value={form.grade} disabled={published} onChange={(e) => update({ grade: Number(e.target.value) })}>
                {[1, 2, 3, 4, 5, 6].map((g) => (
                  <option key={g} value={g}>
                    {g}학년
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="단원">{(i) => <input id={i} type="number" min={1} max={30} className={inputClass} value={form.unit} disabled={published} onChange={(e) => update({ unit: Number(e.target.value) })} />}</Field>
          <Field label="시험 시간 (분)">{(i) => <input id={i} type="number" min={1} max={300} className={inputClass} value={form.durationMin} disabled={published} onChange={(e) => update({ durationMin: Number(e.target.value) })} />}</Field>
          <Field label="음성 재생 횟수" hint="0이면 제한 없음">
            {(i) => <input id={i} type="number" min={0} max={10} className={inputClass} value={form.audioPlayLimit} disabled={published} onChange={(e) => update({ audioPlayLimit: Number(e.target.value) })} />}
          </Field>
          <Field label="시작 시간 (선택)">{(i) => <input id={i} type="datetime-local" className={inputClass} value={toLocalInput(form.startAt)} onChange={(e) => update({ startAt: fromLocalInput(e.target.value) })} />}</Field>
          <Field label="종료 시간 (선택)" hint="종료 시간이 되면 응시 중이어도 자동 제출">
            {(i) => <input id={i} type="datetime-local" className={inputClass} value={toLocalInput(form.endAt)} onChange={(e) => update({ endAt: fromLocalInput(e.target.value) })} />}
          </Field>
          <Field label="결과 공개 방식" className="md:col-span-2">
            {(i) => (
              <select id={i} className={inputClass} value={form.resultPolicy} onChange={(e) => update({ resultPolicy: e.target.value as ResultPolicy })}>
                {(Object.keys(RESULT_POLICY_LABELS) as ResultPolicy[]).map((p) => (
                  <option key={p} value={p}>
                    {RESULT_POLICY_LABELS[p]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <label className="flex items-center gap-2 self-end pb-3 md:col-span-2">
            <input type="checkbox" className="h-5 w-5" checked={form.shuffleQuestions} disabled={published} onChange={(e) => update({ shuffleQuestions: e.target.checked })} />
            학생마다 문제 순서를 무작위로 섞기
          </label>
          <Field label="학생 안내 문구 (선택)" className="md:col-span-4">
            {(i) => <textarea id={i} rows={2} className={inputClass} value={form.description} onChange={(e) => update({ description: e.target.value })} maxLength={1000} />}
          </Field>
        </div>
      </Card>

      <ItemsSection form={form} questions={data.questions} qMap={qMap} locked={published} total={total} onChange={(items) => update({ items })} />

      <TargetsSection
        students={data.students}
        classes={data.classes}
        selected={targets}
        onChange={(s) => {
          setTargets(s);
          setDirty(true);
        }}
      />

      {form.versions.length > 0 && (
        <Card title="공개 버전 기록">
          <ul className="space-y-1 text-sm">
            {form.versions.map((v) => (
              <li key={v.id}>
                <b>v{v.version_no}</b> · {formatFullDateTime(v.created_at)} 공개 · 총점 {v.total_points}점 · 응시 {v.attempt_count}명
              </li>
            ))}
          </ul>
        </Card>
      )}

      {dirty && (
        <div className="no-print sticky bottom-4 flex justify-end">
          <div className="flex items-center gap-3 rounded-2xl bg-slate-900 px-4 py-3 text-white shadow-lg">
            저장하지 않은 변경 사항이 있습니다.
            <Button onClick={save} loading={act.busy === 'save'}>
              저장
            </Button>
          </div>
        </div>
      )}

      {preview && (
        <Modal wide title={`미리보기: ${form.title}`} onClose={() => setPreview(false)}>
          <div className="space-y-6">
            {form.items.map((it, i) => {
              const q = qMap.get(it.questionId);
              if (!q) return null;
              return (
                <div key={it.questionId} className="rounded-2xl border border-slate-200 p-5">
                  <QuestionView
                    item={toPreviewItem(q, i + 1, it.points)}
                    value=""
                    onChange={() => {}}
                    correctChoice={correctChoiceOf(q)}
                    audio={q.audioMediaId ? <audio controls preload="none" src={`/api/media/${q.audioMediaId}`} className="w-full" /> : <Alert kind="warning">음성 없음</Alert>}
                  />
                </div>
              );
            })}
          </div>
        </Modal>
      )}
    </div>
  );
}

function ItemsSection({
  form,
  questions,
  qMap,
  locked,
  total,
  onChange,
}: {
  form: ExamDetail;
  questions: Question[];
  qMap: Map<string, Question>;
  locked: boolean;
  total: number;
  onChange: (items: ExamDetail['items']) => void;
}) {
  const [f, setF] = useState({ grade: String(form.grade), unit: String(form.unit), domain: '', q: '', onlyReady: true });
  const chosen = new Set(form.items.map((i) => i.questionId));
  const pool = useMemo(
    () =>
      questions.filter(
        (q) =>
          !chosen.has(q.id) &&
          (!f.grade || q.grade === Number(f.grade)) &&
          (!f.unit || q.unit === Number(f.unit)) &&
          (!f.domain || q.domain === f.domain) &&
          (!f.q || q.prompt.toLowerCase().includes(f.q.toLowerCase())) &&
          (!f.onlyReady || (q.status === 'ready' && !q.issues.length)),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [questions, f, form.items],
  );
  const move = (i: number, d: number) => {
    const arr = [...form.items];
    const j = i + d;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    onChange(arr);
  };

  return (
    <Card title={`2. 문항 구성 (${form.items.length}문항 · 총 ${total}점)`}>
      <div className="grid gap-5 lg:grid-cols-2">
        <div>
          <h3 className="mb-2 font-semibold">시험에 넣은 문제</h3>
          {form.items.length === 0 ? (
            <Empty>오른쪽 문제은행에서 문제를 추가하세요.</Empty>
          ) : (
            <ol className="space-y-2">
              {form.items.map((it, i) => {
                const q = qMap.get(it.questionId);
                const bad = !q || q.issues.length > 0 || q.status !== 'ready';
                return (
                  <li key={it.questionId} className={cx('flex items-center gap-2 rounded-xl border p-2', bad ? 'border-amber-300 bg-amber-50' : 'border-slate-200')}>
                    <span className="w-7 shrink-0 text-center font-bold text-blue-700">{i + 1}</span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{q?.prompt || '(삭제되었거나 찾을 수 없는 문제)'}</div>
                      <div className="text-xs text-slate-500">
                        {q ? `${q.domain} · ${QUESTION_TYPE_LABELS[q.type]}` : ''} {bad && q && <span className="text-amber-700">⚠ {q.issues[0] || '임시 저장 상태'}</span>}
                      </div>
                    </div>
                    <label className="flex shrink-0 items-center gap-1 text-sm">
                      <input
                        type="number"
                        min={0.5}
                        step={0.5}
                        max={100}
                        disabled={locked}
                        value={it.points}
                        aria-label={`${i + 1}번 배점`}
                        onChange={(e) => onChange(form.items.map((x, k) => (k === i ? { ...x, points: Number(e.target.value) } : x)))}
                        className="w-16 rounded-lg border border-slate-300 px-2 py-1 text-right"
                      />
                      점
                    </label>
                    {!locked && (
                      <div className="flex shrink-0">
                        <button type="button" className="px-1.5 text-slate-500 hover:text-slate-900" onClick={() => move(i, -1)} aria-label="위로">
                          ↑
                        </button>
                        <button type="button" className="px-1.5 text-slate-500 hover:text-slate-900" onClick={() => move(i, 1)} aria-label="아래로">
                          ↓
                        </button>
                        <button type="button" className="px-1.5 text-red-500" onClick={() => onChange(form.items.filter((_, k) => k !== i))} aria-label="빼기">
                          ✕
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </div>
        <div>
          <h3 className="mb-2 font-semibold">문제은행에서 추가</h3>
          <div className="mb-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <select aria-label="학년" className={inputClass} value={f.grade} onChange={(e) => setF({ ...f, grade: e.target.value })}>
              <option value="">전체 학년</option>
              {[1, 2, 3, 4, 5, 6].map((g) => (
                <option key={g} value={g}>
                  {g}학년
                </option>
              ))}
            </select>
            <input aria-label="단원" type="number" placeholder="단원" className={inputClass} value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} />
            <select aria-label="영역" className={inputClass} value={f.domain} onChange={(e) => setF({ ...f, domain: e.target.value })}>
              <option value="">전체 영역</option>
              {DOMAINS.map((d) => (
                <option key={d}>{d}</option>
              ))}
            </select>
            <input aria-label="검색" placeholder="검색" className={inputClass} value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
          </div>
          <label className="mb-2 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={f.onlyReady} onChange={(e) => setF({ ...f, onlyReady: e.target.checked })} /> 완성된 문제만 보기
          </label>
          <div className="max-h-[28rem] space-y-1.5 overflow-y-auto pr-1">
            {pool.length === 0 && <Empty>추가할 수 있는 문제가 없습니다.</Empty>}
            {pool.map((q) => (
              <div key={q.id} className="flex items-center gap-2 rounded-xl border border-slate-200 p-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{q.prompt || '(내용 없음)'}</div>
                  <div className="flex gap-1 text-xs text-slate-500">
                    {q.grade}-{q.unit} · {q.domain} · {QUESTION_TYPE_LABELS[q.type]} · {q.points}점 {q.status !== 'ready' && <Badge color="amber">임시</Badge>}
                  </div>
                </div>
                <Button size="sm" variant="secondary" disabled={locked} onClick={() => onChange([...form.items, { questionId: q.id, points: q.points }])}>
                  추가
                </Button>
              </div>
            ))}
          </div>
          {!locked && pool.length > 0 && (
            <Button variant="ghost" size="sm" className="mt-2" onClick={() => onChange([...form.items, ...pool.map((q) => ({ questionId: q.id, points: q.points }))])}>
              보이는 문제 모두 추가 ({pool.length})
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

function TargetsSection({ students, classes, selected, onChange }: { students: StudentRow[]; classes: ClassRow[]; selected: Set<string>; onChange: (s: Set<string>) => void }) {
  const active = students.filter((s) => s.active);
  const [open, setOpen] = useState<string | null>(null);
  const toggleAll = (ids: string[], on: boolean) => {
    const next = new Set(selected);
    ids.forEach((id) => (on ? next.add(id) : next.delete(id)));
    onChange(next);
  };
  return (
    <Card title={`3. 응시 대상 학생 (${selected.size}명 선택)`}>
      {classes.length === 0 ? (
        <Empty>
          등록된 학생이 없습니다. <Link className="text-blue-700 underline" to="/admin/students">학생 관리</Link>에서 먼저 등록하세요.
        </Empty>
      ) : (
        <div className="space-y-2">
          {classes.map((c) => {
            const list = active.filter((s) => s.class_id === c.id);
            const ids = list.map((s) => s.id);
            const n = ids.filter((id) => selected.has(id)).length;
            return (
              <div key={c.id} className="rounded-xl border border-slate-200">
                <div className="flex flex-wrap items-center gap-3 p-3">
                  <label className="flex items-center gap-2 font-semibold">
                    <input
                      type="checkbox"
                      className="h-5 w-5"
                      checked={ids.length > 0 && n === ids.length}
                      ref={(el) => {
                        if (el) el.indeterminate = n > 0 && n < ids.length;
                      }}
                      onChange={(e) => toggleAll(ids, e.target.checked)}
                      disabled={!ids.length}
                    />
                    {c.school_year}학년도 {c.grade}학년 {c.class_no}반
                  </label>
                  <span className="text-sm text-slate-500">
                    {n} / {ids.length}명
                  </span>
                  <button type="button" className="ml-auto text-sm text-blue-700 hover:underline" onClick={() => setOpen(open === c.id ? null : c.id)}>
                    {open === c.id ? '접기' : '학생별 선택'}
                  </button>
                </div>
                {open === c.id && (
                  <div className="grid grid-cols-2 gap-1 border-t border-slate-100 p-3 sm:grid-cols-4 lg:grid-cols-6">
                    {list.map((s) => (
                      <label key={s.id} className="flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={selected.has(s.id)} onChange={(e) => toggleAll([s.id], e.target.checked)} />
                        {s.number}. {s.name}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
