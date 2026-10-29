import { useMemo, useState, type FormEvent } from 'react';
import { adminApi } from '../lib/api';
import { download, parseCsv, toCsv } from '../lib/exporters';
import { formatDateTime } from '../lib/format';
import { Alert, Badge, Button, Card, Empty, Field, Modal, Spinner, inputClass } from '../components/ui';
import { useAction, useLoad } from './useLoad';

export interface ClassRow {
  id: string;
  school_year: number;
  grade: number;
  class_no: number;
  name: string;
  student_count: number;
}
export interface StudentRow {
  id: string;
  class_id: string;
  number: number;
  name: string;
  active: number;
  school_year: number;
  grade: number;
  class_no: number;
  code_issued_at: number | null;
  code_first_used_at: number | null;
  code_last_used_at: number | null;
  code_use_count: number | null;
  code_issue_count: number;
}
interface IssuedCode {
  studentId: string;
  grade: number;
  classNo: number;
  number: number;
  name: string;
  code: string;
}

const thisYear = () => {
  const d = new Date();
  return d.getMonth() < 2 ? d.getFullYear() - 1 : d.getFullYear();
};

export default function Students() {
  const { data, error, reload } = useLoad(async () => {
    const [classes, students] = await Promise.all([adminApi.get<ClassRow[]>('/api/admin/classes'), adminApi.get<StudentRow[]>('/api/admin/students')]);
    return { classes, students };
  });
  const [classId, setClassId] = useState('');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [codes, setCodes] = useState<IssuedCode[] | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [history, setHistory] = useState<StudentRow | null>(null);
  const act = useAction();

  const list = useMemo(() => (data ? data.students.filter((s) => !classId || s.class_id === classId) : []), [data, classId]);
  if (error && !data) return <Alert>{error}</Alert>;
  if (!data) return <Spinner />;

  const selectedIds = list.filter((s) => checked.has(s.id) && s.active).map((s) => s.id);
  const toggle = (id: string, on: boolean) => {
    const n = new Set(checked);
    if (on) n.add(id);
    else n.delete(id);
    setChecked(n);
  };

  async function issue(ids: string[], onlyMissing = false) {
    if (!ids.length) return act.setError('코드를 발급할 학생을 선택하세요.');
    const already = list.filter((s) => ids.includes(s.id) && s.code_issued_at).length;
    if (!onlyMissing && already && !confirm(`${already}명은 이미 코드가 있습니다. 새로 발급하면 이전 코드는 사용할 수 없게 됩니다. 계속할까요?`)) return;
    await act.run('codes', async () => {
      const r = await adminApi.post<{ codes: IssuedCode[] }>('/api/admin/students/codes', { studentIds: ids, onlyMissing });
      if (!r.codes.length) throw new Error('새로 발급할 학생이 없습니다. (모두 코드가 있음)');
      setCodes(r.codes);
      await reload();
    });
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">학생 관리</h1>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setBulkOpen(true)}>
            📋 일괄 등록 (CSV·붙여넣기)
          </Button>
        </div>
      </div>
      <Alert onClose={() => act.setError('')}>{act.error || error}</Alert>
      <Alert kind="success" onClose={() => act.setNotice('')}>
        {act.notice}
      </Alert>

      <div className="grid gap-5 lg:grid-cols-[16rem_1fr]">
        <div className="space-y-4">
          <Card title="학급">
            <ul className="space-y-1">
              <li>
                <button type="button" onClick={() => setClassId('')} className={`w-full rounded-lg px-3 py-2 text-left ${!classId ? 'bg-blue-50 font-semibold text-blue-700' : 'hover:bg-slate-50'}`}>
                  전체 ({data.students.filter((s) => s.active).length}명)
                </button>
              </li>
              {data.classes.map((c) => (
                <li key={c.id} className="group flex items-center">
                  <button type="button" onClick={() => setClassId(c.id)} className={`flex-1 rounded-lg px-3 py-2 text-left ${classId === c.id ? 'bg-blue-50 font-semibold text-blue-700' : 'hover:bg-slate-50'}`}>
                    {c.grade}학년 {c.class_no}반 <span className="text-xs text-slate-500">({c.student_count}명 · {c.school_year})</span>
                  </button>
                  <button
                    type="button"
                    className="px-2 text-sm text-red-500 opacity-0 group-hover:opacity-100 focus:opacity-100"
                    aria-label={`${c.grade}학년 ${c.class_no}반 삭제`}
                    onClick={() => confirm(`${c.grade}학년 ${c.class_no}반과 소속 학생을 모두 삭제할까요?`) && act.run('delc', () => adminApi.del(`/api/admin/classes/${c.id}`).then(reload), '학급을 삭제했습니다.')}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
            <AddClass onAdded={reload} act={act} />
          </Card>
          {classId && <AddStudent classId={classId} onAdded={reload} act={act} nextNumber={Math.max(0, ...list.map((s) => s.number)) + 1} />}
        </div>

        <Card
          title={`학생 목록 (${list.filter((s) => s.active).length}명)`}
          actions={
            <>
              <Button size="sm" variant="secondary" loading={act.busy === 'codes'} onClick={() => issue(list.filter((s) => s.active).map((s) => s.id), true)}>
                코드 없는 학생 모두 발급
              </Button>
              <Button size="sm" loading={act.busy === 'codes'} disabled={!selectedIds.length} onClick={() => issue(selectedIds)}>
                선택 학생 코드 발급/재발급 ({selectedIds.length})
              </Button>
            </>
          }
        >
          {list.length === 0 ? (
            <Empty>학생이 없습니다. 학급을 선택해 학생을 추가하거나 일괄 등록하세요.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px] text-sm">
                <thead className="text-left text-slate-500">
                  <tr>
                    <th className="w-8 py-2">
                      <input
                        type="checkbox"
                        aria-label="전체 선택"
                        checked={list.length > 0 && list.every((s) => checked.has(s.id))}
                        onChange={(e) => setChecked(e.target.checked ? new Set(list.map((s) => s.id)) : new Set())}
                      />
                    </th>
                    <th>학년-반-번호</th>
                    <th>이름</th>
                    <th>응시 코드 상태</th>
                    <th className="text-right">관리</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {list.map((s) => (
                    <StudentLine key={s.id} s={s} checked={checked.has(s.id)} onCheck={(on) => toggle(s.id, on)} reload={reload} act={act} onHistory={() => setHistory(s)} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-3 text-xs text-slate-500">응시 코드는 보안을 위해 발급 직후에만 볼 수 있습니다. 잃어버린 학생은 재발급하세요.</p>
        </Card>
      </div>

      {codes && <CodeSheet codes={codes} onClose={() => setCodes(null)} />}
      {bulkOpen && (
        <BulkImport
          onClose={() => setBulkOpen(false)}
          onDone={(msg) => {
            setBulkOpen(false);
            act.setNotice(msg);
            void reload();
          }}
        />
      )}
      {history && <HistoryModal s={history} onClose={() => setHistory(null)} />}
    </div>
  );
}

type Act = ReturnType<typeof useAction>;

function StudentLine({ s, checked, onCheck, reload, act, onHistory }: { s: StudentRow; checked: boolean; onCheck: (on: boolean) => void; reload: () => Promise<void>; act: Act; onHistory: () => void }) {
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState({ number: String(s.number), name: s.name });
  const code = !s.active ? (
    <Badge>비활성</Badge>
  ) : !s.code_issued_at ? (
    <Badge color="red">미발급</Badge>
  ) : s.code_first_used_at ? (
    <span className="flex flex-wrap items-center gap-1">
      <Badge color="green">사용됨 {s.code_use_count}회</Badge>
      <span className="text-xs text-slate-500">최근 {formatDateTime(s.code_last_used_at)}</span>
    </span>
  ) : (
    <span className="flex flex-wrap items-center gap-1">
      <Badge color="blue">발급됨 · 미사용</Badge>
      <span className="text-xs text-slate-500">{formatDateTime(s.code_issued_at)}</span>
    </span>
  );
  return (
    <tr className={s.active ? '' : 'text-slate-400'}>
      <td className="py-2">
        <input type="checkbox" checked={checked} onChange={(e) => onCheck(e.target.checked)} aria-label={`${s.name} 선택`} disabled={!s.active} />
      </td>
      <td className="whitespace-nowrap">
        {s.grade}-{s.class_no}-{edit ? <input className="w-14 rounded border px-1" value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} aria-label="번호" /> : s.number}
      </td>
      <td>{edit ? <input className="w-28 rounded border px-1" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} aria-label="이름" /> : s.name}</td>
      <td>{code}</td>
      <td className="text-right whitespace-nowrap">
        {edit ? (
          <>
            <Button size="sm" onClick={() => act.run('edit' + s.id, () => adminApi.put(`/api/admin/students/${s.id}`, { number: Number(f.number), name: f.name }).then(reload), '수정했습니다.').then((ok) => ok && setEdit(false))}>
              저장
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEdit(false)}>
              취소
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="ghost" onClick={onHistory}>
              응시 현황
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEdit(true)} disabled={!s.active}>
              수정
            </Button>
            {s.code_issued_at && s.active ? (
              <Button size="sm" variant="ghost" onClick={() => confirm(`${s.name} 학생의 응시 코드를 사용 중지할까요?`) && act.run('rv' + s.id, () => adminApi.post(`/api/admin/students/${s.id}/revoke-code`).then(reload), '코드를 사용 중지했습니다.')}>
                코드 중지
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              className="text-red-600 hover:bg-red-50"
              onClick={() => confirm(`${s.name} 학생을 삭제할까요?\n응시 기록이 있으면 성적 보존을 위해 비활성화만 됩니다.`) && act.run('del' + s.id, () => adminApi.del(`/api/admin/students/${s.id}`).then(reload), '처리했습니다.')}
            >
              삭제
            </Button>
          </>
        )}
      </td>
    </tr>
  );
}

function AddClass({ onAdded, act }: { onAdded: () => Promise<void>; act: Act }) {
  const [f, setF] = useState({ schoolYear: String(thisYear()), grade: '4', classNo: '' });
  async function submit(e: FormEvent) {
    e.preventDefault();
    await act.run('class', () => adminApi.post('/api/admin/classes', { schoolYear: Number(f.schoolYear), grade: Number(f.grade), classNo: Number(f.classNo) }).then(onAdded), '학급을 만들었습니다.');
  }
  return (
    <form onSubmit={submit} className="mt-4 space-y-2 border-t border-slate-100 pt-4">
      <div className="text-sm font-semibold">학급 만들기</div>
      <div className="grid grid-cols-3 gap-2">
        <input aria-label="학년도" className={inputClass + ' px-2'} value={f.schoolYear} onChange={(e) => setF({ ...f, schoolYear: e.target.value })} />
        <select aria-label="학년" className={inputClass + ' px-2'} value={f.grade} onChange={(e) => setF({ ...f, grade: e.target.value })}>
          {[1, 2, 3, 4, 5, 6].map((g) => (
            <option key={g} value={g}>
              {g}학년
            </option>
          ))}
        </select>
        <input aria-label="반" placeholder="반" className={inputClass + ' px-2'} value={f.classNo} onChange={(e) => setF({ ...f, classNo: e.target.value })} />
      </div>
      <Button type="submit" size="sm" variant="secondary" className="w-full" loading={act.busy === 'class'}>
        추가
      </Button>
    </form>
  );
}

function AddStudent({ classId, onAdded, act, nextNumber }: { classId: string; onAdded: () => Promise<void>; act: Act; nextNumber: number }) {
  const [f, setF] = useState({ number: '', name: '' });
  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await act.run('stu', () => adminApi.post('/api/admin/students', { classId, number: Number(f.number || nextNumber), name: f.name }).then(onAdded), '학생을 등록했습니다.');
    if (ok) setF({ number: '', name: '' });
  }
  return (
    <Card title="학생 개별 등록">
      <form onSubmit={submit} className="space-y-2">
        <div className="grid grid-cols-[5rem_1fr] gap-2">
          <Field label="번호">{(i) => <input id={i} className={inputClass} placeholder={String(nextNumber)} value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} />}</Field>
          <Field label="이름">{(i) => <input id={i} className={inputClass} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        </div>
        <Button type="submit" className="w-full" loading={act.busy === 'stu'}>
          등록
        </Button>
      </form>
    </Card>
  );
}

function BulkImport({ onClose, onDone }: { onClose: () => void; onDone: (msg: string) => void }) {
  const [text, setText] = useState('');
  const [year, setYear] = useState(String(thisYear()));
  const act = useAction();
  const [errors, setErrors] = useState<string[]>([]);
  const rows = useMemo(() => {
    const parsed = parseCsv(text);
    // 첫 줄이 제목이면 건너뜀
    if (parsed[0] && isNaN(Number(parsed[0][0]))) parsed.shift();
    return parsed.map((r) => ({ grade: Number(r[0]), classNo: Number(r[1]), number: Number(r[2]), name: (r[3] || '').trim() }));
  }, [text]);

  async function submit() {
    setErrors([]);
    await act.run('bulk', async () => {
      try {
        const r = await adminApi.post<{ created: number; updated: number }>('/api/admin/students/bulk', { schoolYear: Number(year), rows });
        onDone(`${r.created}명 새로 등록, ${r.updated}명 정보 갱신했습니다.`);
      } catch (e) {
        const d = (e as { data?: { errors?: string[] } }).data;
        if (d?.errors) setErrors(d.errors);
        throw e;
      }
    });
  }

  return (
    <Modal
      wide
      title="학생 일괄 등록"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={() => download('학생명단_양식.csv', toCsv([['학년', '반', '번호', '이름'], [4, 1, 1, '홍길동']]), 'text/csv;charset=utf-8')}>
            양식 내려받기
          </Button>
          <Button onClick={submit} disabled={!rows.length} loading={act.busy === 'bulk'}>
            {rows.length}명 등록
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-slate-600">
          엑셀에서 <b>학년, 반, 번호, 이름</b> 네 칸을 복사해 붙여넣거나 CSV 파일을 선택하세요. 같은 학년·반·번호가 이미 있으면 이름을 새로 바꿉니다.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="학년도">{(i) => <input id={i} className={inputClass + ' w-28'} value={year} onChange={(e) => setYear(e.target.value)} />}</Field>
          <label className="cursor-pointer rounded-xl border border-slate-300 px-4 py-2.5 font-semibold hover:bg-slate-50">
            CSV 파일 선택
            <input
              type="file"
              accept=".csv,text/csv,.txt"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                const buf = await f.arrayBuffer();
                let t = new TextDecoder('utf-8').decode(buf);
                // 엑셀에서 저장한 CSV(EUC-KR) 대응
                if (t.includes('�')) t = new TextDecoder('euc-kr').decode(buf);
                setText(t);
              }}
            />
          </label>
        </div>
        <textarea className={inputClass + ' font-mono text-sm'} rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder={'학년,반,번호,이름\n4,1,1,김하나\n4,1,2,이둘'} />
        {rows.length > 0 && (
          <div className="max-h-48 overflow-y-auto rounded-xl border border-slate-200">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-slate-50 text-left">
                <tr>
                  <th className="px-3 py-1">#</th>
                  <th>학년</th>
                  <th>반</th>
                  <th>번호</th>
                  <th>이름</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className={!r.grade || !r.classNo || !r.number || !r.name ? 'bg-red-50' : ''}>
                    <td className="px-3 py-1 text-slate-400">{i + 1}</td>
                    <td>{r.grade || '?'}</td>
                    <td>{r.classNo || '?'}</td>
                    <td>{r.number || '?'}</td>
                    <td>{r.name || '?'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Alert>{act.error}</Alert>
        {errors.length > 0 && <Alert>{errors.slice(0, 20).join('\n')}</Alert>}
      </div>
    </Modal>
  );
}

/** 발급한 코드를 학생별 쪽지로 인쇄 */
function CodeSheet({ codes, onClose }: { codes: IssuedCode[]; onClose: () => void }) {
  return (
    <Modal
      wide
      title={`응시 코드 ${codes.length}개 발급 완료`}
      onClose={() => confirm('창을 닫으면 코드를 다시 볼 수 없습니다. 인쇄하거나 내려받았나요?') && onClose()}
      footer={
        <>
          <Button variant="secondary" onClick={() => download('응시코드.csv', toCsv([['학년', '반', '번호', '이름', '응시 코드'], ...codes.map((c) => [c.grade, c.classNo, c.number, c.name, c.code])]), 'text/csv;charset=utf-8')}>
            CSV 내려받기
          </Button>
          <Button onClick={() => window.print()}>🖨 쪽지 인쇄</Button>
        </>
      }
    >
      <Alert kind="warning">코드는 지금만 볼 수 있습니다. 인쇄해서 잘라 학생에게 한 장씩 나눠 주세요. 다른 학생이 보지 않도록 주의하세요.</Alert>
      <div id="code-sheet" className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3">
        {codes.map((c) => (
          <div key={c.studentId} className="break-inside-avoid rounded-xl border-2 border-dashed border-slate-300 p-3">
            <div className="text-sm text-slate-600">
              {c.grade}학년 {c.classNo}반 {c.number}번
            </div>
            <div className="text-lg font-bold">{c.name}</div>
            <div className="mt-1 font-mono text-2xl font-bold tracking-widest text-blue-700">{c.code}</div>
            <div className="mt-1 text-xs text-slate-500">영어 평가 응시 코드 · 다른 사람에게 보여 주지 마세요</div>
          </div>
        ))}
      </div>
      <style>{`@media print { body * { visibility: hidden; } #code-sheet, #code-sheet * { visibility: visible; } #code-sheet { position: absolute; left: 0; top: 0; width: 100%; } }`}</style>
    </Modal>
  );
}

function HistoryModal({ s, onClose }: { s: StudentRow; onClose: () => void }) {
  const { data, error } = useLoad(() => adminApi.get<any[]>(`/api/admin/students/${s.id}/attempts`), [s.id]);
  const label: Record<string, [string, 'slate' | 'amber' | 'green']> = { in_progress: ['응시 중', 'amber'], submitted: ['제출 완료', 'green'] };
  return (
    <Modal title={`${s.grade}-${s.class_no}-${s.number} ${s.name} 응시 현황`} onClose={onClose}>
      <Alert>{error}</Alert>
      {!data ? (
        <Spinner />
      ) : data.length === 0 ? (
        <Empty>대상으로 지정된 시험이 없습니다.</Empty>
      ) : (
        <ul className="divide-y divide-slate-100">
          {data.map((r) => (
            <li key={r.exam_id} className="flex items-center justify-between gap-2 py-2">
              <span className="font-medium">{r.title}</span>
              <span className="flex items-center gap-2 text-sm">
                {r.status ? <Badge color={label[r.status][1]}>{label[r.status][0]}</Badge> : <Badge>미응시</Badge>}
                {r.status === 'submitted' && (
                  <b className="tabular-nums">
                    {r.total_score}/{r.max_score}
                  </b>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
