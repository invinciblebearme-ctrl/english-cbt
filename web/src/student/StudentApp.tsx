import { useEffect, useState, type FormEvent } from 'react';
import { Link, Route, Routes, useNavigate } from 'react-router-dom';
import { errorMessage, studentApi, studentToken } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { Alert, Button, Empty, Spinner, inputClass } from '../components/ui';
import ExamRunner from './ExamRunner';

export default function StudentApp() {
  return (
    <Routes>
      <Route path="/" element={<Login />} />
      <Route path="/exams" element={<ExamList />} />
      <Route path="/exam/:attemptId" element={<ExamRunner />} />
      <Route path="*" element={<Login />} />
    </Routes>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gradient-to-b from-blue-50 to-white">
      <header className="mx-auto flex max-w-3xl items-center justify-between px-5 py-5">
        <div className="flex items-center gap-2 text-xl font-extrabold text-blue-700">
          <span className="rounded-xl bg-blue-600 px-2 py-1 text-white">ABC</span> 영어 평가
        </div>
        <Link to="/admin" className="text-sm text-slate-400 hover:text-slate-600">
          선생님
        </Link>
      </header>
      <main className="mx-auto max-w-3xl px-5 pb-16">{children}</main>
    </div>
  );
}

function Login() {
  const nav = useNavigate();
  const [f, setF] = useState({ grade: '', classNo: '', number: '', name: '', code: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (studentToken.get()) nav('/exams', { replace: true });
  }, [nav]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!f.grade || !f.classNo || !f.number || !f.name.trim() || !f.code.trim()) return setError('모든 칸을 채워 주세요.');
    setBusy(true);
    try {
      const r = await studentApi.post<{ token: string }>('/api/student/login', {
        grade: Number(f.grade),
        classNo: Number(f.classNo),
        number: Number(f.number),
        name: f.name,
        code: f.code,
      });
      studentToken.set(r.token);
      nav('/exams');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const num = (k: 'grade' | 'classNo' | 'number', label: string, max: number) => (
    <label className="flex flex-col gap-1">
      <span className="text-base font-bold text-slate-700">{label}</span>
      <input
        inputMode="numeric"
        pattern="[0-9]*"
        maxLength={2}
        value={f[k]}
        onChange={(e) => setF({ ...f, [k]: e.target.value.replace(/\D/g, '').slice(0, 2) })}
        className={inputClass + ' text-center text-2xl font-bold'}
        aria-label={label}
        max={max}
      />
    </label>
  );

  return (
    <Shell>
      <form onSubmit={submit} className="mx-auto mt-4 max-w-md space-y-5 rounded-3xl bg-white p-7 shadow-lg ring-1 ring-blue-100">
        <div className="text-center">
          <h1 className="text-3xl font-extrabold text-slate-900">시험 입장</h1>
          <p className="mt-2 text-slate-500">선생님께 받은 나의 응시 코드를 입력하세요.</p>
        </div>
        <div className="grid grid-cols-3 gap-3">
          {num('grade', '학년', 6)}
          {num('classNo', '반', 30)}
          {num('number', '번호', 99)}
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-base font-bold text-slate-700">이름</span>
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={20} autoComplete="off" className={inputClass + ' text-xl'} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-base font-bold text-slate-700">응시 코드</span>
          <input
            value={f.code}
            onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })}
            maxLength={12}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="예: AB2C-DE3F"
            className={inputClass + ' text-center font-mono text-2xl tracking-widest'}
          />
        </label>
        <Alert>{error}</Alert>
        <Button type="submit" size="lg" className="w-full" loading={busy}>
          들어가기
        </Button>
      </form>
    </Shell>
  );
}

interface ExamCard {
  id: string;
  title: string;
  description: string;
  startAt: number | null;
  endAt: number | null;
  durationMin: number;
  itemCount: number;
  attemptId: string | null;
  state: 'available' | 'in_progress' | 'submitted' | 'upcoming' | 'closed';
}

function ExamList() {
  const nav = useNavigate();
  const [data, setData] = useState<{ student: { name: string; grade: number; classNo: number; number: number }; exams: ExamCard[] } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const load = () =>
    studentApi
      .get('/api/student/exams')
      .then(setData)
      .catch((e) => {
        if (e.status === 401) {
          studentToken.clear();
          nav('/', { replace: true });
        } else setError(errorMessage(e));
      });

  useEffect(() => {
    if (!studentToken.get()) nav('/', { replace: true });
    else void load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function start(ex: ExamCard) {
    if (ex.state === 'available' && !confirm(`「${ex.title}」 시험을 시작할까요?\n시작하면 ${ex.durationMin}분 동안 시간이 흐릅니다.`)) return;
    setBusy(ex.id);
    setError('');
    try {
      const r = await studentApi.post<{ attemptId: string }>(`/api/student/exams/${ex.id}/start`);
      nav(`/exam/${r.attemptId}`);
    } catch (e) {
      setError(errorMessage(e));
      void load();
    } finally {
      setBusy('');
    }
  }

  async function logout() {
    await studentApi.post('/api/student/logout').catch(() => {});
    studentToken.clear();
    nav('/', { replace: true });
  }

  if (!data) return <Shell>{error ? <Alert>{error}</Alert> : <Spinner />}</Shell>;
  const s = data.student;
  return (
    <Shell>
      <div className="mb-5 flex items-center justify-between rounded-2xl bg-white p-5 shadow-sm ring-1 ring-blue-100">
        <div>
          <div className="text-sm text-slate-500">
            {s.grade}학년 {s.classNo}반 {s.number}번
          </div>
          <div className="text-2xl font-bold">{s.name} 학생, 안녕하세요!</div>
        </div>
        <Button variant="secondary" onClick={logout}>
          나가기
        </Button>
      </div>
      <Alert onClose={() => setError('')}>{error}</Alert>
      <h1 className="mt-6 mb-3 text-xl font-bold">볼 수 있는 시험</h1>
      {data.exams.length === 0 ? (
        <Empty>지금 볼 수 있는 시험이 없습니다. 선생님께 확인하세요.</Empty>
      ) : (
        <ul className="space-y-4">
          {data.exams.map((ex) => (
            <li key={ex.id} className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-xl font-bold break-words">{ex.title}</h2>
                  <p className="mt-1 text-slate-500">
                    {ex.itemCount}문제 · {ex.durationMin}분{ex.endAt ? ` · ${formatDateTime(ex.endAt)}까지` : ''}
                  </p>
                  {ex.description && <p className="mt-2 whitespace-pre-line text-slate-700">{ex.description}</p>}
                </div>
                {ex.state === 'available' && (
                  <Button size="lg" loading={busy === ex.id} onClick={() => start(ex)}>
                    시험 시작
                  </Button>
                )}
                {ex.state === 'in_progress' && (
                  <Button size="lg" loading={busy === ex.id} onClick={() => start(ex)}>
                    이어서 풀기
                  </Button>
                )}
                {ex.state === 'submitted' && (
                  <Button size="lg" variant="secondary" onClick={() => ex.attemptId && nav(`/exam/${ex.attemptId}`)}>
                    제출 완료 · 결과 보기
                  </Button>
                )}
                {ex.state === 'upcoming' && <span className="rounded-xl bg-slate-100 px-4 py-3 font-semibold text-slate-600">{formatDateTime(ex.startAt)} 시작</span>}
                {ex.state === 'closed' && <span className="rounded-xl bg-slate-100 px-4 py-3 font-semibold text-slate-500">응시 기간 종료</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}
