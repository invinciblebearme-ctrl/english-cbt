import { Link } from 'react-router-dom';
import { adminApi } from '../lib/api';
import { formatDateTime, studentLabel } from '../lib/format';
import { Alert, Badge, Card, Empty, Spinner, Stat } from '../components/ui';
import { useLoad } from './useLoad';

interface DashboardData {
  questionCount: number;
  draftQuestionCount: number;
  examCount: number;
  studentCount: number;
  submittedStudentCount: number;
  pendingGradingCount: number;
  liveExams: { id: string; title: string; end_at: number | null; targets: number; in_progress: number; submitted: number }[];
  recentResults: { id: string; title: string; name: string; number: number; grade: number; class_no: number; total_score: number; max_score: number; submitted_at: number; grading_status: string }[];
}

export default function Dashboard() {
  const { data, error } = useLoad(() => adminApi.get<DashboardData>('/api/admin/dashboard'));
  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Spinner />;
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">대시보드</h1>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Stat label="등록된 문제" value={data.questionCount} sub={data.draftQuestionCount ? `임시 저장 ${data.draftQuestionCount}개` : '모두 완성'} />
        <Stat label="생성된 시험" value={data.examCount} />
        <Stat label="등록 학생" value={data.studentCount} tone="slate" />
        <Stat label="진행 중인 시험" value={data.liveExams.length} tone="amber" />
        <Stat label="응시 완료 학생" value={data.submittedStudentCount} tone="green" sub={data.pendingGradingCount ? `수동 채점 대기 ${data.pendingGradingCount}문항` : undefined} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="진행 중인 시험">
          {data.liveExams.length === 0 ? (
            <Empty>지금 공개되어 응시할 수 있는 시험이 없습니다.</Empty>
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.liveExams.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <Link to={`/admin/results/${e.id}`} className="font-semibold text-blue-700 hover:underline">
                      {e.title}
                    </Link>
                    <div className="text-sm text-slate-500">{e.end_at ? `${formatDateTime(e.end_at)} 종료` : '종료 시간 없음'}</div>
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    <Badge color="amber">응시 중 {e.in_progress}</Badge>
                    <Badge color="green">
                      제출 {e.submitted}/{e.targets}
                    </Badge>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="최근 시험 결과">
          {data.recentResults.length === 0 ? (
            <Empty>아직 제출된 답안이 없습니다.</Empty>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-slate-500">
                <tr>
                  <th className="py-2">학생</th>
                  <th>시험</th>
                  <th className="text-right">점수</th>
                  <th className="text-right">제출</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.recentResults.map((r) => (
                  <tr key={r.id}>
                    <td className="py-2">{studentLabel(r)}</td>
                    <td className="max-w-40 truncate">{r.title}</td>
                    <td className="text-right font-semibold tabular-nums">
                      {r.total_score}/{r.max_score} {r.grading_status === 'pending' && <Badge color="amber">채점 대기</Badge>}
                    </td>
                    <td className="text-right text-slate-500">{formatDateTime(r.submitted_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </div>
  );
}
