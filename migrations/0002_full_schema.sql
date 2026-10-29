-- English CBT 2차 스키마
-- 1차 구현(0001) 테이블은 legacy_* 로 이름을 바꿔 보존하고, 문제·학생·미디어는 새 구조로 옮깁니다.
-- 1차 시험/응시 기록은 구조가 달라 옮기지 않으며 legacy_* 테이블에 그대로 남습니다.

ALTER TABLE questions RENAME TO legacy_questions;
ALTER TABLE exams RENAME TO legacy_exams;
ALTER TABLE exam_questions RENAME TO legacy_exam_questions;
ALTER TABLE students RENAME TO legacy_students;
ALTER TABLE enrollments RENAME TO legacy_enrollments;
ALTER TABLE attempts RENAME TO legacy_attempts;
ALTER TABLE responses RENAME TO legacy_responses;
ALTER TABLE media RENAME TO legacy_media;

-- 관리자(교사)
CREATE TABLE admins (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  email TEXT UNIQUE COLLATE NOCASE,
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'teacher' CHECK (role IN ('owner', 'teacher')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);

-- 관리자 세션 (id = 세션 토큰의 SHA-256)
CREATE TABLE admin_sessions (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX idx_admin_sessions_admin ON admin_sessions(admin_id);

-- 학급
CREATE TABLE classes (
  id TEXT PRIMARY KEY,
  school_year INTEGER NOT NULL,
  grade INTEGER NOT NULL CHECK (grade BETWEEN 1 AND 6),
  class_no INTEGER NOT NULL CHECK (class_no >= 1),
  name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE (school_year, grade, class_no)
);

-- 학생 (학년·반·번호·이름만 수집)
CREATE TABLE students (
  id TEXT PRIMARY KEY,
  class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  number INTEGER NOT NULL CHECK (number >= 1),
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE (class_id, number)
);

-- 응시 코드 (평문 저장 안 함: HMAC-SHA256 해시만 저장)
CREATE TABLE access_codes (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at INTEGER NOT NULL,
  created_by TEXT REFERENCES admins(id) ON DELETE SET NULL,
  first_used_at INTEGER,
  last_used_at INTEGER,
  use_count INTEGER NOT NULL DEFAULT 0,
  revoked_at INTEGER
);
CREATE INDEX idx_access_codes_student ON access_codes(student_id, status);

-- 학생 로그인 세션 (id = 토큰의 SHA-256)
CREATE TABLE student_sessions (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  access_code_id TEXT REFERENCES access_codes(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX idx_student_sessions_student ON student_sessions(student_id);

-- 미디어 파일 (R2 보관)
CREATE TABLE media (
  id TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'audio')),
  mime TEXT NOT NULL,
  original_name TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES admins(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);

-- 문제은행
CREATE TABLE questions (
  id TEXT PRIMARY KEY,
  grade INTEGER NOT NULL,
  unit INTEGER NOT NULL,
  domain TEXT NOT NULL CHECK (domain IN ('듣기', '말하기', '읽기', '쓰기')),
  type TEXT NOT NULL CHECK (type IN ('mc_text', 'mc_image', 'ox', 'short', 'sentence', 'listen_mc', 'listen_image', 'arrange')),
  prompt TEXT NOT NULL DEFAULT '',
  passage TEXT NOT NULL DEFAULT '',
  image_media_id TEXT REFERENCES media(id) ON DELETE SET NULL,
  audio_media_id TEXT REFERENCES media(id) ON DELETE SET NULL,
  answer TEXT NOT NULL DEFAULT '{}',
  points REAL NOT NULL DEFAULT 5,
  difficulty TEXT NOT NULL DEFAULT 'medium' CHECK (difficulty IN ('easy', 'medium', 'hard')),
  explanation TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready')),
  created_by TEXT REFERENCES admins(id) ON DELETE SET NULL,
  updated_by TEXT REFERENCES admins(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX idx_questions_filter ON questions(deleted_at, grade, unit, domain);

-- 문제 선택지 (철자 배열형은 낱말/철자 카드로 사용)
CREATE TABLE question_choices (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  media_id TEXT REFERENCES media(id) ON DELETE SET NULL,
  UNIQUE (question_id, seq)
);

-- 시험
CREATE TABLE exams (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  grade INTEGER NOT NULL,
  unit INTEGER NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  duration_min INTEGER NOT NULL DEFAULT 40 CHECK (duration_min BETWEEN 1 AND 300),
  audio_play_limit INTEGER NOT NULL DEFAULT 2 CHECK (audio_play_limit BETWEEN 0 AND 10),
  shuffle_questions INTEGER NOT NULL DEFAULT 0,
  start_at INTEGER,
  end_at INTEGER,
  result_policy TEXT NOT NULL DEFAULT 'hidden' CHECK (result_policy IN ('hidden', 'score', 'review')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'closed')),
  current_version_id TEXT,
  created_by TEXT REFERENCES admins(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

-- 시험 편집용 문항 목록 (공개 시 exam_version_items 로 고정됨)
CREATE TABLE exam_items (
  exam_id TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL REFERENCES questions(id),
  seq INTEGER NOT NULL,
  points REAL NOT NULL,
  PRIMARY KEY (exam_id, question_id)
);
CREATE INDEX idx_exam_items_seq ON exam_items(exam_id, seq);

-- 시험 버전 (공개 시점의 설정·문항·정답을 보존)
CREATE TABLE exam_versions (
  id TEXT PRIMARY KEY,
  exam_id TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL,
  duration_min INTEGER NOT NULL,
  audio_play_limit INTEGER NOT NULL,
  shuffle_questions INTEGER NOT NULL,
  total_points REAL NOT NULL,
  created_by TEXT REFERENCES admins(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (exam_id, version_no)
);

-- 시험별 문항 버전 (문제 내용·선택지·정답 스냅샷)
CREATE TABLE exam_version_items (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES exam_versions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  question_id TEXT NOT NULL,
  points REAL NOT NULL,
  snapshot TEXT NOT NULL,
  UNIQUE (version_id, seq)
);

-- 시험 대상 학생
CREATE TABLE exam_targets (
  exam_id TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (exam_id, student_id)
);
CREATE INDEX idx_exam_targets_student ON exam_targets(student_id);

-- 응시 기록
CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  exam_id TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES exam_versions(id),
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'submitted')),
  layout TEXT NOT NULL DEFAULT '{}',
  started_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  submitted_at INTEGER,
  submit_reason TEXT CHECK (submit_reason IN ('student', 'timeout', 'teacher')),
  total_score REAL,
  max_score REAL NOT NULL,
  grading_status TEXT NOT NULL DEFAULT 'none' CHECK (grading_status IN ('none', 'pending', 'complete')),
  archived INTEGER NOT NULL DEFAULT 0
);
-- 한 학생은 한 시험에 하나의 유효 응시만 가질 수 있음 (교사가 재응시 허용 시 archived=1 처리)
CREATE UNIQUE INDEX uq_attempts_active ON attempts(exam_id, student_id) WHERE archived = 0;
CREATE INDEX idx_attempts_status ON attempts(status, deadline_at);
CREATE INDEX idx_attempts_student ON attempts(student_id);

-- 학생 답안
CREATE TABLE answers (
  attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES exam_version_items(id),
  response TEXT NOT NULL,
  client_rev INTEGER NOT NULL DEFAULT 0,
  saved_at INTEGER NOT NULL,
  PRIMARY KEY (attempt_id, item_id)
);

-- 듣기 재생 횟수 (서버 기준)
CREATE TABLE audio_plays (
  attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES exam_version_items(id),
  play_count INTEGER NOT NULL DEFAULT 0,
  last_played_at INTEGER NOT NULL,
  PRIMARY KEY (attempt_id, item_id)
);

-- 채점 결과
CREATE TABLE grading_results (
  attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES exam_version_items(id),
  auto_score REAL NOT NULL DEFAULT 0,
  manual_score REAL,
  max_score REAL NOT NULL,
  is_correct INTEGER,
  status TEXT NOT NULL CHECK (status IN ('auto', 'pending', 'manual')),
  feedback TEXT NOT NULL DEFAULT '',
  graded_by TEXT REFERENCES admins(id) ON DELETE SET NULL,
  graded_at INTEGER NOT NULL,
  PRIMARY KEY (attempt_id, item_id)
);
CREATE INDEX idx_grading_pending ON grading_results(status);

-- 관리자 활동 기록
CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id TEXT REFERENCES admins(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '{}',
  ip TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_logs_created ON audit_logs(created_at);

-- 요청 제한 / 무차별 대입 방지 카운터
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);

-- ===== 1차 데이터 이전 (모두 '임시 저장' 상태로 옮겨 교사가 다시 검수) =====
INSERT INTO media (id, r2_key, kind, mime, original_name, size, created_at)
SELECT id, key, CASE WHEN mime LIKE 'audio/%' THEN 'audio' ELSE 'image' END, mime, name, 0,
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM legacy_media;

INSERT INTO questions (id, grade, unit, domain, type, prompt, image_media_id, audio_media_id, answer, points, status, created_at, updated_at)
SELECT q.id, q.grade, q.unit,
  CASE WHEN q.domain IN ('듣기', '말하기', '읽기', '쓰기') THEN q.domain ELSE '듣기' END,
  CASE q.type WHEN 'multiple' THEN 'mc_text' WHEN 'image' THEN 'mc_image' WHEN 'ox' THEN 'ox' WHEN 'short' THEN 'short' ELSE 'sentence' END,
  q.prompt,
  (SELECT m.id FROM media m WHERE json_valid(q.media) AND m.id = substr(json_extract(q.media, '$.image'), 12)),
  (SELECT m.id FROM media m WHERE json_valid(q.media) AND m.id = substr(json_extract(q.media, '$.audio'), 12)),
  CASE
    WHEN q.type IN ('multiple', 'image') AND CAST(q.answer AS INTEGER) > 0 THEN json_object('choices', json_array(CAST(q.answer AS INTEGER)))
    WHEN q.type = 'ox' THEN json_object('value', CASE WHEN q.answer IN ('1', 'O', 'o') THEN 'O' WHEN q.answer IN ('2', 'X', 'x') THEN 'X' ELSE '' END)
    WHEN q.type = 'short' THEN json_object('accepted', json_array(q.answer), 'caseSensitive', json('false'))
    WHEN q.type = 'sentence' THEN json_object('mode', 'exact', 'accepted', json_array(q.answer))
    ELSE '{}'
  END,
  q.points, 'draft',
  CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM legacy_questions q;

INSERT INTO question_choices (id, question_id, seq, text, media_id)
SELECT lower(hex(randomblob(16))), q.id, CAST(j.key AS INTEGER) + 1,
  CASE WHEN j.value LIKE '/api/media/%' THEN '' ELSE j.value END,
  CASE WHEN j.value LIKE '/api/media/%' THEN (SELECT m.id FROM media m WHERE m.id = substr(j.value, 12)) END
FROM legacy_questions q, json_each(CASE WHEN json_valid(q.choices) THEN q.choices ELSE '[]' END) j;

INSERT OR IGNORE INTO classes (id, school_year, grade, class_no, name, created_at)
SELECT lower(hex(randomblob(16))), CAST(strftime('%Y', 'now') AS INTEGER), grade, class_no, '', CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM (SELECT DISTINCT grade, class_no FROM legacy_students);

INSERT OR IGNORE INTO students (id, class_id, number, name, created_at)
SELECT s.id, c.id, s.student_no, s.name, CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM legacy_students s
JOIN classes c ON c.grade = s.grade AND c.class_no = s.class_no AND c.school_year = CAST(strftime('%Y', 'now') AS INTEGER);
