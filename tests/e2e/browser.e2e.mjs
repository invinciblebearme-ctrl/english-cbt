// 실제 브라우저(Edge/Chrome) 화면 테스트
// 사용법: npm run build → npx wrangler dev --port 8787 (빈 로컬 DB) → node tests/e2e/browser.e2e.mjs [스크린샷폴더]
import { chromium } from 'playwright-core';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
const OUT = process.argv[2] || join(tmpdir(), 'cbt-e2e');
mkdirSync(OUT, { recursive: true });
const SETUP_TOKEN = /SETUP_TOKEN=(.+)/.exec(readFileSync('.dev.vars', 'utf8'))[1].trim();

const results = [];
const problems = [];
let step = 0;
async function check(name, fn) {
  try {
    await fn();
    results.push(['PASS', name]);
    console.log('PASS ', name);
  } catch (e) {
    results.push(['FAIL', name, e.message.split('\n')[0]]);
    console.log('FAIL ', name, '—', e.message.split('\n')[0]);
  }
}
const shot = (page, name) => page.screenshot({ path: join(OUT, `${String(++step).padStart(2, '0')}_${name}.png`), fullPage: true });
const watch = (page, who) => {
  page.on('dialog', (d) => d.accept());
  page.on('pageerror', (e) => problems.push(`[${who}] 페이지 오류: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|ERR_INTERNET_DISCONNECTED|net::ERR/.test(m.text()) && problems.push(`[${who}] 콘솔 오류: ${m.text()}`));
};

// 1초짜리 440Hz WAV 생성
function makeWav(path) {
  const rate = 8000, n = rate;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), 44 + i * 2);
  writeFileSync(path, buf);
}
const wavPath = join(OUT, 'listen.wav');
makeWav(wavPath);

let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
} catch {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
}
const adminCtx = await browser.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: true, locale: 'ko-KR' });
const admin = await adminCtx.newPage();
watch(admin, '관리자');
let codes = [];

// ---------- 관리자 ----------
await check('관리자: 최초 설정 화면 → 관리자 생성', async () => {
  await admin.goto(BASE + '/admin');
  await admin.getByRole('heading', { name: '최초 관리자 설정' }).waitFor();
  await shot(admin, 'admin_setup');
  await admin.getByLabel('설정 토큰').fill(SETUP_TOKEN);
  await admin.getByLabel('아이디').fill('teacher');
  await admin.getByLabel('이름').fill('김선생');
  await admin.getByLabel('비밀번호', { exact: true }).fill('teacher12345');
  await admin.getByLabel('비밀번호 확인').fill('teacher12345');
  await admin.getByRole('button', { name: '관리자 만들기' }).click();
  await admin.getByRole('heading', { name: '대시보드' }).waitFor();
  await shot(admin, 'admin_dashboard_empty');
});

async function newQuestion(fill) {
  await admin.getByRole('button', { name: '+ 새 문제' }).click();
  await admin.getByRole('dialog', { name: '새 문제 등록' }).waitFor();
  await fill(admin.getByRole('dialog'));
}

await check('문제은행: 객관식 문제 등록', async () => {
  await admin.getByRole('link', { name: /문제은행/ }).click();
  await admin.getByRole('heading', { name: '문제은행' }).waitFor();
  await newQuestion(async (d) => {
    await d.getByLabel('문제 내용 (발문)').fill('사과는 영어로 무엇일까요?');
    await d.getByLabel('1번 선택지').fill('banana');
    await d.getByLabel('2번 선택지').fill('apple');
    await d.getByLabel('3번 선택지').fill('cat');
    await d.getByLabel('4번 선택지').fill('dog');
    await d.locator('input[name=correct]').nth(1).check();
    await d.getByText('필수 항목이 모두 채워졌습니다').waitFor();
    await shot(admin, 'question_editor_mc');
    await d.getByRole('button', { name: /학생 화면 미리보기/ }).click();
    await d.getByText('초록 테두리는 정답 표시').waitFor();
    await shot(admin, 'question_preview');
    await d.getByRole('button', { name: '편집으로 돌아가기' }).click();
    await d.getByRole('button', { name: '완성으로 저장' }).click();
  });
  await admin.getByText('문제를 저장했습니다.').waitFor();
});

await check('문제은행: 듣기 문제 — 음성 없이 임시 저장 → 누락 표시 → 음성 업로드 후 완성', async () => {
  await newQuestion(async (d) => {
    await d.getByLabel('문제 유형').selectOption('listen_mc');
    await d.getByLabel('문제 내용 (발문)').fill('잘 듣고 알맞은 답을 고르세요.');
    for (const [i, t] of ['red', 'blue', 'green', 'yellow'].entries()) await d.getByLabel(`${i + 1}번 선택지`).fill(t);
    await d.locator('input[name=correct]').nth(0).check();
    await d.getByText('듣기 음성 파일이 없습니다.').first().waitFor();
    await d.getByRole('button', { name: '완성으로 저장' }).click();
    await d.getByText('완성으로 저장하려면').waitFor();
    await d.getByRole('button', { name: '임시 저장' }).click();
  });
  await admin.getByText('임시 저장했습니다').waitFor();
  await admin.getByRole('cell', { name: /잘 듣고 알맞은 답/ }).getByText('듣기 음성 파일이 없습니다').waitFor();
  await shot(admin, 'question_bank_draft');
  await admin.getByRole('button', { name: '잘 듣고 알맞은 답을 고르세요.' }).click();
  const d = admin.getByRole('dialog', { name: '문제 수정' });
  await d.locator('input[type=file][accept*="audio"]').first().setInputFiles(wavPath);
  await d.locator('audio').first().waitFor();
  await d.getByText('필수 항목이 모두 채워졌습니다').waitFor();
  await d.getByRole('button', { name: '완성으로 저장' }).click();
  await admin.getByText('문제를 저장했습니다.').waitFor();
});

await check('문제은행: O/X·철자 배열 문제 등록, 필터·검색', async () => {
  await newQuestion(async (d) => {
    await d.getByLabel('문제 유형').selectOption('ox');
    await d.getByLabel('문제 내용 (발문)').fill('Cat은 고양이입니다.');
    await d.getByText('O', { exact: true }).first().click();
    await d.getByRole('button', { name: '완성으로 저장' }).click();
  });
  await admin.getByText('문제를 저장했습니다.').waitFor();
  await newQuestion(async (d) => {
    await d.getByLabel('평가 영역').selectOption('쓰기');
    await d.getByLabel('문제 유형').selectOption('arrange');
    await d.getByLabel('문제 내용 (발문)').fill('철자를 순서대로 놓아 낱말을 만드세요.');
    for (const [i, t] of ['b', 'o', 'o', 'k'].entries()) await d.getByLabel(`${i + 1}번째 카드`).fill(t);
    await d.getByText('정답: book').waitFor();
    await d.getByRole('button', { name: '완성으로 저장' }).click();
  });
  await admin.getByText('문제를 저장했습니다.').waitFor();
  await admin.getByText('총 4문제').waitFor();
  await admin.getByLabel('유형').selectOption('ox');
  await admin.getByText('총 1문제').waitFor();
  await admin.getByLabel('유형').selectOption('');
  await admin.getByLabel('검색어').fill('사과');
  await admin.getByRole('button', { name: '검색' }).click();
  await admin.getByText('총 1문제').waitFor();
  await admin.getByLabel('검색어').fill('');
  await admin.getByRole('button', { name: '검색' }).click();
  await admin.getByText('총 4문제').waitFor();
  await shot(admin, 'question_bank');
});

await check('학생 관리: 붙여넣기 일괄 등록 → 코드 발급·쪽지 화면', async () => {
  await admin.getByRole('link', { name: /학생 관리/ }).click();
  await admin.getByRole('button', { name: /일괄 등록/ }).click();
  await admin.getByRole('dialog').locator('textarea').fill('학년\t반\t번호\t이름\n4\t1\t1\t김하나\n4\t1\t2\t이둘\n4\t1\t3\t박셋');
  await admin.getByRole('button', { name: '3명 등록' }).click();
  await admin.getByText('3명 새로 등록').waitFor();
  await admin.getByText('미발급').first().waitFor();
  await admin.getByRole('button', { name: '코드 없는 학생 모두 발급' }).click();
  await admin.getByText('응시 코드 3개 발급 완료').waitFor();
  codes = await admin.locator('#code-sheet > div').evaluateAll((els) => els.map((e) => ({ name: e.querySelector('.text-lg').textContent, code: e.querySelector('.font-mono').textContent })));
  if (codes.length !== 3 || !/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(codes[0].code)) throw new Error('코드 형식 오류 ' + JSON.stringify(codes));
  await shot(admin, 'code_sheet');
  await admin.getByRole('dialog').getByRole('button', { name: '닫기' }).click(); // confirm 자동 수락
  await admin.getByText('발급됨 · 미사용').first().waitFor();
  await shot(admin, 'students');
});

await check('시험 관리: 시험 만들기 → 문제 추가·대상 지정 → 공개', async () => {
  await admin.getByRole('link', { name: /시험 관리/ }).click();
  await admin.getByRole('button', { name: '+ 시험 만들기' }).click();
  await admin.getByRole('heading', { name: /새 시험/ }).waitFor();
  await admin.getByLabel('시험 제목').fill('4학년 1단원 평가');
  await admin.getByLabel('음성 재생 횟수').fill('2');
  await admin.getByRole('button', { name: /보이는 문제 모두 추가/ }).click();
  await admin.getByText('2. 문항 구성 (4문항 · 총 20점)').waitFor();
  await admin.getByLabel(/4학년 1반/).check();
  await admin.getByText('3. 응시 대상 학생 (3명 선택)').waitFor();
  await shot(admin, 'exam_editor');
  await admin.getByRole('button', { name: /시험 미리보기/ }).click();
  await admin.getByRole('dialog').getByText('사과는 영어로 무엇일까요?').waitFor();
  await admin.getByRole('dialog').getByRole('button', { name: '닫기' }).click();
  await admin.getByRole('button', { name: '공개하기' }).click();
  await admin.getByText('시험을 공개했습니다').waitFor();
  await admin.getByText('공개 중인 시험은 문항·배점·시간을 바꿀 수 없습니다').waitFor();
  await shot(admin, 'exam_published');
});

// ---------- 학생 ----------
const stuCtx = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'ko-KR' });
const stu = await stuCtx.newPage();
watch(stu, '학생');
const me = () => codes.find((c) => c.name === '김하나');

await check('학생: 틀린 코드 → 오류 메시지', async () => {
  await stu.goto(BASE + '/');
  await stu.getByRole('heading', { name: '시험 입장' }).waitFor();
  await stu.getByLabel('학년').fill('4');
  await stu.getByLabel('반').fill('1');
  await stu.getByLabel('번호').fill('1');
  await stu.getByLabel('이름').fill('김하나');
  await stu.getByLabel('응시 코드').fill('AAAA-BBBB');
  await stu.getByRole('button', { name: '들어가기' }).click();
  await stu.getByRole('alert').getByText('입력한 정보가 맞지 않습니다').waitFor();
  await shot(stu, 'student_login_error');
});

await check('학생: 로그인 → 시험 목록 → 시험 시작', async () => {
  await stu.getByLabel('응시 코드').fill(me().code.toLowerCase());
  await stu.getByRole('button', { name: '들어가기' }).click();
  await stu.getByText('김하나 학생, 안녕하세요!').waitFor();
  await stu.getByText('4학년 1단원 평가').waitFor();
  await shot(stu, 'student_exam_list');
  await stu.getByRole('button', { name: '시험 시작' }).click();
  await stu.getByRole('timer').waitFor();
  await stu.getByText('1 / 4 문제').waitFor();
  await shot(stu, 'student_exam_q1');
});

/** 객관식(선택지) 문제로 이동해 첫 선택지를 고름 */
async function answerCurrent() {
  for (let i = 1; i <= 4; i++) {
    await stu.getByRole('button', { name: new RegExp(`^${i}번 문제`) }).click();
    if (await stu.getByRole('radiogroup', { name: '선택지' }).count() && !(await stu.getByRole('button', { name: '🔊 듣기' }).count())) {
      await stu.getByRole('radiogroup', { name: '선택지' }).getByRole('radio').first().click();
      return i;
    }
  }
  throw new Error('객관식 문제를 찾지 못함');
}

await check('학생: 답 고르기 → 서버 저장 표시', async () => {
  await answerCurrent();
  await stu.getByText('✓ 서버에 저장되었습니다.').waitFor({ timeout: 10000 });
  await stu.getByRole('button', { name: /번 문제 \(답함\)/ }).first().waitFor();
});

await check('학생: 듣기 문제 재생 → 횟수 표시', async () => {
  // 듣기 문제로 이동
  for (let i = 1; i <= 4; i++) {
    await stu.getByRole('button', { name: new RegExp(`^${i}번 문제`) }).click();
    if (await stu.getByRole('button', { name: '🔊 듣기' }).count()) break;
  }
  await stu.getByRole('button', { name: '🔊 듣기' }).click();
  await stu.getByText('들은 횟수 1 / 2').waitFor();
  await shot(stu, 'student_listening');
  await stu.getByText('✓ 재생 완료').waitFor({ timeout: 8000 });
});

await check('학생: 인터넷 끊김 → 기기에 보관 표시 → 재연결 시 자동 저장', async () => {
  // 아직 답하지 않은 O/X 문제로 이동
  for (let i = 1; i <= 4; i++) {
    await stu.getByRole('button', { name: new RegExp(`^${i}번 문제`) }).click();
    if (await stu.getByRole('radiogroup', { name: 'O 또는 X' }).count()) break;
  }
  await stuCtx.setOffline(true);
  await stu.getByRole('radio', { name: 'O' }).click();
  await stu.getByText('인터넷 연결이 끊겼어요').waitFor({ timeout: 10000 });
  await shot(stu, 'student_offline');
  await stuCtx.setOffline(false);
  await stu.getByText('✓ 서버에 저장되었습니다.').waitFor({ timeout: 20000 });
});

await check('학생: 새로고침해도 답안·재생 횟수 유지', async () => {
  await stu.reload();
  await stu.getByRole('timer').waitFor();
  const answered = await stu.getByRole('button', { name: /번 문제 \(답함\)/ }).count();
  if (answered !== 2) throw new Error(`답한 문제 수 ${answered} (기대 2)`);
  for (let i = 1; i <= 4; i++) {
    await stu.getByRole('button', { name: new RegExp(`^${i}번 문제`) }).click();
    if (await stu.getByText(/들은 횟수/).count()) break;
  }
  await stu.getByText('들은 횟수 1 / 2').waitFor();
});

await check('학생: 철자 배열 카드로 답 만들기', async () => {
  for (let i = 1; i <= 4; i++) {
    await stu.getByRole('button', { name: new RegExp(`^${i}번 문제`) }).click();
    if (await stu.getByText('아래 카드를 순서대로 눌러').count()) break;
  }
  for (const ch of ['b', 'o', 'o', 'k']) await stu.locator('button:not([disabled])', { hasText: new RegExp(`^${ch}$`) }).last().click();
  await stu.getByText('만든 답:').waitFor();
  await stu.locator('text=만든 답:').locator('b', { hasText: 'book' }).waitFor();
  await shot(stu, 'student_arrange');
  await stu.getByText('✓ 서버에 저장되었습니다.').waitFor({ timeout: 10000 });
});

await check('학생: 미응답 경고 → 제출 → 완료 화면', async () => {
  await stu.getByRole('button', { name: /^4번 문제/ }).click();
  await stu.getByRole('button', { name: '답안 제출' }).click();
  const d = stu.getByRole('dialog', { name: '답안을 제출할까요?' });
  const unanswered = await d.getByText(/아직 풀지 않은 문제가/).count();
  await shot(stu, 'student_submit_confirm');
  if (!unanswered) throw new Error('미응답 경고가 표시되지 않음');
  await d.getByRole('button', { name: '제출하기' }).click();
  await stu.getByRole('heading', { name: '제출 완료!' }).waitFor();
  await shot(stu, 'student_done');
  await stu.getByRole('button', { name: '시험 목록으로' }).click();
  await stu.getByRole('button', { name: /제출 완료/ }).waitFor();
});

// 모바일 화면
await check('학생: 휴대폰 크기 화면 표시', async () => {
  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'ko-KR' });
  const p = await m.newPage();
  watch(p, '모바일');
  await p.goto(BASE + '/');
  await p.getByLabel('학년').fill('4');
  await p.getByLabel('반').fill('1');
  await p.getByLabel('번호').fill('2');
  await p.getByLabel('이름').fill('이둘');
  await p.getByLabel('응시 코드').fill(codes.find((c) => c.name === '이둘').code);
  await p.getByRole('button', { name: '들어가기' }).click();
  await p.getByRole('button', { name: '시험 시작' }).click();
  await p.getByRole('timer').waitFor();
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  await shot(p, 'mobile_exam');
  if (overflow) throw new Error('가로 스크롤 발생');
  await m.close();
});

// ---------- 성적 ----------
await check('성적 관리: 통계·정오표·응시 현황', async () => {
  await admin.goto(BASE + '/admin/results');
  const opt = await admin.getByLabel('시험 선택').locator('option', { hasText: '4학년 1단원 평가' }).getAttribute('value');
  await admin.getByLabel('시험 선택').selectOption(opt);
  await admin.getByText('학생별 점수·정오표').waitFor();
  await shot(admin, 'results');
  await admin.getByRole('button', { name: /4-1-1 김하나/ }).click();
  await admin.getByRole('dialog').getByText('정답:').first().waitFor();
  await shot(admin, 'results_detail');
  await admin.getByRole('dialog').getByRole('button', { name: '닫기' }).click();
  await admin.getByRole('tab', { name: /응시 현황/ }).click();
  await admin.getByText('4-1-3 박셋').waitFor();
  await admin.getByText(/4-1-2 이둘/).waitFor();
  await shot(admin, 'results_status');
  await admin.getByRole('tab', { name: '문항별 정답률' }).click();
  await shot(admin, 'results_items');
});

await check('성적 관리: Excel·CSV 다운로드', async () => {
  const [x] = await Promise.all([admin.waitForEvent('download'), admin.getByRole('button', { name: 'Excel 다운로드' }).click()]);
  const xp = join(OUT, x.suggestedFilename());
  await x.saveAs(xp);
  const xb = readFileSync(xp);
  if (xb.subarray(0, 2).toString() !== 'PK') throw new Error('xlsx 아님');
  const [c] = await Promise.all([admin.waitForEvent('download'), admin.getByRole('button', { name: 'CSV 다운로드' }).click()]);
  const cp = join(OUT, c.suggestedFilename());
  await c.saveAs(cp);
  const csv = readFileSync(cp, 'utf8');
  if (!csv.includes('김하나') || !csv.includes('미응시')) throw new Error('CSV 내용 오류');
  console.log('      파일:', x.suggestedFilename(), c.suggestedFilename());
});

await check('대시보드: 진행 중 시험·최근 결과 반영', async () => {
  await admin.getByRole('link', { name: /대시보드/ }).click();
  await admin.getByRole('heading', { name: '진행 중인 시험' }).waitFor();
  await admin.getByText('4학년 1단원 평가').first().waitFor();
  await admin.getByText(/4-1-1 김하나/).waitFor();
  await shot(admin, 'dashboard');
});

await check('설정: 활동 기록 표시, 로그아웃', async () => {
  await admin.getByRole('link', { name: /설정/ }).click();
  await admin.getByText('시험 공개').first().waitFor();
  await shot(admin, 'settings');
  await admin.getByRole('button', { name: '로그아웃' }).click();
  await admin.getByRole('heading', { name: '교사 로그인' }).waitFor();
});

await browser.close();
console.log('\n스크린샷 폴더:', OUT);
console.log(`결과: ${results.filter((r) => r[0] === 'PASS').length} 통과 / ${results.filter((r) => r[0] === 'FAIL').length} 실패`);
if (problems.length) console.log('브라우저 오류:\n' + [...new Set(problems)].join('\n'));
else console.log('브라우저 콘솔/페이지 오류: 없음');
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
