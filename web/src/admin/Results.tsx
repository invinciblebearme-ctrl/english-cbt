import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { QUESTION_TYPE_LABELS, type QuestionSnapshot } from '../../../shared/types';
import { adminApi } from '../lib/api';
import { download, safeFileName, toCsv, toXlsx, type Cell } from '../lib/exporters';
import { formatDateTime, studentLabel } from '../lib/format';
import { Alert, Badge, Button, Card, Empty, Modal, Spinner, Stat, cx, inputClass } from '../components/ui';
import { answerSummary } from './types';
import { statusBadge, type ExamSummary } from './Exams';
import { useAction, useLoad } from './useLoad';

interface ResultData {
  exam: { id: string; title: string; status: 'draft' | 'published' | 'closed'; grade: number; unit: number };
  items: { itemId: string; seq: number; points: number; prompt: string; type: string }[];
  itemsByVersion: Record<string, { itemId: string; seq: number; points: number; prompt: string; type: string }[]>;
  stats: { targetCount: number; submittedCount: number; inProgressCount: number; notStartedCount: number; average: number | null; max: number | null; min: number | null; pendingGrading: number };
  itemStats: { seq: number; prompt: string; type: string; points: number; answered: number; correct: number; pending: number; correctRate: number | null; avgScore: number | null }[];
  attempts: {
    id: string;
    student_id: string;
    version_id: string;
    status: 'in_progress' | 'submitted';
    started_at: number;
    deadline_at: number;
    submitted_at: number | null;
    submit_reason: string | null;
    total_score: number | null;
    max_score: number;
    grading_status: string;
    name: string;
    number: number;
    grade: number;
    class_no: number;
    grades: { item_id: string; score: number; max_score: number; is_correct: number | null; status: string }[];
  }[];
  notStarted: { id: string; name: string; number: number; grade: number; class_no: number }[];
  inProgress: ResultData['attempts'];
}

const REASON: Record<string, string> = { student: '학생 제출', timeout: '시간 종료', teacher: '교사 마감' };

export default function Results() {
  const { examId } = useParams();
  const nav = useNavigate();
  const exams = useLoad(() => adminApi.get<ExamSummary[]>('/api/admin/exams'));
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">성적 관리</h1>
        <select aria-label="시험 선택" className={inputClass + ' max-w-sm'} value={examId || ''} onChange={(e) => nav(e.target.value ? `/admin/results/${e.target.value}` : '/admin/results')}>
          <option value="">시험을 선택하세요</option>
          {exams.data?.map((e) => (
            <option key={e.id} value={e.id}>
              {e.title} ({e.submittedCount}/{e.targetCount}명 제출)
            </option>
          ))}
        </select>
      </div>
      {examId ? (
        <ExamResults key={examId} examId={examId} />
      ) : exams.data && exams.data.length === 0 ? (
        <Empty>시험이 없습니다.</Empty>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {exams.data?.map((e) => (
            <Link key={e.id} to={`/admin/results/${e.id}`} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm hover:border-blue-300">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold">{e.title}</span>
                {statusBadge(e.status)}
              </div>
              <div className="mt-2 text-sm text-slate-500">
                제출 {e.submittedCount} / 대상 {e.targetCount}명
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function ExamResults({ examId }: { examId: string }) {
  const { data, error, reload, loading } = useLoad(() => adminApi.get<ResultData>(`/api/admin/exams/${examId}/results`), [examId]);
  const [detail, setDetail] = useState<string | null>(null);
  const [tab, setTab] = useState<'students' | 'items' | 'status'>('students');
  const act = useAction();

  if (error && !data) return <Alert>{error}</Alert>;
  if (!data) return <Spinner />;
  const items = data.items.length ? data.items : Object.values(data.itemsByVersion)[0] || [];
  const s = data.stats;
  const submitted = data.attempts.filter((a) => a.status === 'submitted');

  function rowsForExport() {
    const header: Cell[] = ['학년', '반', '번호', '이름', '상태', '점수', '만점', '채점', '제출 시각', ...items.map((i) => `${i.seq}번`)];
    const body: Cell[][] = data!.attempts.map((a) => {
      const vItems = data!.itemsByVersion[a.version_id] || [];
      return [
        a.grade,
        a.class_no,
        a.number,
        a.name,
        a.status === 'submitted' ? REASON[a.submit_reason || 'student'] : '응시 중',
        a.total_score,
        a.max_score,
        a.grading_status === 'pending' ? '수동 채점 대기' : a.status === 'submitted' ? '완료' : '',
        a.submitted_at ? formatDateTime(a.submitted_at) : '',
        ...items.map((it) => {
          const vi = vItems.find((x) => x.seq === it.seq);
          const g = vi && a.grades.find((x) => x.item_id === vi.itemId);
          return g ? (g.status === 'pending' ? '?' : g.is_correct === 1 ? 'O' : 'X') : '';
        }),
      ];
    });
    for (const n of data!.notStarted) body.push([n.grade, n.class_no, n.number, n.name, '미응시', null, null, '', '', ...items.map(() => '')]);
    body.sort((x, y) => Number(x[0]) - Number(y[0]) || Number(x[1]) - Number(y[1]) || Number(x[2]) - Number(y[2]));
    return [header, ...body];
  }
  const itemRows = (): Cell[][] => [
    ['번호', '유형', '문제', '배점', '응답 수', '정답 수', '정답률(%)', '평균 점수', '채점 대기'],
    ...data!.itemStats.map((i) => [i.seq, QUESTION_TYPE_LABELS[i.type as keyof typeof QUESTION_TYPE_LABELS], i.prompt, i.points, i.answered, i.correct, i.correctRate, i.avgScore, i.pending]),
  ];
  const summaryRows = (): Cell[][] => [
    ['항목', '값'],
    ['시험', data!.exam.title],
    ['대상 학생', s.targetCount],
    ['제출', s.submittedCount],
    ['응시 중', s.inProgressCount],
    ['미응시', s.notStartedCount],
    ['평균', s.average],
    ['최고', s.max],
    ['최저', s.min],
  ];
  const base = safeFileName(data.exam.title);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-xl font-bold">
          {data.exam.title} {statusBadge(data.exam.status)}
        </h2>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => reload()} loading={loading}>
            새로고침
          </Button>
          <Button variant="secondary" onClick={() => download(`${base}_성적.csv`, toCsv(rowsForExport()), 'text/csv;charset=utf-8')}>
            CSV 다운로드
          </Button>
          <Button
            onClick={() =>
              download(
                `${base}_성적.xlsx`,
                toXlsx([
                  { name: '학생별 성적', rows: rowsForExport() },
                  { name: '문항별 정답률', rows: itemRows() },
                  { name: '요약', rows: summaryRows() },
                ]) as BlobPart,
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              )
            }
          >
            Excel 다운로드
          </Button>
        </div>
      </div>
      <Alert onClose={() => act.setError('')}>{act.error}</Alert>
      <Alert kind="success" onClose={() => act.setNotice('')}>
        {act.notice}
      </Alert>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
        <Stat label="대상" value={s.targetCount} tone="slate" />
        <Stat label="제출" value={s.submittedCount} tone="green" />
        <Stat label="응시 중" value={s.inProgressCount} tone="amber" />
        <Stat label="미응시" value={s.notStartedCount} tone="slate" />
        <Stat label="평균" value={s.average ?? '-'} />
        <Stat label="최고" value={s.max ?? '-'} />
        <Stat label="최저" value={s.min ?? '-'} />
      </div>
      {s.pendingGrading > 0 && <Alert kind="warning">교사 채점이 필요한 학생이 {s.pendingGrading}명 있습니다. 학생 이름을 눌러 채점하세요.</Alert>}

      <div className="flex gap-1 border-b border-slate-200" role="tablist">
        {(
          [
            ['students', '학생별 점수·정오표'],
            ['items', '문항별 정답률'],
            ['status', `응시 현황 (미응시 ${s.notStartedCount} · 응시 중 ${s.inProgressCount})`],
          ] as const
        ).map(([k, l]) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            type="button"
            onClick={() => setTab(k)}
            className={cx('-mb-px border-b-2 px-4 py-2 font-semibold', tab === k ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500 hover:text-slate-800')}
          >
            {l}
          </button>
        ))}
      </div>

      {tab === 'students' && (
        <Card>
          {submitted.length === 0 ? (
            <Empty>아직 제출한 학생이 없습니다.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-slate-500">
                  <tr>
                    <th className="sticky left-0 bg-white py-2 pr-3">학생</th>
                    <th className="pr-3">점수</th>
                    {items.map((i) => (
                      <th key={i.seq} className="px-1 text-center" title={i.prompt}>
                        {i.seq}
                      </th>
                    ))}
                    <th className="pl-3">제출</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {submitted.map((a) => {
                    const vItems = data.itemsByVersion[a.version_id] || [];
                    return (
                      <tr key={a.id} className="hover:bg-slate-50">
                        <td className="sticky left-0 bg-white py-2 pr-3 whitespace-nowrap">
                          <button type="button" className="font-medium text-blue-700 hover:underline" onClick={() => setDetail(a.id)}>
                            {studentLabel(a)}
                          </button>
                        </td>
                        <td className="pr-3 font-bold whitespace-nowrap tabular-nums">
                          {a.total_score}/{a.max_score} {a.grading_status === 'pending' && <Badge color="amber">채점 대기</Badge>}
                        </td>
                        {items.map((it) => {
                          const vi = vItems.find((x) => x.seq === it.seq);
                          const g = vi && a.grades.find((x) => x.item_id === vi.itemId);
                          return (
                            <td key={it.seq} className="px-1 text-center">
                              {!g ? (
                                <span className="text-slate-300">-</span>
                              ) : g.status === 'pending' ? (
                                <span className="font-bold text-amber-600" title="채점 대기">
                                  ?
                                </span>
                              ) : g.is_correct === 1 ? (
                                <span className="font-bold text-blue-600">O</span>
                              ) : (
                                <span className="font-bold text-red-500">X</span>
                              )}
                            </td>
                          );
                        })}
                        <td className="pl-3 whitespace-nowrap text-slate-500">
                          {formatDateTime(a.submitted_at)} <span className="text-xs">({REASON[a.submit_reason || 'student']})</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === 'items' && (
        <Card>
          {data.itemStats.length === 0 ? (
            <Empty>제출된 답안이 없습니다.</Empty>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-slate-500">
                <tr>
                  <th className="py-2">번호</th>
                  <th>문제</th>
                  <th className="w-1/3">정답률</th>
                  <th className="text-right">평균 점수</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.itemStats.map((i) => (
                  <tr key={i.seq}>
                    <td className="py-2 font-bold">{i.seq}</td>
                    <td className="max-w-md pr-3">
                      <div className="truncate">{i.prompt}</div>
                      <div className="text-xs text-slate-500">{QUESTION_TYPE_LABELS[i.type as keyof typeof QUESTION_TYPE_LABELS]}</div>
                    </td>
                    <td>
                      <div className="flex items-center gap-2">
                        <div className="h-3 flex-1 overflow-hidden rounded-full bg-slate-100">
                          <div
                            className={cx('h-full rounded-full', (i.correctRate ?? 0) >= 70 ? 'bg-emerald-500' : (i.correctRate ?? 0) >= 40 ? 'bg-amber-400' : 'bg-red-400')}
                            style={{ width: `${i.correctRate ?? 0}%` }}
                          />
                        </div>
                        <span className="w-24 text-right tabular-nums">
                          {i.correctRate ?? '-'}% ({i.correct}/{i.answered})
                        </span>
                      </div>
                      {i.pending > 0 && <div className="text-xs text-amber-700">채점 대기 {i.pending}명</div>}
                    </td>
                    <td className="text-right tabular-nums">
                      {i.avgScore ?? '-'} / {i.points}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      {tab === 'status' && (
        <div className="grid gap-5 lg:grid-cols-2">
          <Card title={`응시 중 (${data.inProgress.length}명)`}>
            {data.inProgress.length === 0 ? (
              <Empty>응시 중인 학생이 없습니다.</Empty>
            ) : (
              <ul className="divide-y divide-slate-100">
                {data.inProgress.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-2 py-2">
                    <span>
                      {studentLabel(a)} <span className="text-xs text-slate-500">· {formatDateTime(a.deadline_at)}까지</span>
                    </span>
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={act.busy === 'fs' + a.id}
                      onClick={() => confirm(`${a.name} 학생의 응시를 지금 마감할까요?`) && act.run('fs' + a.id, () => adminApi.post(`/api/admin/attempts/${a.id}/force-submit`).then(reload), '마감했습니다.')}
                    >
                      강제 마감
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title={`미응시 (${data.notStarted.length}명)`}>
            {data.notStarted.length === 0 ? (
              <Empty>모든 대상 학생이 응시했습니다.</Empty>
            ) : (
              <div className="flex flex-wrap gap-2">
                {data.notStarted.map((n) => (
                  <Badge key={n.id}>{studentLabel(n)}</Badge>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}

      {detail && (
        <AttemptDetail
          attemptId={detail}
          onClose={() => setDetail(null)}
          onChanged={() => void reload()}
        />
      )}
    </div>
  );
}

interface DetailData {
  attempt: { id: string; name: string; number: number; grade: number; class_no: number; title: string; total_score: number; max_score: number; status: string; started_at: number; submitted_at: number };
  items: {
    itemId: string;
    seq: number;
    points: number;
    question: QuestionSnapshot;
    response: string;
    responseText: string;
    savedAt: number | null;
    plays: number;
    grade: { auto_score: number; manual_score: number | null; max_score: number; is_correct: number | null; status: string; feedback: string } | null;
  }[];
}

function AttemptDetail({ attemptId, onClose, onChanged }: { attemptId: string; onClose: () => void; onChanged: () => void }) {
  const { data, error, reload } = useLoad(() => adminApi.get<DetailData>(`/api/admin/attempts/${attemptId}`), [attemptId]);
  const act = useAction();
  const [scores, setScores] = useState<Record<string, string>>({});

  const show = (it: DetailData['items'][number]) => {
    const q = it.question;
    if (!it.response) return <span className="text-slate-400">(응답 없음)</span>;
    if (['mc_text', 'mc_image', 'listen_mc', 'listen_image'].includes(q.type)) {
      const c = q.choices[Number(it.response) - 1];
      return `${it.response}번${c?.text ? ` (${c.text})` : ''}`;
    }
    return it.responseText;
  };

  return (
    <Modal wide title={data ? `${studentLabel(data.attempt)} · ${data.attempt.title}` : '정오표'} onClose={onClose}>
      <Alert>{error || act.error}</Alert>
      <Alert kind="success">{act.notice}</Alert>
      {!data ? (
        <Spinner />
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-2xl font-bold">
              {data.attempt.total_score ?? '-'} / {data.attempt.max_score}점
            </div>
            <Button
              variant="danger"
              size="sm"
              loading={act.busy === 'reset'}
              onClick={() =>
                confirm('이 학생에게 재응시를 허용할까요?\n지금 응시 기록은 보관되고, 학생은 처음부터 다시 시험을 봅니다.') &&
                act.run('reset', async () => {
                  await adminApi.post(`/api/admin/attempts/${attemptId}/reset`);
                  onChanged();
                  onClose();
                })
              }
            >
              재응시 허용
            </Button>
          </div>
          <table className="w-full text-sm">
            <thead className="text-left text-slate-500">
              <tr>
                <th className="py-2">번호</th>
                <th>문제 / 정답</th>
                <th>학생 응답</th>
                <th className="text-right">점수</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 align-top">
              {data.items.map((it) => {
                const g = it.grade;
                const pending = g?.status === 'pending';
                const score = g ? (g.manual_score ?? g.auto_score) : 0;
                return (
                  <tr key={it.itemId} className={pending ? 'bg-amber-50' : ''}>
                    <td className="py-3 font-bold">
                      {it.seq}{' '}
                      {g && (g.status === 'pending' ? <span className="text-amber-600">?</span> : g.is_correct === 1 ? <span className="text-blue-600">O</span> : <span className="text-red-500">X</span>)}
                    </td>
                    <td className="max-w-sm py-3 pr-3">
                      <div className="font-medium">{it.question.prompt}</div>
                      <div className="mt-1 text-xs text-emerald-700">정답: {answerSummary({ ...it.question, points: it.points } as never)}</div>
                      {it.question.audioMediaId && <div className="text-xs text-slate-500">듣기 {it.plays}회</div>}
                    </td>
                    <td className="py-3 pr-3 break-words">{show(it)}</td>
                    <td className="py-3 text-right whitespace-nowrap">
                      {g && (pending || g.status === 'manual' || it.question.type === 'sentence' || it.question.type === 'short') ? (
                        <div className="flex items-center justify-end gap-1">
                          <input
                            type="number"
                            min={0}
                            max={it.points}
                            step={0.5}
                            aria-label={`${it.seq}번 점수`}
                            className="w-16 rounded-lg border border-slate-300 px-2 py-1 text-right"
                            value={scores[it.itemId] ?? String(score)}
                            onChange={(e) => setScores({ ...scores, [it.itemId]: e.target.value })}
                          />
                          <span>/ {it.points}</span>
                          <Button
                            size="sm"
                            variant={pending ? 'primary' : 'secondary'}
                            loading={act.busy === it.itemId}
                            onClick={() =>
                              act.run(
                                it.itemId,
                                async () => {
                                  await adminApi.put(`/api/admin/attempts/${attemptId}/grades/${it.itemId}`, { score: Number(scores[it.itemId] ?? score) });
                                  await reload();
                                  onChanged();
                                },
                                `${it.seq}번 채점을 저장했습니다.`,
                              )
                            }
                          >
                            채점
                          </Button>
                        </div>
                      ) : (
                        <span className="font-semibold tabular-nums">
                          {score} / {it.points}
                        </span>
                      )}
                      {g?.status === 'manual' && <div className="text-xs text-slate-500">교사 채점</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
