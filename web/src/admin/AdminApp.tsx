import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { adminApi, errorMessage } from '../lib/api';
import { Alert, Button, Field, Spinner, cx, inputClass } from '../components/ui';
import Dashboard from './Dashboard';
import QuestionBank from './QuestionBank';
import Exams from './Exams';
import ExamEditor from './ExamEditor';
import Students from './Students';
import Results from './Results';
import Settings from './Settings';

export interface AdminInfo {
  id: string;
  username: string;
  displayName: string;
  role: 'owner' | 'teacher';
}

interface Status {
  setupRequired: boolean;
  accessEnabled: boolean;
  admin: AdminInfo | null;
}

export default function AdminApp() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState('');
  const refresh = useCallback(() => adminApi.get<Status>('/api/admin/auth/status').then(setStatus).catch((e) => setError(errorMessage(e))), []);
  useEffect(() => void refresh(), [refresh]);

  // 세션이 만료되면 로그인 화면으로
  useEffect(() => {
    const onExpired = () => void refresh();
    window.addEventListener('cbt-admin-expired', onExpired);
    return () => window.removeEventListener('cbt-admin-expired', onExpired);
  }, [refresh]);

  if (!status) return error ? <div className="p-6"><Alert>{error}</Alert></div> : <Spinner full />;
  if (status.setupRequired) return <AuthCard title="최초 관리자 설정"><SetupForm onDone={refresh} /></AuthCard>;
  if (!status.admin) return <AuthCard title="교사 로그인"><LoginForm onDone={refresh} accessEnabled={status.accessEnabled} /></AuthCard>;
  return <Layout admin={status.admin} onLogout={refresh} />;
}

function AuthCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-7 shadow-lg">
        <div className="mb-1 text-sm font-semibold text-blue-700">English CBT 관리자</div>
        <h1 className="mb-5 text-2xl font-bold">{title}</h1>
        {children}
      </div>
    </div>
  );
}

function LoginForm({ onDone, accessEnabled }: { onDone: () => void; accessEnabled: boolean }) {
  const [f, setF] = useState({ username: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await adminApi.post('/api/admin/auth/login', f);
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="아이디">{(id) => <input id={id} className={inputClass} value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} autoComplete="username" />}</Field>
      <Field label="비밀번호">
        {(id) => <input id={id} type="password" className={inputClass} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="current-password" />}
      </Field>
      <Alert>{error}</Alert>
      <Button type="submit" className="w-full" loading={busy}>
        로그인
      </Button>
      {accessEnabled && <p className="text-xs text-slate-500">Cloudflare Access로 로그인한 교사 계정은 자동으로 연결됩니다.</p>}
      <a href="/" className="block text-center text-sm text-slate-500 hover:underline">
        학생 시험 화면으로
      </a>
    </form>
  );
}

function SetupForm({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ setupToken: '', username: '', displayName: '', password: '', confirm: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (f.password !== f.confirm) return setError('비밀번호 확인이 일치하지 않습니다.');
    setBusy(true);
    setError('');
    try {
      await adminApi.post('/api/admin/auth/setup', f);
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  const input = (k: keyof typeof f, label: string, type = 'text', hint?: string) => (
    <Field label={label} hint={hint}>
      {(id) => <input id={id} type={type} className={inputClass} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} autoComplete="off" />}
    </Field>
  );
  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-sm text-slate-600">처음 한 번만 실행합니다. 서버에 등록한 설정 토큰(SETUP_TOKEN)을 입력하세요.</p>
      {input('setupToken', '설정 토큰', 'password')}
      {input('username', '아이디', 'text', '영문·숫자 3자 이상')}
      {input('displayName', '이름')}
      {input('password', '비밀번호', 'password', '10자 이상, 영문과 숫자 포함')}
      {input('confirm', '비밀번호 확인', 'password')}
      <Alert>{error}</Alert>
      <Button type="submit" className="w-full" loading={busy}>
        관리자 만들기
      </Button>
    </form>
  );
}

const NAV = [
  { to: '/admin', label: '대시보드', icon: '📊', end: true },
  { to: '/admin/questions', label: '문제은행', icon: '📚' },
  { to: '/admin/exams', label: '시험 관리', icon: '📝' },
  { to: '/admin/students', label: '학생 관리', icon: '👩‍🎓' },
  { to: '/admin/results', label: '성적 관리', icon: '📈' },
  { to: '/admin/settings', label: '설정', icon: '⚙️' },
];

function Layout({ admin, onLogout }: { admin: AdminInfo; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  async function logout() {
    await adminApi.post('/api/admin/auth/logout').catch(() => {});
    onLogout();
  }
  return (
    <div className="min-h-screen bg-slate-100 lg:flex">
      <aside className={cx('no-print fixed inset-y-0 left-0 z-40 w-60 transform bg-slate-900 text-slate-100 transition lg:static lg:translate-x-0', open ? 'translate-x-0' : '-translate-x-full')}>
        <div className="px-5 py-5">
          <div className="text-xs font-semibold tracking-wider text-blue-300">ENGLISH CBT</div>
          <div className="text-lg font-bold">교사 관리자</div>
        </div>
        <nav className="space-y-1 px-3">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              onClick={() => setOpen(false)}
              className={({ isActive }) => cx('flex items-center gap-3 rounded-xl px-3 py-2.5 font-medium', isActive ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-800')}
            >
              <span aria-hidden>{n.icon}</span>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="absolute inset-x-0 bottom-0 border-t border-slate-800 p-4 text-sm">
          <div className="font-semibold">{admin.displayName}</div>
          <div className="text-slate-400">{admin.role === 'owner' ? '최고 관리자' : '교사'}</div>
          <button type="button" onClick={logout} className="mt-2 text-blue-300 hover:underline">
            로그아웃
          </button>
        </div>
      </aside>
      {open && <div className="fixed inset-0 z-30 bg-black/30 lg:hidden" onClick={() => setOpen(false)} />}
      <div className="min-w-0 flex-1">
        <div className="no-print flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 lg:hidden">
          <button type="button" onClick={() => setOpen(true)} className="rounded-lg px-2 py-1 text-xl" aria-label="메뉴 열기">
            ☰
          </button>
          <span className="font-bold">English CBT 관리자</span>
        </div>
        <main className="mx-auto max-w-7xl p-4 sm:p-6">
          <Routes>
            <Route index element={<Dashboard />} />
            <Route path="questions" element={<QuestionBank />} />
            <Route path="exams" element={<Exams />} />
            <Route path="exams/:id" element={<ExamEditor />} />
            <Route path="students" element={<Students />} />
            <Route path="results" element={<Results />} />
            <Route path="results/:examId" element={<Results />} />
            <Route path="settings" element={<Settings admin={admin} />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
