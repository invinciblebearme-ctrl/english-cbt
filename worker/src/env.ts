export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  ASSETS?: Fetcher;
  /** 응시 코드 해시와 미디어 서명에 쓰는 서버 비밀값 */
  APP_SECRET?: string;
  /** 최초 관리자 생성 토큰 */
  SETUP_TOKEN?: string;
  /** Cloudflare Access 팀 도메인 (예: myschool.cloudflareaccess.com) */
  ACCESS_TEAM_DOMAIN?: string;
  /** Cloudflare Access 애플리케이션 AUD 태그 */
  ACCESS_AUD?: string;
  /** Access 로그인 시 자동으로 관리자 계정을 만들 이메일 목록 (쉼표 구분) */
  ADMIN_EMAILS?: string;
}

export interface AdminUser {
  id: string;
  username: string;
  display_name: string;
  email: string | null;
  role: 'owner' | 'teacher';
}

export interface StudentUser {
  sessionId: string;
  studentId: string;
  name: string;
  grade: number;
  classNo: number;
  number: number;
}
