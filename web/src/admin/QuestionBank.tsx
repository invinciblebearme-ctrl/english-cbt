import { useState } from 'react';
import { DOMAINS, QUESTION_TYPES, QUESTION_TYPE_LABELS, DIFFICULTY_LABELS } from '../../../shared/types';
import { adminApi } from '../lib/api';
import { Alert, Badge, Button, Card, Empty, Spinner, inputClass } from '../components/ui';
import QuestionEditor, { emptyQuestion } from './QuestionEditor';
import { answerSummary, type Question } from './types';
import { useAction, useLoad } from './useLoad';

export default function QuestionBank() {
  const [filter, setFilter] = useState({ grade: '', unit: '', domain: '', type: '', status: '', q: '' });
  const [applied, setApplied] = useState(filter);
  const qs = new URLSearchParams(Object.entries(applied).filter(([, v]) => v)).toString();
  const { data, error, reload } = useLoad(() => adminApi.get<Question[]>(`/api/admin/questions?${qs}`), [qs]);
  const [editing, setEditing] = useState<Question | ReturnType<typeof emptyQuestion> | null>(null);
  const act = useAction();

  const sel = (k: keyof typeof filter, label: string, options: [string, string][]) => (
    <select aria-label={label} className={inputClass} value={filter[k]} onChange={(e) => {
        const next = { ...filter, [k]: e.target.value };
        setFilter(next);
        setApplied(next);
      }}>
      <option value="">{label} 전체</option>
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">문제은행</h1>
        <Button
          onClick={() =>
            setEditing(emptyQuestion({ grade: Number(applied.grade) || 4, unit: Number(applied.unit) || 1, domain: (applied.domain as never) || '읽기' }))
          }
        >
          + 새 문제
        </Button>
      </div>

      <Card>
        <form
          className="grid grid-cols-2 gap-2 md:grid-cols-7"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied(filter);
          }}
        >
          {sel('grade', '학년', [1, 2, 3, 4, 5, 6].map((g) => [String(g), `${g}학년`]))}
          <input aria-label="단원" type="number" min={1} placeholder="단원" className={inputClass} value={filter.unit} onChange={(e) => setFilter({ ...filter, unit: e.target.value })} />
          {sel('domain', '영역', DOMAINS.map((d) => [d, d]))}
          {sel('type', '유형', QUESTION_TYPES.map((t) => [t, QUESTION_TYPE_LABELS[t]]))}
          {sel('status', '상태', [
            ['ready', '완성'],
            ['draft', '임시 저장'],
          ])}
          <input aria-label="검색어" placeholder="문제 내용 검색" className={inputClass} value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} />
          <Button type="submit" variant="secondary">
            검색
          </Button>
        </form>
      </Card>

      <Alert onClose={() => act.setError('')}>{error || act.error}</Alert>
      <Alert kind="success" onClose={() => act.setNotice('')}>
        {act.notice}
      </Alert>

      {!data ? (
        <Spinner />
      ) : data.length === 0 ? (
        <Empty>조건에 맞는 문제가 없습니다. 「+ 새 문제」로 등록하세요.</Empty>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full min-w-[800px] text-sm">
            <thead className="bg-slate-50 text-left text-slate-600">
              <tr>
                <th className="px-4 py-3">학년·단원</th>
                <th>영역 / 유형</th>
                <th className="w-[38%]">문제</th>
                <th>정답</th>
                <th>배점</th>
                <th>상태</th>
                <th className="px-4 text-right">관리</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.map((q) => (
                <tr key={q.id} className="align-top hover:bg-slate-50">
                  <td className="px-4 py-3 whitespace-nowrap">
                    {q.grade}학년 {q.unit}단원
                  </td>
                  <td className="py-3">
                    <div>{q.domain}</div>
                    <div className="text-xs text-slate-500">{QUESTION_TYPE_LABELS[q.type]}</div>
                  </td>
                  <td className="py-3 pr-3">
                    <button type="button" className="text-left font-medium text-slate-900 hover:text-blue-700 hover:underline" onClick={() => setEditing(q)}>
                      {q.prompt || <span className="text-slate-400">(내용 없음)</span>}
                    </button>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {q.imageMediaId && <Badge>🖼 그림</Badge>}
                      {q.audioMediaId && <Badge>🔊 음성</Badge>}
                      <Badge>{DIFFICULTY_LABELS[q.difficulty]}</Badge>
                    </div>
                    {q.issues.length > 0 && <div className="mt-1 text-xs text-amber-700">⚠ {q.issues.join(' ')}</div>}
                  </td>
                  <td className="max-w-40 py-3 break-words text-slate-600">{answerSummary(q)}</td>
                  <td className="py-3">{q.points}</td>
                  <td className="py-3">{q.status === 'ready' && !q.issues.length ? <Badge color="green">완성</Badge> : <Badge color="amber">임시 저장</Badge>}</td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(q)}>
                      수정
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={act.busy === 'dup' + q.id}
                      onClick={() => act.run('dup' + q.id, () => adminApi.post(`/api/admin/questions/${q.id}/duplicate`).then(reload), '문제를 복제했습니다. (임시 저장 상태)')}
                    >
                      복제
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-red-600 hover:bg-red-50"
                      loading={act.busy === 'del' + q.id}
                      onClick={() => confirm('이 문제를 삭제할까요?\n이미 공개된 시험에 들어간 문제는 그 시험에 그대로 남습니다.') && act.run('del' + q.id, () => adminApi.del(`/api/admin/questions/${q.id}`).then(reload), '삭제했습니다.')}
                    >
                      삭제
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="border-t border-slate-100 px-4 py-2 text-sm text-slate-500">총 {data.length}문제</div>
        </div>
      )}

      {editing && (
        <QuestionEditor
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={(q) => {
            setEditing(null);
            act.setNotice(q.status === 'ready' ? '문제를 저장했습니다.' : '임시 저장했습니다. 자료를 채운 뒤 완성으로 저장하세요.');
            void reload();
          }}
        />
      )}
    </div>
  );
}
