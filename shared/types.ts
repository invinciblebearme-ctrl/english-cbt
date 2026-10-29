// 프론트엔드와 Worker가 함께 사용하는 타입과 상수

export const QUESTION_TYPES = [
  'mc_text',
  'mc_image',
  'ox',
  'short',
  'sentence',
  'listen_mc',
  'listen_image',
  'arrange',
] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  mc_text: '객관식 (텍스트 선택)',
  mc_image: '객관식 (그림 선택)',
  ox: 'O/X 선택',
  short: '단답형',
  sentence: '문장 입력형',
  listen_mc: '듣기 객관식',
  listen_image: '듣기 그림 선택',
  arrange: '철자 배열',
};

export const DOMAINS = ['듣기', '말하기', '읽기', '쓰기'] as const;
export type Domain = (typeof DOMAINS)[number];

export const DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];
export const DIFFICULTY_LABELS: Record<Difficulty, string> = { easy: '쉬움', medium: '보통', hard: '어려움' };

export type ResultPolicy = 'hidden' | 'score' | 'review';
export const RESULT_POLICY_LABELS: Record<ResultPolicy, string> = {
  hidden: '교사만 확인',
  score: '제출 후 점수 공개',
  review: '제출 후 점수와 문항별 정오 공개',
};

export type ExamStatus = 'draft' | 'published' | 'closed';
export const EXAM_STATUS_LABELS: Record<ExamStatus, string> = { draft: '비공개', published: '공개', closed: '종료' };

export const CHOICE_TYPES: QuestionType[] = ['mc_text', 'mc_image', 'listen_mc', 'listen_image'];
export const IMAGE_CHOICE_TYPES: QuestionType[] = ['mc_image', 'listen_image'];
export const LISTENING_TYPES: QuestionType[] = ['listen_mc', 'listen_image'];
export const TEXT_INPUT_TYPES: QuestionType[] = ['short', 'sentence'];

/** 정답 정보. 유형마다 사용하는 필드가 다릅니다. */
export interface AnswerKey {
  /** 객관식: 정답 선택지 번호(1부터) */
  choices?: number[];
  /** O/X */
  value?: 'O' | 'X' | '';
  /** 단답형·문장형·철자배열: 정답 목록 (여러 개면 모두 정답) */
  accepted?: string[];
  /** 단답형·문장형: 추가로 허용할 답안 목록 */
  alternatives?: string[];
  /** 대소문자 구분 (기본: 구분하지 않음) */
  caseSensitive?: boolean;
  /** 앞뒤 공백 무시 및 연속 공백 정리 (기본: 사용) */
  trimSpaces?: boolean;
  /** 문장형: 마침표·물음표 등 문장부호 무시 */
  ignorePunctuation?: boolean;
  /** 문장형 채점 기준 */
  mode?: 'exact' | 'keywords' | 'manual';
  /** 문장형 keywords 모드: 반드시 포함해야 하는 낱말 */
  keywords?: string[];
  /** keywords 모드에서 포함 비율만큼 부분 점수 */
  partialCredit?: boolean;
  /** 자동 채점에서 오답이면 교사 확인 대기로 둠 */
  reviewIfIncorrect?: boolean;
  /** 철자 배열: 카드를 이어 붙일 때 사이에 넣을 문자 ('' = 철자, ' ' = 낱말) */
  joiner?: string;
}

export interface ChoiceInput {
  text: string;
  mediaId: string | null;
}

/** 관리자가 편집하는 문제 데이터 */
export interface QuestionInput {
  grade: number;
  unit: number;
  domain: Domain;
  type: QuestionType;
  prompt: string;
  passage: string;
  imageMediaId: string | null;
  audioMediaId: string | null;
  choices: ChoiceInput[];
  answer: AnswerKey;
  points: number;
  difficulty: Difficulty;
  explanation: string;
  status: 'draft' | 'ready';
}

/** 시험 버전에 고정되는 문항 스냅샷 (정답 포함, 학생에게 그대로 보내지 않음) */
export interface QuestionSnapshot {
  questionId: string;
  type: QuestionType;
  domain: Domain;
  prompt: string;
  passage: string;
  imageMediaId: string | null;
  audioMediaId: string | null;
  choices: ChoiceInput[];
  answer: AnswerKey;
  explanation: string;
}

/** 학생에게 보내는 문항 (정답·해설 없음) */
export interface StudentItem {
  itemId: string;
  no: number;
  type: QuestionType;
  domain: Domain;
  prompt: string;
  passage: string;
  imageUrl: string | null;
  hasAudio: boolean;
  playLimit: number;
  playsUsed: number;
  choices: { no: number; text: string; imageUrl: string | null }[];
  tiles: { index: number; text: string }[];
  joiner: string;
  points: number;
}

export interface GradeOutcome {
  score: number;
  isCorrect: boolean | null;
  status: 'auto' | 'pending';
}
