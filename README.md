# English CBT — 초등 영어 단원평가 온라인 시스템

초등학교 영어 단원평가를 컴퓨터·태블릿으로 실시하는 CBT(Computer Based Test) 웹서비스입니다.
교사용 관리자 화면(문제은행·시험·학생·성적)과 학생용 시험 화면으로 나뉘며, Cloudflare Workers + D1 + R2 위에서 동작합니다.

- 관리자 사용 설명서: [docs/관리자_사용설명서.md](docs/관리자_사용설명서.md)
- 학생 응시 안내서: [docs/학생_응시안내서.md](docs/학생_응시안내서.md)

## 1. 구성

| 경로 | 내용 |
| --- | --- |
| `web/` | 프론트엔드 (React 19 + TypeScript + Vite + Tailwind CSS 4) |
| `web/src/student/` | 학생 화면: 로그인, 시험 목록, 응시, 결과 |
| `web/src/admin/` | 관리자 화면: 대시보드, 문제은행, 시험 관리, 학생 관리, 성적 관리, 설정 |
| `web/src/lib/answerSync.ts` | 답안 자동 저장·오프라인 보관·재연결 동기화 |
| `web/src/lib/exporters.ts` | CSV / Excel(.xlsx) 생성 (외부 라이브러리 없음) |
| `worker/src/` | 백엔드 REST API (Cloudflare Workers, TypeScript) |
| `shared/` | 프론트·백엔드 공통: 문제 유형, 공개 전 검사, 자동 채점 |
| `migrations/` | D1 스키마 (`0001` 1차 구현, `0002` 전체 스키마 + 1차 데이터 이전) |
| `tests/` | 자동화 테스트 (Vitest) |
| `legacy/` | 1차 구현 원본 (`worker.js`, `index.html`) — 참고용, 배포에 포함되지 않음 |
| `web/public/demo.html` | 1차 로컬 시연 프로토타입 (`/demo.html`, 실제 개인정보 입력 금지) |

### 지원 문제 유형
객관식(텍스트), 객관식(그림), O/X, 단답형, 문장 입력형, 듣기 객관식, 듣기 그림 선택, 철자(낱말) 배열

### 데이터베이스 (D1)
`admins`(관리자) · `admin_sessions` · `classes`(학급) · `students`(학생) · `access_codes`(응시 코드, HMAC 해시만 저장) · `student_sessions` ·
`questions`(문제은행) · `question_choices`(선택지) · `media`(미디어 파일, 본문은 R2) · `exams`(시험) · `exam_items`(편집 중 문항) ·
`exam_versions` / `exam_version_items`(공개 시점의 문항·정답 스냅샷 = 시험별 문항 버전) · `exam_targets`(시험 대상 학생) ·
`attempts`(응시 기록) · `answers`(학생 답안) · `audio_plays`(듣기 재생 횟수) · `grading_results`(채점 결과) · `audit_logs`(관리자 활동 기록) · `rate_limits`(요청 제한)

관계: 학급 1—N 학생 1—N 응시 코드 / 문제 1—N 선택지 / 시험 1—N 버전 1—N 버전 문항 / 응시 → (시험, 버전, 학생) 1—N 답안·채점 결과.
자세한 정의와 인덱스는 `migrations/0002_full_schema.sql` 참고.

## 2. 개발 환경 (Windows)

필요: **Node.js 20 이상** (22 LTS 권장), PowerShell 또는 명령 프롬프트.

```powershell
npm install
# 설치 스크립트 승인 안내가 나오면 (npm 11 이상)
npm install-scripts approve esbuild workerd
npm rebuild esbuild workerd

copy .dev.vars.example .dev.vars   # 값(APP_SECRET, SETUP_TOKEN)을 바꾸세요
npm run db:local                   # 로컬 D1에 테이블 생성
npm run dev                        # API(8787) + 화면(5173) 동시 실행
```

- 학생 화면: http://localhost:5173/
- 관리자 화면: http://localhost:5173/admin → 처음에는 「최초 관리자 설정」에서 `.dev.vars`의 `SETUP_TOKEN` 입력
- 빌드된 결과로 Worker 하나만 실행하려면: `npm run build` 후 `npm run dev:api` → http://localhost:8787

| 명령 | 설명 |
| --- | --- |
| `npm run dev` | 개발 서버 (Vite + wrangler dev) |
| `npm run build` | 프론트엔드 빌드 → `dist/` |
| `npm run typecheck` | Worker·프론트 타입 검사 |
| `npm test` | 자동화 테스트 |
| `npm run check` | 타입 검사 + 테스트 + 빌드 |
| `npm run db:local` / `db:remote` | D1 마이그레이션 (로컬 / 운영) |
| `npm run deploy` | 빌드 후 Cloudflare 배포 |

## 3. 환경 변수

| 이름 | 종류 | 설명 |
| --- | --- | --- |
| `APP_SECRET` | 비밀(secret) | **필수.** 32자 이상 무작위 문자열. 응시 코드 해시(HMAC)와 미디어 서명 URL에 사용. 바꾸면 기존 응시 코드가 모두 무효가 됩니다. |
| `SETUP_TOKEN` | 비밀(secret) | 최초 관리자 계정을 만들 때 한 번 입력. 관리자가 생긴 뒤에는 쓰이지 않음 |
| `ACCESS_TEAM_DOMAIN` | 변수 | (선택) Cloudflare Access 팀 도메인. 예: `myschool.cloudflareaccess.com` |
| `ACCESS_AUD` | 변수 | (선택) Access 애플리케이션의 AUD 태그 |
| `ADMIN_EMAILS` | 변수 | (선택) Access로 들어온 이 이메일들은 관리자 계정을 자동 생성 (쉼표 구분) |

로컬은 `.dev.vars`(예시: `.dev.vars.example`), 운영은 `wrangler secret put` / `wrangler.toml [vars]`로 설정합니다.

## 4. 배포 (Cloudflare)

> 아래 단계는 학교 Cloudflare 계정 권한이 필요합니다.

```powershell
npx wrangler login
npx wrangler d1 create english-cbt          # 출력된 database_id를 wrangler.toml에 입력
npx wrangler r2 bucket create english-cbt-media
npx wrangler secret put APP_SECRET          # 32자 이상 무작위 값
npx wrangler secret put SETUP_TOKEN
npm run db:remote                           # 운영 D1에 테이블 생성
npm run deploy                              # 빌드 + Workers(Static Assets 포함) 배포
```

배포 후 `https://<주소>/api/health`에서 `{"ok":true,"db":true,"media":true,"secret":true}`를 확인하고, `/admin`에서 최초 관리자를 만듭니다.

- **Workers Static Assets**로 화면과 API를 한 Worker에서 제공합니다(`wrangler.toml [assets]`). 별도의 Cloudflare Pages 프로젝트는 필요하지 않습니다. Pages를 꼭 써야 한다면 `dist/`를 Pages에 올리고 `/api/*`를 이 Worker로 라우팅하면 됩니다.
- **Cron**(`*/5 * * * *`)이 시간이 지난 응시를 서버 기준으로 마감·채점하고 만료 세션을 정리합니다.

### Cloudflare Access (권장)
1. Zero Trust → Access → Applications에서 Self-hosted 앱을 만들고 경로를 `<주소>/admin*`, `<주소>/api/admin/*`로 지정, 교사 이메일만 허용합니다.
2. 앱의 AUD 태그와 팀 도메인을 `wrangler.toml [vars]`의 `ACCESS_AUD`, `ACCESS_TEAM_DOMAIN`에 넣고 다시 배포합니다.
3. Worker가 `Cf-Access-Jwt-Assertion` JWT의 서명(RS256)·만료·AUD·발급자를 검증합니다. 이메일이 `admins.email` 또는 `ADMIN_EMAILS`에 있어야 관리자로 인정됩니다.
4. Access를 쓰지 않아도 아이디·비밀번호 로그인(PBKDF2 해시, 세션 쿠키)으로 운영할 수 있습니다.

## 5. 보안 구현 요약

| 항목 | 구현 |
| --- | --- |
| 관리자 인증 | 비밀번호(PBKDF2-SHA256 10만 회) + HttpOnly·Secure·SameSite=Strict 세션 쿠키(8시간, 2시간 미사용 만료) / Cloudflare Access JWT 검증 |
| 서버 측 권한 검사 | 모든 `/api/admin/*`에서 세션 확인, 교사 계정·활동 기록은 최고 관리자 전용 |
| 요청 위조(CSRF) | 변경 요청에 `X-CBT-Admin` 헤더 필수 + Origin 검사 + SameSite=Strict |
| 학생 응시 권한 | 학생 세션(Bearer 토큰, 4시간) → 시험 대상 여부·공개 상태·응시 기간·본인 응시 여부를 서버에서 확인 |
| 정답 차단 | 학생 API는 정답·해설을 보내지 않음. 철자 배열 카드는 학생마다 서버에서 섞고 매핑은 서버에만 보관 |
| 채점 | 서버의 버전 스냅샷 기준으로만 채점(클라이언트 점수 무시), 중복 제출 시 재채점 안 함 |
| 응시 코드 | 32자 알파벳 8자리(약 1조 가지) `crypto.getRandomValues`, DB에는 HMAC-SHA256(학생ID+코드)만 저장, 재발급 시 이전 코드·세션 즉시 무효 |
| 무차별 대입 방지 | 학생별 로그인 실패 5회/15분 잠금, IP별 60회/15분, 관리자 아이디별 8회·IP별 30회/15분 |
| API 요청 제한 | 응시별 답안 저장 300회/분 (학교는 IP를 공유하므로 IP 단위 제한은 로그인에만 적용) |
| SQL 인젝션 | 모든 쿼리는 바인딩 파라미터 사용, 검색어 LIKE 특수문자 이스케이프 |
| XSS | React 자동 이스케이프(`dangerouslySetInnerHTML` 미사용) + CSP(`script-src 'self'`) + `X-Frame-Options: DENY` |
| 파일 업로드 | 실제 파일 시그니처(PNG/JPG/GIF/WEBP/MP3/WAV) 검사, 그림 5MB·음성 15MB 제한, 파일명 정리, 미디어 응답에 `sandbox` CSP |
| 미디어 접근 | 교사는 세션 쿠키, 학생은 해당 응시에 묶인 HMAC 서명 URL(만료 포함)로만 접근. 음성은 재생 요청 때만 20분짜리 URL 발급 |
| 개인정보 | 학년·반·번호·이름만 수집, 관리자만 열람, 활동 기록에 코드·비밀번호 미기록 |

## 6. 테스트

```powershell
npm test
```

| 파일 | 내용 |
| --- | --- |
| `tests/grading.test.ts` | 공개 전 누락 검사, 8개 유형 자동 채점(대소문자·공백·복수 정답·허용 답안·필수 낱말·부분 점수·수동 채점·철자 배열) |
| `tests/security-utils.test.ts` | 응시 코드 형식·충돌, 비밀번호 해시, 파일 시그니처 판별 |
| `tests/api.test.ts` | 로컬 D1·R2(Miniflare)로 전체 흐름: 관리자 인증·CSRF·로그인 제한 → 업로드 → 문제은행 → 학생·코드 → 시험 공개 검사 → 응시·자동 저장·재생 횟수 → 제출·채점 → 버전 보존 → 시간 종료 → 성적·수동 채점·재응시·코드 재발급·활동 기록 |
| `tests/migration.test.ts` | 1차 스키마 데이터가 2차 스키마로 옮겨지는지 |
| `tests/frontend-lib.test.ts` | 오프라인 답안 보관·재연결 동기화·순서 역전 방지, CSV, XLSX 구조 |

### 브라우저 화면 테스트 (E2E)
PC에 설치된 Edge(없으면 Chrome)를 Playwright로 직접 조작합니다. **빈 로컬 DB**에서 실행하세요.

```powershell
npm run build
npx wrangler dev --port 8787        # 다른 창에서 실행
npm run test:e2e                    # 스크린샷은 %TEMP%\cbt-e2e 에 저장
```

관리자 최초 설정 → 문제 등록(객관식·듣기·O/X·철자 배열, 임시 저장·누락 표시·음성 업로드·미리보기·필터) → 학생 일괄 등록·코드 쪽지 → 시험 구성·공개 → 학생 로그인(틀린 코드 포함)·응시·듣기 재생 횟수·**인터넷 끊김 후 자동 동기화**·새로고침 유지·철자 배열·미응답 경고·제출 → 휴대폰 화면(가로 스크롤 없음) → 성적 통계·정오표·응시 현황·Excel/CSV 다운로드 → 대시보드 → 활동 기록·로그아웃, 총 19개 시나리오.

최근 실행 결과: 단위·통합 **5개 파일, 83개 테스트 모두 통과**, 브라우저 E2E **19개 시나리오 모두 통과(콘솔 오류 없음)**. 별도로 `wrangler dev` 실제 서버에 대한 HTTP 점검(SPA 라우팅, 보안 헤더, R2 업로드, 서명 URL, 음성 Range 요청, 재생 횟수 제한, 제출·채점, cron 핸들러) 23개 항목도 모두 통과했습니다.

## 7. 1차 구현에서 바뀐 점
- `worker.js`(단일 파일) → `worker/src/` TypeScript 모듈, `public/index.html`(바닐라 JS) → React 앱. 원본은 `legacy/`에 보존.
- `0002` 마이그레이션이 1차 테이블을 `legacy_*`로 이름만 바꿔 보존하고, 문제·선택지·미디어·학생을 새 구조로 옮깁니다. 옮긴 문제는 모두 「임시 저장」 상태이므로 교사가 확인 후 「완성」으로 저장해야 합니다. 1차 시험·응시 기록은 구조가 달라 옮기지 않습니다.
- 1차 README의 후속 과제(Access JWT 검증, 로그인 제한, 코드 재발급, 파일 시그니처 검사, 학생 미디어 인증 URL, 재생 횟수 제한, 문항 섞기, 시간 종료 자동 제출, 문장형 기준·수동 채점, 명단 일괄 등록)를 모두 구현했습니다.

## 8. 실제 학교 운영 전 확인 사항
1. `APP_SECRET`을 충분히 긴 무작위 값으로 설정했는지, `.dev.vars`가 외부에 공유되지 않았는지
2. 관리자 화면에 Cloudflare Access를 적용했거나, 강한 비밀번호와 교사별 개별 계정을 쓰는지
3. 실제 학생 수만큼 동시 접속하는 **사전 점검(리허설)**: 학교 Wi-Fi, 태블릿 브라우저(Chrome/Safari/Whale), 이어폰 음량
4. 듣기 음성은 MP3(128kbps 내외) 권장. 학교망에서 첫 재생 지연이 없는지 확인
5. 학교 공용 IP 한 개로 많은 학생이 접속하므로, Cloudflare WAF 속도 제한 규칙을 추가할 경우 기준을 넉넉히(예: IP당 분당 수천 건) 잡을 것
6. 개인정보 처리 방침(보관 기간, 학년도 종료 후 학생·응시 기록 삭제 절차) 마련. 학급 삭제 시 소속 학생이 함께 삭제됨
7. D1 백업: Cloudflare D1 Time Travel(기본 30일) 확인, 학기말 성적은 Excel로 따로 보관
8. 1차 데이터를 쓰던 경우 이전된 문제를 검수하고 「완성」으로 저장
9. 결과 공개 방식(교사만 / 점수 / 점수+정오) 시험마다 확인
