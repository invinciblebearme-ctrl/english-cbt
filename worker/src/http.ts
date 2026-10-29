import type { AdminUser, Env, StudentUser } from './env';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'DENY',
};

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS, ...headers },
  });
}

export const fail = (status: number, message: string, extra?: Record<string, unknown>): never => {
  throw new HttpError(status, message, extra);
};

const MAX_JSON_BYTES = 1024 * 1024;

export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  const type = req.headers.get('content-type') || '';
  if (!type.includes('application/json')) fail(415, 'JSON 형식의 요청이 필요합니다.');
  const text = await req.text();
  if (text.length > MAX_JSON_BYTES) fail(413, '요청 데이터가 너무 큽니다.');
  try {
    const v = JSON.parse(text || '{}');
    if (!v || typeof v !== 'object') throw new Error();
    return v as T;
  } catch {
    return fail(400, '요청 데이터 형식이 올바르지 않습니다.');
  }
}

export interface Ctx {
  req: Request;
  env: Env;
  url: URL;
  params: Record<string, string>;
  ip: string;
  admin?: AdminUser;
  student?: StudentUser;
  /** 응답에 덧붙일 헤더 (Set-Cookie 등) */
  headers: Headers;
}

type Handler = (ctx: Ctx) => Promise<Response | unknown>;
interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];
  on(method: string, path: string, handler: Handler) {
    const keys: string[] = [];
    const pattern = new RegExp(
      '^' +
        path.replace(/:([a-zA-Z]+)/g, (_, k) => {
          keys.push(k);
          return '([^/]+)';
        }) +
        '$',
    );
    this.routes.push({ method, pattern, keys, handler });
    return this;
  }
  get = (p: string, h: Handler) => this.on('GET', p, h);
  post = (p: string, h: Handler) => this.on('POST', p, h);
  put = (p: string, h: Handler) => this.on('PUT', p, h);
  delete = (p: string, h: Handler) => this.on('DELETE', p, h);

  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | 'method' | null {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.pattern.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { handler: r.handler, params };
    }
    return pathMatched ? 'method' : null;
  }
}

/** 정수 파라미터 검증 */
export function int(v: unknown, name: string, min = -Infinity, max = Infinity): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) fail(400, `${name} 값이 올바르지 않습니다.`);
  return n;
}

export function str(v: unknown, name: string, maxLen = 2000, required = false): string {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string' && typeof v !== 'number') fail(400, `${name} 값이 올바르지 않습니다.`);
  const s = String(v);
  if (s.length > maxLen) fail(400, `${name}은(는) ${maxLen}자 이하로 입력하세요.`);
  if (required && !s.trim()) fail(400, `${name}을(를) 입력하세요.`);
  return s;
}

export function optionalTime(v: unknown, name: string): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Date.parse(String(v));
  if (!Number.isFinite(n)) fail(400, `${name} 값이 올바르지 않습니다.`);
  return n;
}
