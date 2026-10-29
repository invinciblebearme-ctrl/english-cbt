// 전체 흐름 통합 테스트: 관리자 설정 → 문제은행 → 학생·코드 → 시험 공개 → 응시 → 채점 → 성적
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../worker/src/env';
import { Client, createTestEnv, fileForm, MP3, PNG, SETUP_TOKEN } from './helpers';

let env: Env;
let dispose: () => Promise<void>;
let admin: Client;
const state: Record<string, any> = {};

const q = (over: Record<string, unknown>) => ({
  grade: 4,
  unit: 9,
  domain: '읽기',
  type: 'mc_text',
  prompt: '알맞은 것을 고르세요.',
  passage: '',
  imageMediaId: null,
  audioMediaId: null,
  choices: [],
  answer: {},
  points: 5,
  difficulty: 'medium',
  explanation: '해설',
  status: 'ready',
  ...over,
});

beforeAll(async () => {
  ({ env, dispose } = await createTestEnv());
  admin = new Client(env, true);
});
afterAll(async () => dispose?.());

describe('1. 관리자 인증', () => {
  it('최초 상태는 설정 필요', async () => {
    const s = await new Client(env, true).get('/api/admin/auth/status');
    expect(s.setupRequired).toBe(true);
    expect(s.admin).toBeNull();
  });
  it('관리자 API는 로그인 없이 401', async () => {
    await new Client(env, true).get('/api/admin/questions', 401);
  });
  it('설정 토큰이 틀리면 거부, 약한 비밀번호 거부', async () => {
    await admin.post('/api/admin/auth/setup', { setupToken: 'wrong', username: 'teacher', password: 'abcd123456' }, 403);
    await admin.post('/api/admin/auth/setup', { setupToken: SETUP_TOKEN, username: 'teacher', password: 'short1' }, 400);
  });
  it('최초 관리자 생성 후 자동 로그인', async () => {
    await admin.post('/api/admin/auth/setup', { setupToken: SETUP_TOKEN, username: 'teacher', displayName: '김선생', password: 'teacher12345' });
    expect(admin.cookie).toMatch(/^cbt_admin=/);
    const s = await admin.get('/api/admin/auth/status');
    expect(s.admin.role).toBe('owner');
    await admin.post('/api/admin/auth/setup', { setupToken: SETUP_TOKEN, username: 'x2', password: 'teacher12345' }, 409);
  });
  it('X-CBT-Admin 헤더 없는 변경 요청은 거부 (CSRF 방지)', async () => {
    const res = await new Client(env, false).raw('POST', '/api/admin/questions', q({}), { cookie: admin.cookie });
    expect(res.status).toBe(403);
  });
  it('다른 출처(Origin) 요청 거부', async () => {
    const res = await admin.raw('POST', '/api/admin/questions', q({}), { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
  });
  it('비밀번호 로그인과 실패 제한', async () => {
    const c = new Client(env, true, '10.9.9.9');
    await c.post('/api/admin/auth/login', { username: 'teacher', password: 'wrong-password1' }, 401);
    await c.post('/api/admin/auth/login', { username: 'TEACHER', password: 'teacher12345' });
    expect(c.cookie).toBeTruthy();
    const attacker = new Client(env, true, '10.9.9.10');
    for (let i = 0; i < 8; i++) await attacker.post('/api/admin/auth/login', { username: 'teacher', password: 'nope' + i }, 401);
    await attacker.post('/api/admin/auth/login', { username: 'teacher', password: 'teacher12345' }, 429);
  });
  it('로그아웃하면 세션 무효', async () => {
    await env.DB.prepare('DELETE FROM rate_limits').run(); // 앞 테스트의 잠금 해제
    const c = new Client(env, true);
    await c.post('/api/admin/auth/login', { username: 'teacher', password: 'teacher12345' });
    const old = c.cookie;
    await c.post('/api/admin/auth/logout');
    c.cookie = old;
    await c.get('/api/admin/questions', 401);
  });
});

describe('2. 미디어 업로드', () => {
  it('그림·음성 업로드', async () => {
    state.img = (await admin.post('/api/admin/media', fileForm(PNG, 'cat.png', 'image/png', 'image'), 201)).id;
    state.img2 = (await admin.post('/api/admin/media', fileForm(PNG, 'dog.png', 'image/png', 'image'), 201)).id;
    state.audio = (await admin.post('/api/admin/media', fileForm(MP3, 'l1.mp3', 'audio/mpeg', 'audio'), 201)).id;
  });
  it('확장자를 속인 파일 거부', async () => {
    const fake = new TextEncoder().encode('<script>alert(1)</script>');
    await admin.post('/api/admin/media', fileForm(fake, 'x.png', 'image/png'), 415);
    await admin.post('/api/admin/media', fileForm(PNG, 'x.mp3', 'audio/mpeg', 'audio'), 415);
  });
  it('용량 제한', async () => {
    const big = new Uint8Array(5 * 1024 * 1024 + 10);
    big.set(PNG);
    await admin.post('/api/admin/media', fileForm(big, 'big.png', 'image/png'), 413);
  });
  it('관리자는 조회 가능, 비로그인은 차단', async () => {
    expect((await admin.raw('GET', `/api/media/${state.img}`)).status).toBe(200);
    expect((await new Client(env).raw('GET', `/api/media/${state.img}`)).status).toBe(403);
  });
});

describe('3. 문제은행', () => {
  it('8가지 유형 등록', async () => {
    const mk = async (k: string, body: Record<string, unknown>) => (state[k] = (await admin.post('/api/admin/questions', q(body), 201)).id);
    await mk('qMc', { type: 'mc_text', choices: [{ text: 'apple' }, { text: 'banana' }, { text: 'cat' }], answer: { choices: [2] }, points: 10 });
    await mk('qImg', { type: 'mc_image', choices: [{ mediaId: state.img }, { mediaId: state.img2 }], answer: { choices: [1] } });
    await mk('qOx', { type: 'ox', answer: { value: 'O' } });
    await mk('qShort', { type: 'short', domain: '쓰기', answer: { accepted: ['apple'], alternatives: ['an apple'] } });
    await mk('qSent', { type: 'sentence', domain: '쓰기', answer: { mode: 'manual' } });
    await mk('qListen', { type: 'listen_mc', domain: '듣기', audioMediaId: state.audio, choices: [{ text: 'A' }, { text: 'B' }], answer: { choices: [1] } });
    await mk('qListenImg', { type: 'listen_image', domain: '듣기', audioMediaId: state.audio, choices: [{ mediaId: state.img }, { mediaId: state.img2 }], answer: { choices: [2] } });
    await mk('qArr', { type: 'arrange', domain: '쓰기', choices: [{ text: 'c' }, { text: 'a' }, { text: 't' }], answer: {} });
  });
  it('자료가 빠진 문제도 임시 저장 가능 + 누락 표시', async () => {
    const d = await admin.post('/api/admin/questions', q({ type: 'listen_mc', domain: '듣기', status: 'draft', choices: [{ text: 'A' }, { text: 'B' }], answer: { choices: [1] } }), 201);
    expect(d.status).toBe('draft');
    expect(d.issues).toContain('듣기 음성 파일이 없습니다.');
    state.qDraft = d.id;
  });
  it('존재하지 않는 미디어 연결 거부', async () => {
    await admin.post('/api/admin/questions', q({ imageMediaId: 'nope' }), 400);
  });
  it('검색과 필터', async () => {
    expect((await admin.get('/api/admin/questions?domain=듣기')).length).toBe(3);
    expect((await admin.get('/api/admin/questions?type=ox')).length).toBe(1);
    expect((await admin.get('/api/admin/questions?grade=5')).length).toBe(0);
    const s = await admin.put(`/api/admin/questions/${state.qOx}`, q({ type: 'ox', prompt: 'Is it a 100%_cat?', answer: { value: 'O' } }));
    expect(s.prompt).toContain('100%');
    expect((await admin.get('/api/admin/questions?q=' + encodeURIComponent('100%_'))).length).toBe(1);
    expect((await admin.get('/api/admin/questions?q=' + encodeURIComponent('%'))).length).toBe(1);
  });
  it('복제 (임시 저장 상태로)', async () => {
    const d = await admin.post(`/api/admin/questions/${state.qMc}/duplicate`, {}, 201);
    expect(d.id).not.toBe(state.qMc);
    expect(d.status).toBe('draft');
    expect(d.choices).toHaveLength(3);
    await admin.del(`/api/admin/questions/${d.id}`);
    await admin.get(`/api/admin/questions/${d.id}`); // 삭제되어도 조회는 가능(스냅샷 보존용)
    expect((await admin.get('/api/admin/questions')).some((x: any) => x.id === d.id)).toBe(false);
  });
  it('XSS 문자열은 그대로 저장 (화면에서 이스케이프)', async () => {
    const d = await admin.post('/api/admin/questions', q({ prompt: '<img src=x onerror=alert(1)>', type: 'ox', answer: { value: 'X' } }), 201);
    expect(d.prompt).toBe('<img src=x onerror=alert(1)>');
    await admin.del(`/api/admin/questions/${d.id}`);
  });
});

describe('4. 학생 관리', () => {
  it('일괄 등록 (학급 자동 생성)', async () => {
    const r = await admin.post('/api/admin/students/bulk', {
      schoolYear: 2026,
      rows: [
        { grade: 4, classNo: 1, number: 1, name: '김하나' },
        { grade: 4, classNo: 1, number: 2, name: '이둘' },
        { grade: 4, classNo: 1, number: 3, name: '박셋' },
        { grade: 4, classNo: 2, number: 1, name: '최넷' },
      ],
    });
    expect(r.created).toBe(4);
    const again = await admin.post('/api/admin/students/bulk', { schoolYear: 2026, rows: [{ grade: 4, classNo: 1, number: 3, name: '박세엣' }] });
    expect(again.updated).toBe(1);
    expect((await admin.get('/api/admin/classes')).length).toBe(2);
  });
  it('입력 오류 줄 번호 안내', async () => {
    const r = await admin.call('POST', '/api/admin/students/bulk', { rows: [{ grade: 9, classNo: 1, number: 1, name: 'x' }] });
    expect(r.status).toBe(400);
    expect(r.data.errors[0]).toContain('1번째 줄');
  });
  it('개별 등록과 중복 번호 거부', async () => {
    const classes = await admin.get('/api/admin/classes');
    const c1 = classes.find((c: any) => c.class_no === 1);
    state.classId = c1.id;
    await admin.post('/api/admin/students', { classId: c1.id, number: 4, name: '정다섯' }, 201);
    await admin.post('/api/admin/students', { classId: c1.id, number: 4, name: '중복' }, 409);
  });
  it('응시 코드 발급: 평문은 응답에만, DB에는 해시만', async () => {
    const students = await admin.get('/api/admin/students');
    state.students = students;
    const r = await admin.post('/api/admin/students/codes', { studentIds: students.map((s: any) => s.id) });
    expect(r.codes).toHaveLength(5);
    state.codes = Object.fromEntries(r.codes.map((c: any) => [c.name, c.code]));
    const rows = await env.DB.prepare('SELECT code_hash FROM access_codes').all<{ code_hash: string }>();
    for (const c of r.codes) expect(rows.results.some((x) => x.code_hash.includes(c.code.replace('-', '')))).toBe(false);
    const listed = await admin.get('/api/admin/students');
    expect(listed[0].code_issued_at).toBeTruthy();
    expect(JSON.stringify(listed)).not.toContain(r.codes[0].code);
  });
});

describe('5. 시험 관리', () => {
  it('시험 생성', async () => {
    const items = ['qMc', 'qImg', 'qOx', 'qShort', 'qSent', 'qListen', 'qListenImg', 'qArr'].map((k) => ({ questionId: state[k], points: k === 'qMc' ? 10 : 5 }));
    state.exam = (await admin.post('/api/admin/exams', { title: '4학년 9단원', grade: 4, unit: 9, durationMin: 30, audioPlayLimit: 2, resultPolicy: 'review', items }, 201)).id;
  });
  it('대상 학생이 없으면 공개 불가', async () => {
    const r = await admin.call('POST', `/api/admin/exams/${state.exam}/publish`);
    expect(r.status).toBe(422);
  });
  it('미완성 문제가 있으면 공개 불가 (누락 내역 반환)', async () => {
    const ids = state.students.filter((s: any) => s.class_no === 1).map((s: any) => s.id);
    await admin.put(`/api/admin/exams/${state.exam}/targets`, { studentIds: ids });
    const ex = await admin.get(`/api/admin/exams/${state.exam}`);
    await admin.put(`/api/admin/exams/${state.exam}`, { items: [...ex.items, { questionId: state.qDraft, points: 5 }] });
    const r = await admin.call('POST', `/api/admin/exams/${state.exam}/publish`);
    expect(r.status).toBe(422);
    expect(r.data.issues[0].messages).toContain('듣기 음성 파일이 없습니다.');
    await admin.put(`/api/admin/exams/${state.exam}`, { items: ex.items });
  });
  it('미리보기에는 정답 포함 (교사용)', async () => {
    const p = await admin.get(`/api/admin/exams/${state.exam}/preview`);
    expect(p.items).toHaveLength(8);
    expect(p.items[0].question.answer).toBeTruthy();
  });
  it('공개', async () => {
    const r = await admin.post(`/api/admin/exams/${state.exam}/publish`);
    state.v1 = r.versionId;
  });
  it('공개 중에는 문항 변경 불가, 제목·결과 공개 방식은 변경 가능', async () => {
    await admin.put(`/api/admin/exams/${state.exam}`, { items: [] }, 409);
    await admin.put(`/api/admin/exams/${state.exam}`, { durationMin: 10 }, 409);
    await admin.put(`/api/admin/exams/${state.exam}`, { title: '4학년 9단원 평가' });
  });
  it('시험 복제', async () => {
    const d = await admin.post(`/api/admin/exams/${state.exam}/duplicate`, {}, 201);
    const ex = await admin.get(`/api/admin/exams/${d.id}`);
    expect(ex.status).toBe('draft');
    expect(ex.items).toHaveLength(8);
    await admin.del(`/api/admin/exams/${d.id}`);
  });
});

describe('6. 학생 응시', () => {
  let stu: Client;
  beforeAll(() => {
    stu = new Client(env, false, '10.1.1.1');
  });
  const answers: Record<string, string> = {};

  it('잘못된 코드/이름은 같은 메시지로 거부', async () => {
    const a = await stu.call('POST', '/api/student/login', { grade: 4, classNo: 1, number: 1, name: '김하나', code: 'AAAA-AAAA' });
    const b = await stu.call('POST', '/api/student/login', { grade: 4, classNo: 1, number: 1, name: '김두리', code: state.codes['김하나'] });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.data.error).toBe(b.data.error);
  });
  it('코드 무차별 대입: 5회 실패 후 잠금', async () => {
    const atk = new Client(env, false, '10.2.2.2');
    for (let i = 0; i < 5; i++) await atk.post('/api/student/login', { grade: 4, classNo: 1, number: 2, name: '이둘', code: `ZZZZ-ZZZ${i + 2}` }, 401);
    await atk.post('/api/student/login', { grade: 4, classNo: 1, number: 2, name: '이둘', code: state.codes['이둘'] }, 429);
  });
  it('로그인 (코드 소문자·공백 허용) 후 시험 목록', async () => {
    const r = await stu.post('/api/student/login', { grade: 4, classNo: 1, number: 1, name: ' 김하나', code: state.codes['김하나'].toLowerCase() });
    stu.bearer = r.token;
    const list = await stu.get('/api/student/exams');
    expect(list.exams).toHaveLength(1);
    expect(list.exams[0].state).toBe('available');
  });
  it('대상이 아닌 학생에게는 시험이 보이지 않음', async () => {
    const other = new Client(env, false, '10.1.1.3');
    other.bearer = (await other.post('/api/student/login', { grade: 4, classNo: 2, number: 1, name: '최넷', code: state.codes['최넷'] })).token;
    expect((await other.get('/api/student/exams')).exams).toHaveLength(0);
    await other.post(`/api/student/exams/${state.exam}/start`, {}, 403);
  });
  it('학생 토큰으로 관리자 API 접근 불가', async () => {
    const res = await stu.raw('GET', '/api/admin/questions');
    expect(res.status).toBe(401);
  });
  it('시험 시작: 정답·해설이 응답에 없음', async () => {
    state.attempt = (await stu.post(`/api/student/exams/${state.exam}/start`)).attemptId;
    const a = await stu.get(`/api/student/attempts/${state.attempt}`);
    state.items = a.items;
    expect(a.items).toHaveLength(8);
    const raw = JSON.stringify(a);
    expect(raw).not.toContain('"answer"');
    expect(raw).not.toContain('accepted');
    expect(raw).not.toContain('해설');
    expect(a.items.find((i: any) => i.type === 'listen_mc').hasAudio).toBe(true);
    // 음성 주소는 재생 요청 전에는 주지 않음
    expect(raw).not.toContain(state.audio);
    // 같은 시험 다시 시작하면 같은 응시 이어서
    expect((await stu.post(`/api/student/exams/${state.exam}/start`)).attemptId).toBe(state.attempt);
  });
  it('그림은 서명 URL로만 접근 가능', async () => {
    const img = state.items.find((i: any) => i.type === 'mc_image').choices[0].imageUrl as string;
    expect(img).toMatch(/\?a=.*&e=\d+&s=[0-9a-f]+$/);
    expect((await new Client(env).raw('GET', img)).status).toBe(200);
    expect((await new Client(env).raw('GET', img.replace(/s=[0-9a-f]+/, 's=' + '0'.repeat(64)))).status).toBe(403);
  });
  it('철자 배열 카드는 정답 순서 그대로 나오지 않음', async () => {
    const arr = state.items.find((i: any) => i.type === 'arrange');
    expect(arr.tiles.map((t: any) => t.text).join('')).not.toBe('cat');
  });
  it('답안 자동 저장 + 오래된 revision은 무시', async () => {
    const byType = (t: string) => state.items.find((i: any) => i.type === t);
    const arr = byType('arrange');
    const order = ['c', 'a', 't'].map((ch) => arr.tiles.find((t: any) => t.text === ch).index).join(',');
    Object.assign(answers, {
      [byType('mc_text').itemId]: '2',
      [byType('mc_image').itemId]: '2', // 오답
      [byType('ox').itemId]: 'O',
      [byType('short').itemId]: ' An Apple ',
      [byType('sentence').itemId]: 'I like apples.',
      [byType('listen_mc').itemId]: '1',
      [byType('arrange').itemId]: order,
    });
    const list = Object.entries(answers).map(([itemId, response]) => ({ itemId, response, rev: 5 }));
    const r = await stu.put(`/api/student/attempts/${state.attempt}/answers`, { answers: list });
    expect(r.saved).toHaveLength(7);
    // 네트워크 지연으로 늦게 도착한 옛 답안
    await stu.put(`/api/student/attempts/${state.attempt}/answers`, { answers: [{ itemId: byType('mc_text').itemId, response: '3', rev: 2 }] });
    const a = await stu.get(`/api/student/attempts/${state.attempt}`);
    expect(a.answers.find((x: any) => x.item_id === byType('mc_text').itemId).response).toBe('2');
  });
  it('다른 시험의 문항 ID 저장 거부', async () => {
    await stu.put(`/api/student/attempts/${state.attempt}/answers`, { answers: [{ itemId: 'fake', response: '1', rev: 9 }] }, 400);
  });
  it('듣기 재생 횟수: 서버에서 제한, 새로고침해도 유지', async () => {
    const item = state.items.find((i: any) => i.type === 'listen_mc');
    const p1 = await stu.post(`/api/student/attempts/${state.attempt}/items/${item.itemId}/play`);
    expect(p1.playsUsed).toBe(1);
    expect((await new Client(env).raw('GET', p1.url)).status).toBe(200);
    const range = await new Client(env).raw('GET', p1.url, undefined, { range: 'bytes=0-9' });
    expect(range.status).toBe(206);
    expect(range.headers.get('content-range')).toMatch(/^bytes 0-9\//);
    await stu.post(`/api/student/attempts/${state.attempt}/items/${item.itemId}/play`);
    const over = await stu.call('POST', `/api/student/attempts/${state.attempt}/items/${item.itemId}/play`);
    expect(over.status).toBe(409);
    const after = await stu.get(`/api/student/attempts/${state.attempt}`);
    expect(after.items.find((i: any) => i.itemId === item.itemId).playsUsed).toBe(2);
  });
  it('다른 학생은 이 응시에 접근 불가', async () => {
    const other = new Client(env, false, '10.1.1.4');
    other.bearer = (await other.post('/api/student/login', { grade: 4, classNo: 1, number: 3, name: '박세엣', code: state.codes['박세엣'] })).token;
    await other.get(`/api/student/attempts/${state.attempt}`, 404);
    state.otherStudent = other;
  });
  it('제출 → 서버 채점, 클라이언트 점수 무시', async () => {
    const r = await stu.post(`/api/student/attempts/${state.attempt}/submit`, { answers: [], score: 999 });
    expect(r.status).toBe('submitted');
    // 객관식10 + O/X5 + 단답5(허용답안) + 듣기5 + 배열5 = 30, 문장형은 수동 채점 대기
    expect(r.result.score).toBe(30);
    expect(r.result.maxScore).toBe(45);
    expect(r.result.gradingPending).toBe(true);
    expect(r.result.items).toHaveLength(8);
    expect(JSON.stringify(r.result)).not.toContain('accepted');
  });
  it('중복 제출·제출 후 저장·재응시 차단', async () => {
    const again = await stu.post(`/api/student/attempts/${state.attempt}/submit`, {});
    expect(again.alreadySubmitted).toBe(true);
    await stu.put(`/api/student/attempts/${state.attempt}/answers`, { answers: [] }, 409);
    await stu.post(`/api/student/exams/${state.exam}/start`, {}, 409);
    expect((await stu.get('/api/student/exams')).exams[0].state).toBe('submitted');
  });
});

describe('7. 시험 버전 보존', () => {
  it('응시가 시작된 뒤 비공개→수정→재공개하면 새 버전, 기존 응시는 이전 버전 유지', async () => {
    // 박셋이 v1로 시작
    const other: Client = state.otherStudent;
    state.attempt2 = (await other.post(`/api/student/exams/${state.exam}/start`)).attemptId;
    await admin.post(`/api/admin/exams/${state.exam}/unpublish`);
    // 문제은행 원본을 바꿔도 스냅샷은 그대로
    await admin.put(`/api/admin/questions/${state.qMc}`, q({ type: 'mc_text', prompt: '바뀐 문제', choices: [{ text: 'x' }, { text: 'y' }], answer: { choices: [1] } }));
    const ex = await admin.get(`/api/admin/exams/${state.exam}`);
    await admin.put(`/api/admin/exams/${state.exam}`, { items: ex.items.slice(0, 3) });
    const r = await admin.post(`/api/admin/exams/${state.exam}/publish`);
    expect(r.versionId).not.toBe(state.v1);
    const a2 = await other.get(`/api/student/attempts/${state.attempt2}`);
    expect(a2.items).toHaveLength(8);
    expect(a2.items.some((i: any) => i.prompt === '바뀐 문제')).toBe(false);
    const versions = (await admin.get(`/api/admin/exams/${state.exam}`)).versions;
    expect(versions).toHaveLength(2);
  });
});

describe('8. 시간 종료 (서버 기준)', () => {
  it('마감 시간이 지나면 저장 거부 후 자동 채점', async () => {
    await env.DB.prepare('UPDATE attempts SET deadline_at=? WHERE id=?').bind(Date.now() - 1000, state.attempt2).run();
    const other: Client = state.otherStudent;
    const r = await other.call('PUT', `/api/student/attempts/${state.attempt2}/answers`, { answers: [] });
    expect(r.status).toBe(409);
    const a = await env.DB.prepare('SELECT status, submit_reason, total_score FROM attempts WHERE id=?').bind(state.attempt2).first<any>();
    expect(a.status).toBe('submitted');
    expect(a.submit_reason).toBe('timeout');
    expect(a.total_score).toBe(0);
  });
});

describe('9. 성적 관리', () => {
  it('통계·문항별 정답률·미응시 목록', async () => {
    const r = await admin.get(`/api/admin/exams/${state.exam}/results`);
    expect(r.stats.targetCount).toBe(4);
    expect(r.stats.submittedCount).toBe(2);
    expect(r.stats.notStartedCount).toBe(2);
    expect(r.notStarted.map((s: any) => s.name).sort()).toEqual(['이둘', '정다섯']);
    expect(r.stats.max).toBe(30);
    expect(r.stats.min).toBe(0);
    expect(r.stats.average).toBe(15);
    const first = r.itemStats.find((s: any) => s.seq === 1);
    expect(first.answered).toBe(2);
    expect(first.correctRate).toBe(50);
  });
  it('정오표와 수동 채점', async () => {
    const d = await admin.get(`/api/admin/attempts/${state.attempt}`);
    const sent = d.items.find((i: any) => i.question.type === 'sentence');
    expect(sent.grade.status).toBe('pending');
    expect(d.items.find((i: any) => i.question.type === 'arrange').responseText).toBe('cat');
    await admin.put(`/api/admin/attempts/${state.attempt}/grades/${sent.itemId}`, { score: 99 }, 400);
    await admin.put(`/api/admin/attempts/${state.attempt}/grades/${sent.itemId}`, { score: 4, feedback: '좋아요' });
    const a = await env.DB.prepare('SELECT total_score, grading_status FROM attempts WHERE id=?').bind(state.attempt).first<any>();
    expect(a.total_score).toBe(34);
    expect(a.grading_status).toBe('complete');
  });
  it('재응시 허용 후 다시 응시 가능', async () => {
    const other: Client = state.otherStudent;
    await admin.post(`/api/admin/attempts/${state.attempt2}/reset`);
    const again = await other.post(`/api/student/exams/${state.exam}/start`);
    expect(again.attemptId).not.toBe(state.attempt2);
    expect((await other.get(`/api/student/attempts/${again.attemptId}`)).items).toHaveLength(3);
  });
  it('코드 재발급 시 이전 코드·세션 무효', async () => {
    const other: Client = state.otherStudent;
    const sid = state.students.find((s: any) => s.name === '박세엣').id;
    const r = await admin.post('/api/admin/students/codes', { studentIds: [sid] });
    await other.get('/api/student/exams', 401);
    await new Client(env, false, '10.5.5.5').post('/api/student/login', { grade: 4, classNo: 1, number: 3, name: '박세엣', code: state.codes['박세엣'] }, 401);
    await new Client(env, false, '10.5.5.5').post('/api/student/login', { grade: 4, classNo: 1, number: 3, name: '박세엣', code: r.codes[0].code });
  });
  it('대시보드', async () => {
    const d = await admin.get('/api/admin/dashboard');
    expect(d.questionCount).toBeGreaterThanOrEqual(9);
    expect(d.examCount).toBe(1);
    expect(d.studentCount).toBe(5);
    expect(d.liveExams).toHaveLength(1);
    expect(d.recentResults.length).toBeGreaterThan(0);
  });
  it('시험 종료 시 진행 중 응시도 마감', async () => {
    await admin.post(`/api/admin/exams/${state.exam}/close`);
    const r = await admin.get(`/api/admin/exams/${state.exam}/results`);
    expect(r.stats.inProgressCount).toBe(0);
  });
  it('활동 기록', async () => {
    const logs = await admin.get('/api/admin/audit-logs');
    const actions = logs.map((l: any) => l.action);
    expect(actions).toEqual(expect.arrayContaining(['exam.publish', 'code.issue', 'grade.manual', 'attempt.reset']));
    expect(JSON.stringify(logs)).not.toContain(state.codes['김하나']);
  });
});
