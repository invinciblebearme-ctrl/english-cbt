import { Link, useNavigate } from 'react-router-dom';
import { EXAM_STATUS_LABELS, type ExamStatus } from '../../../shared/types';
import { adminApi } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { Alert, Badge, Button, Empty, Spinner } from '../components/ui';
import { useAction, useLoad } from './useLoad';

export interface ExamSummary {
  id: string;
  title: string;
  grade: number;
  unit: number;
  status: ExamStatus;
  durationMin: number;
  startAt: number | null;
  endAt: number | null;
  itemCount: number;
  targetCount: number;
  attemptCount: number;
  submittedCount: number;
  createdAt: number;
}

export const statusBadge = (s: ExamStatus) => <Badge color={s === 'published' ? 'green' : s === 'closed' ? 'slate' : 'amber'}>{EXAM_STATUS_LABELS[s]}</Badge>;

export default function Exams() {
  const nav = useNavigate();
  const { data, error, reload } = useLoad(() => adminApi.get<ExamSummary[]>('/api/admin/exams'));
  const act = useAction();

  async function create() {
    await act.run('new', async () => {
      const r = await adminApi.post<{ id: string }>('/api/admin/exams', { title: '새 시험', grade: 4, unit: 1, durationMin: 40, audioPlayLimit: 2, resultPolicy: 'hidden' });
      nav(`/admin/exams/${r.id}`);
    });
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">시험 관리</h1>
        <Button onClick={create} loading={act.busy === 'new'}>
          + 시험 만들기
        </Button>
      </div>
      <Alert onClose={() => act.setError('')}>{error || act.error}</Alert>
      <Alert kind="success" onClose={() => act.setNotice('')}>
        {act.notice}
      </Alert>
      {!data ? (
        <Spinner />
      ) : data.length === 0 ? (
        <Empty>아직 만든 시험이 없습니다.</Empty>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-slate-50 text-left text-slate-600">
              <tr>
                <th className="px-4 py-3">시험</th>
                <th>상태</th>
                <th>문항</th>
                <th>응시 기간</th>
                <th>제출 / 대상</th>
                <th className="px-4 text-right">관리</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.map((e) => (
                <tr key={e.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <Link to={`/admin/exams/${e.id}`} className="font-semibold text-blue-700 hover:underline">
                      {e.title}
                    </Link>
                    <div className="text-xs text-slate-500">
                      {e.grade}학년 {e.unit}단원 · {e.durationMin}분
                    </div>
                  </td>
                  <td>{statusBadge(e.status)}</td>
                  <td>{e.itemCount}문항</td>
                  <td className="text-slate-600">{e.startAt || e.endAt ? `${formatDateTime(e.startAt)} ~ ${formatDateTime(e.endAt)}` : '제한 없음'}</td>
                  <td>
                    {e.submittedCount} / {e.targetCount}명
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <Link to={`/admin/exams/${e.id}`} className="rounded-xl px-3 py-1.5 text-sm font-semibold text-blue-700 hover:bg-blue-50">
                      편집
                    </Link>
                    <Link to={`/admin/results/${e.id}`} className="rounded-xl px-3 py-1.5 text-sm font-semibold text-blue-700 hover:bg-blue-50">
                      성적
                    </Link>
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={act.busy === 'dup' + e.id}
                      onClick={() => act.run('dup' + e.id, () => adminApi.post(`/api/admin/exams/${e.id}/duplicate`).then(reload), '시험을 복제했습니다.')}
                    >
                      복제
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-red-600 hover:bg-red-50"
                      disabled={e.status === 'published'}
                      title={e.status === 'published' ? '공개 중인 시험은 비공개로 바꾼 뒤 삭제할 수 있습니다.' : undefined}
                      onClick={() =>
                        confirm(`「${e.title}」 시험을 삭제할까요?${e.attemptCount ? '\n응시 기록이 있어 성적은 보존되고 목록에서만 숨겨집니다.' : ''}`) &&
                        act.run('del' + e.id, () => adminApi.del(`/api/admin/exams/${e.id}`).then(reload), '삭제했습니다.')
                      }
                    >
                      삭제
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
