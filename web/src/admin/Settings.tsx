import { useState, type FormEvent } from 'react';
import { adminApi } from '../lib/api';
import { formatFullDateTime } from '../lib/format';
import { Alert, Badge, Button, Card, Field, Spinner, inputClass } from '../components/ui';
import type { AdminInfo } from './AdminApp';
import { useAction, useLoad } from './useLoad';

export default function Settings({ admin }: { admin: AdminInfo }) {
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">설정</h1>
      <div className="grid gap-5 lg:grid-cols-2">
        <PasswordCard />
        {admin.role === 'owner' && <TeachersCard me={admin.id} />}
      </div>
      {admin.role === 'owner' && <AuditCard />}
    </div>
  );
}

function PasswordCard() {
  const [f, setF] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const act = useAction();
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (f.newPassword !== f.confirm) return act.setError('새 비밀번호 확인이 일치하지 않습니다.');
    const ok = await act.run('pw', () => adminApi.post('/api/admin/auth/password', f), '비밀번호를 바꿨습니다. 다른 기기의 로그인은 모두 종료되었습니다.');
    if (ok) setF({ currentPassword: '', newPassword: '', confirm: '' });
  }
  return (
    <Card title="비밀번호 변경">
      <form onSubmit={submit} className="space-y-3">
        <Field label="현재 비밀번호">{(i) => <input id={i} type="password" className={inputClass} value={f.currentPassword} onChange={(e) => setF({ ...f, currentPassword: e.target.value })} autoComplete="current-password" />}</Field>
        <Field label="새 비밀번호" hint="10자 이상, 영문과 숫자 포함">
          {(i) => <input id={i} type="password" className={inputClass} value={f.newPassword} onChange={(e) => setF({ ...f, newPassword: e.target.value })} autoComplete="new-password" />}
        </Field>
        <Field label="새 비밀번호 확인">{(i) => <input id={i} type="password" className={inputClass} value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} autoComplete="new-password" />}</Field>
        <Alert>{act.error}</Alert>
        <Alert kind="success">{act.notice}</Alert>
        <Button type="submit" loading={act.busy === 'pw'}>
          변경
        </Button>
      </form>
    </Card>
  );
}

function TeachersCard({ me }: { me: string }) {
  const { data, reload, error } = useLoad(() => adminApi.get<any[]>('/api/admin/admins'));
  const [f, setF] = useState({ username: '', displayName: '', email: '', password: '' });
  const act = useAction();
  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await act.run('add', () => adminApi.post('/api/admin/admins', f).then(reload), '교사 계정을 만들었습니다.');
    if (ok) setF({ username: '', displayName: '', email: '', password: '' });
  }
  return (
    <Card title="교사 계정 관리">
      <Alert>{error || act.error}</Alert>
      <Alert kind="success">{act.notice}</Alert>
      {!data ? (
        <Spinner />
      ) : (
        <ul className="mb-4 divide-y divide-slate-100">
          {data.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-2 py-2 text-sm">
              <span>
                <b>{a.display_name}</b> <span className="text-slate-500">({a.username})</span> {a.role === 'owner' && <Badge color="blue">최고 관리자</Badge>}{' '}
                {!a.active && <Badge color="red">비활성</Badge>}
              </span>
              {a.id !== me && (
                <Button size="sm" variant="ghost" onClick={() => act.run('t' + a.id, () => adminApi.put(`/api/admin/admins/${a.id}`, { active: !a.active }).then(reload))}>
                  {a.active ? '비활성화' : '활성화'}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={submit} className="grid grid-cols-2 gap-2">
        <input aria-label="아이디" placeholder="아이디" className={inputClass} value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} />
        <input aria-label="이름" placeholder="이름" className={inputClass} value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} />
        <input aria-label="이메일" placeholder="이메일 (Access 사용 시)" className={inputClass} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        <input aria-label="초기 비밀번호" type="password" placeholder="초기 비밀번호" className={inputClass} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" />
        <Button type="submit" className="col-span-2" loading={act.busy === 'add'}>
          교사 계정 추가
        </Button>
      </form>
    </Card>
  );
}

const ACTIONS: Record<string, string> = {
  'admin.setup': '최초 설정',
  'admin.login': '로그인',
  'admin.logout': '로그아웃',
  'admin.password_change': '비밀번호 변경',
  'admin.create': '교사 계정 생성',
  'admin.activate': '계정 활성화',
  'admin.deactivate': '계정 비활성화',
  'media.upload': '파일 업로드',
  'question.create': '문제 등록',
  'question.update': '문제 수정',
  'question.duplicate': '문제 복제',
  'question.delete': '문제 삭제',
  'exam.create': '시험 생성',
  'exam.update': '시험 수정',
  'exam.publish': '시험 공개',
  'exam.unpublish': '시험 비공개',
  'exam.close': '시험 종료',
  'exam.duplicate': '시험 복제',
  'exam.delete': '시험 삭제',
  'exam.targets': '응시 대상 지정',
  'class.create': '학급 생성',
  'class.delete': '학급 삭제',
  'student.create': '학생 등록',
  'student.update': '학생 수정',
  'student.delete': '학생 삭제',
  'student.deactivate': '학생 비활성화',
  'student.bulk': '학생 일괄 등록',
  'code.issue': '응시 코드 발급',
  'code.revoke': '응시 코드 중지',
  'grade.manual': '수동 채점',
  'attempt.force_submit': '응시 강제 마감',
  'attempt.reset': '재응시 허용',
};

function AuditCard() {
  const { data, error } = useLoad(() => adminApi.get<any[]>('/api/admin/audit-logs'));
  return (
    <Card title="관리자 활동 기록 (최근 300건)">
      <Alert>{error}</Alert>
      {!data ? (
        <Spinner />
      ) : (
        <div className="max-h-96 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white text-left text-slate-500">
              <tr>
                <th className="py-2">시각</th>
                <th>교사</th>
                <th>작업</th>
                <th>IP</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.map((l) => (
                <tr key={l.id}>
                  <td className="py-1.5 whitespace-nowrap text-slate-500">{formatFullDateTime(l.created_at)}</td>
                  <td>{l.admin_name || '-'}</td>
                  <td>{ACTIONS[l.action] || l.action}</td>
                  <td className="text-slate-400">{l.ip}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
