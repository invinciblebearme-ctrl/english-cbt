import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { StudentItem } from '../../../shared/types';
import { ApiError, errorMessage, studentApi, studentToken } from '../lib/api';
import { AnswerSync, type SyncStatus } from '../lib/answerSync';
import { formatRemaining } from '../lib/format';
import { Alert, Button, Modal, Spinner, cx } from '../components/ui';
import QuestionView from '../components/QuestionView';
import AudioPlayer from '../components/AudioPlayer';

interface Result {
  policy: 'hidden' | 'score' | 'review';
  score?: number | null;
  maxScore?: number;
  gradingPending?: boolean;
  items?: { no: number; score: number; maxScore: number; correct: boolean | null }[];
}

interface AttemptData {
  attemptId: string;
  title: string;
  status: 'in_progress' | 'submitted';
  serverNow: number;
  deadline: number;
  items?: StudentItem[];
  answers?: { item_id: string; response: string; client_rev: number }[];
  result?: Result;
}

export default function ExamRunner() {
  const { attemptId = '' } = useParams();
  const nav = useNavigate();
  const [data, setData] = useState<AttemptData | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [idx, setIdx] = useState(0);
  const [error, setError] = useState('');
  const [sync, setSync] = useState<{ status: SyncStatus; count: number }>({ status: 'idle', count: 0 });
  const [now, setNow] = useState(Date.now());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [timeUpNotice, setTimeUpNotice] = useState(false);
  const offset = useRef(0);
  const syncRef = useRef<AnswerSync | null>(null);
  const finishing = useRef(false);

  const handleAuth = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) {
        studentToken.clear();
        nav('/', { replace: true });
        return true;
      }
      return false;
    },
    [nav],
  );

  const load = useCallback(async () => {
    try {
      const d = await studentApi.get<AttemptData>(`/api/student/attempts/${attemptId}`);
      offset.current = d.serverNow - Date.now();
      setData(d);
      if (d.status === 'in_progress' && d.items) {
        const merged: Record<string, string> = {};
        for (const a of d.answers || []) merged[a.item_id] = a.response;
        // 아직 서버에 못 보낸 답안(오프라인 중 입력)이 있으면 그것을 우선
        for (const p of syncRef.current?.pendingAnswers() || []) merged[p.itemId] = p.response;
        setAnswers(merged);
      } else {
        syncRef.current?.clear();
      }
    } catch (e) {
      if (!handleAuth(e)) setError(errorMessage(e));
    }
  }, [attemptId, handleAuth]);

  // 자동 저장 엔진
  useEffect(() => {
    const s = new AnswerSync(attemptId, {
      send: async (list) => {
        await studentApi.put(`/api/student/attempts/${attemptId}/answers`, { answers: list });
      },
      onClosed: () => void load(),
    });
    syncRef.current = s;
    const unsub = s.subscribe((status, count) => setSync({ status, count }));
    const online = () => void s.flush();
    window.addEventListener('online', online);
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (s.count) {
        void s.flush();
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    void load().then(() => {
      if (s.count) void s.flush();
    });
    return () => {
      unsub();
      s.dispose();
      window.removeEventListener('online', online);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [attemptId, load]);

  // 남은 시간 (서버 시각 기준)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const remaining = data ? data.deadline - (now + offset.current) : 0;

  // 시간 종료: 남은 답안을 보내고 서버에서 마감·채점된 결과를 받음
  useEffect(() => {
    if (!data || data.status !== 'in_progress' || remaining > 0 || finishing.current) return;
    finishing.current = true;
    setTimeUpNotice(true);
    void (async () => {
      const pending = syncRef.current?.pendingAnswers() || [];
      try {
        await studentApi.post(`/api/student/attempts/${attemptId}/submit`, { answers: pending });
      } catch {
        /* 서버가 이미 마감했으면 무시 */
      }
      syncRef.current?.clear();
      await load();
    })();
  }, [remaining, data, attemptId, load]);

  const items = useMemo(() => data?.items || [], [data]);
  const item = items[idx];
  const unanswered = items.filter((it) => !(answers[it.itemId] || '').trim()).map((it) => it.no);

  function change(v: string) {
    if (!item) return;
    setAnswers((a) => ({ ...a, [item.itemId]: v }));
    syncRef.current?.set(item.itemId, v);
  }

  async function submit() {
    setSubmitting(true);
    setError('');
    try {
      await syncRef.current?.flush();
      const pending = syncRef.current?.pendingAnswers() || [];
      await studentApi.post(`/api/student/attempts/${attemptId}/submit`, { answers: pending });
      syncRef.current?.clear();
      setConfirmOpen(false);
      await load();
    } catch (e) {
      if (!handleAuth(e)) setError(`제출하지 못했습니다: ${errorMessage(e)}\n인터넷 연결을 확인하고 다시 눌러 주세요. 답안은 이 기기에 보관되어 있습니다.`);
    } finally {
      setSubmitting(false);
    }
  }

  if (!data) return error ? <div className="p-6"><Alert>{error}</Alert></div> : <Spinner full />;

  if (data.status === 'submitted') return <ResultView data={data} timeUp={timeUpNotice} onBack={() => nav('/exams')} />;

  const lowTime = remaining < 5 * 60_000;
  return (
    <div className="flex min-h-screen flex-col bg-slate-50">
      {/* 상단: 시험 제목, 남은 시간, 문제 번호, 저장 상태 */}
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-2 px-4 py-3">
          <h1 className="min-w-0 truncate text-lg font-bold text-slate-900">{data.title}</h1>
          <div className="flex items-center gap-3">
            <span className="text-base font-semibold text-slate-600">
              <span className="text-blue-700">{idx + 1}</span> / {items.length} 문제
            </span>
            <span
              className={cx('rounded-xl px-3 py-1.5 font-mono text-xl font-bold tabular-nums', lowTime ? 'bg-red-100 text-red-700' : 'bg-blue-100 text-blue-800')}
              aria-label={`남은 시간 ${formatRemaining(remaining)}`}
              role="timer"
            >
              ⏱ {formatRemaining(remaining)}
            </span>
          </div>
        </div>
        <SaveIndicator status={sync.status} count={sync.count} />
      </header>

      {/* 가운데: 문제 */}
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-6">
        <Alert onClose={() => setError('')}>{error}</Alert>
        {lowTime && remaining > 0 && remaining < 60_000 && (
          <div className="mb-4">
            <Alert kind="warning">1분 남았습니다. 시간이 끝나면 지금까지 쓴 답이 자동으로 제출됩니다.</Alert>
          </div>
        )}
        {item && (
          <div className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-slate-200 sm:p-8">
            <QuestionView
              key={item.itemId}
              item={item}
              value={answers[item.itemId] || ''}
              onChange={change}
              audio={
                <AudioPlayer
                  playsUsed={item.playsUsed}
                  playLimit={item.playLimit}
                  requestPlay={async () => {
                    const r = await studentApi.post<{ url: string; playsUsed: number }>(`/api/student/attempts/${attemptId}/items/${item.itemId}/play`);
                    // 새로고침 후에도 같은 횟수를 보이도록 화면 데이터도 갱신
                    setData((d) => d && { ...d, items: d.items!.map((x) => (x.itemId === item.itemId ? { ...x, playsUsed: r.playsUsed } : x)) });
                    return r;
                  }}
                />
              }
            />
          </div>
        )}
      </main>

      {/* 하단: 이전/다음, 문제 번호, 제출 */}
      <footer className="sticky bottom-0 z-20 border-t border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto max-w-4xl space-y-3 px-4 py-3">
          <nav aria-label="문제 번호" className="flex flex-wrap justify-center gap-1.5">
            {items.map((it, i) => {
              const done = !!(answers[it.itemId] || '').trim();
              return (
                <button
                  key={it.itemId}
                  type="button"
                  onClick={() => setIdx(i)}
                  aria-current={i === idx ? 'step' : undefined}
                  aria-label={`${it.no}번 문제${done ? ' (답함)' : ' (안 함)'}`}
                  className={cx(
                    'h-10 w-10 rounded-xl text-base font-bold transition',
                    i === idx ? 'ring-3 ring-blue-400 ring-offset-1' : '',
                    done ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200',
                  )}
                >
                  {it.no}
                </button>
              );
            })}
          </nav>
          <div className="flex items-center justify-between gap-2">
            <Button variant="secondary" disabled={idx === 0} onClick={() => setIdx(idx - 1)} className="sm:px-6 sm:py-4 sm:text-lg">
              ◀ 이전
            </Button>
            <Button variant={idx === items.length - 1 ? 'primary' : 'secondary'} onClick={() => setConfirmOpen(true)} className="sm:px-6 sm:py-4 sm:text-lg">
              답안 제출
            </Button>
            <Button disabled={idx === items.length - 1} onClick={() => setIdx(idx + 1)} className="sm:px-6 sm:py-4 sm:text-lg">
              다음 ▶
            </Button>
          </div>
        </div>
      </footer>

      {confirmOpen && (
        <Modal
          title="답안을 제출할까요?"
          onClose={() => !submitting && setConfirmOpen(false)}
          footer={
            <>
              <Button variant="secondary" size="lg" onClick={() => setConfirmOpen(false)} disabled={submitting}>
                더 풀기
              </Button>
              <Button size="lg" onClick={submit} loading={submitting}>
                제출하기
              </Button>
            </>
          }
        >
          {unanswered.length ? (
            <div className="space-y-3">
              <Alert kind="warning">
                아직 풀지 않은 문제가 <b>{unanswered.length}개</b> 있어요.
              </Alert>
              <div className="flex flex-wrap gap-2">
                {unanswered.map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => {
                      setIdx(items.findIndex((x) => x.no === n));
                      setConfirmOpen(false);
                    }}
                    className="rounded-lg bg-amber-100 px-3 py-1.5 font-bold text-amber-900 hover:bg-amber-200"
                  >
                    {n}번
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-lg">모든 문제에 답했어요.</p>
          )}
          <p className="mt-4 text-lg font-semibold text-red-700">제출한 뒤에는 답을 고칠 수 없습니다.</p>
          {sync.count > 0 && <p className="mt-2 text-sm text-slate-500">아직 저장되지 않은 답 {sync.count}개도 함께 제출됩니다.</p>}
        </Modal>
      )}
    </div>
  );
}

function SaveIndicator({ status, count }: { status: SyncStatus; count: number }) {
  const view: Record<SyncStatus, [string, string]> = {
    idle: ['bg-slate-50 text-slate-500', '답을 고르면 자동으로 저장됩니다.'],
    saving: ['bg-blue-50 text-blue-700', '저장 중…'],
    saved: ['bg-emerald-50 text-emerald-700', '✓ 서버에 저장되었습니다.'],
    pending: ['bg-blue-50 text-blue-700', `저장 대기 중 (${count}개)`],
    offline: ['bg-red-100 text-red-800', `⚠ 인터넷 연결이 끊겼어요. 답 ${count}개를 이 기기에 보관 중이며, 연결되면 자동으로 저장됩니다.`],
    closed: ['bg-slate-200 text-slate-700', '시험이 종료되었습니다.'],
  };
  const [cls, text] = view[status];
  return (
    <div className={cx('px-4 py-1 text-center text-sm font-semibold', cls)} role="status" aria-live="polite">
      {text}
    </div>
  );
}

function ResultView({ data, timeUp, onBack }: { data: AttemptData; timeUp: boolean; onBack: () => void }) {
  const r = data.result;
  return (
    <div className="min-h-screen bg-gradient-to-b from-blue-50 to-white px-5 py-10">
      <div className="mx-auto max-w-xl space-y-5 rounded-3xl bg-white p-8 text-center shadow-lg ring-1 ring-blue-100">
        <div className="text-6xl" aria-hidden>
          🎉
        </div>
        <h1 className="text-3xl font-extrabold">제출 완료!</h1>
        <p className="text-lg text-slate-600">{data.title}</p>
        {timeUp && <Alert kind="info">시험 시간이 끝나 자동으로 제출되었습니다.</Alert>}
        {!r || r.policy === 'hidden' ? (
          <p className="text-lg text-slate-700">수고했어요! 결과는 선생님께서 알려 주실 거예요.</p>
        ) : (
          <div className="space-y-4">
            <div className="rounded-2xl bg-blue-50 p-5">
              <div className="text-slate-600">내 점수</div>
              <div className="text-5xl font-extrabold text-blue-700 tabular-nums">
                {r.score ?? 0}
                <span className="text-2xl text-slate-500"> / {r.maxScore}</span>
              </div>
              {r.gradingPending && <p className="mt-2 text-sm text-amber-700">선생님이 확인 중인 문제가 있어 점수가 바뀔 수 있어요.</p>}
            </div>
            {r.items && (
              <div className="grid grid-cols-5 gap-2 sm:grid-cols-8">
                {r.items.map((it) => (
                  <div
                    key={it.no}
                    className={cx(
                      'rounded-xl py-2 text-center font-bold',
                      it.correct === null ? 'bg-amber-100 text-amber-800' : it.correct ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-700',
                    )}
                    aria-label={`${it.no}번 ${it.correct === null ? '확인 중' : it.correct ? '맞음' : '틀림'}`}
                  >
                    <div className="text-xs opacity-70">{it.no}번</div>
                    {it.correct === null ? '?' : it.correct ? 'O' : 'X'}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        <Button size="lg" onClick={onBack} className="w-full">
          시험 목록으로
        </Button>
      </div>
    </div>
  );
}
