// 통합 테스트용 도구: wrangler getPlatformProxy로 로컬 D1·R2를 띄우고 Worker 핸들러를 직접 호출합니다.
import { getPlatformProxy } from 'wrangler';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Env } from '../worker/src/env';
import { handleApi } from '../worker/src/index';

export const SECRET = 'test-secret-0123456789-abcdefghijklmnopqrstuvwxyz';
export const SETUP_TOKEN = 'test-setup-token';

export function splitSql(sql: string): string[] {
  return sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function applyMigrations(db: D1Database, only?: string[]) {
  const dir = join(process.cwd(), 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    if (only && !only.includes(f)) continue;
    for (const stmt of splitSql(readFileSync(join(dir, f), 'utf8'))) await db.prepare(stmt).run();
  }
}

export async function createTestEnv(opts: { migrate?: boolean } = {}) {
  const proxy = await getPlatformProxy<Env>({ configPath: 'wrangler.toml', persist: false });
  const env: Env = { DB: proxy.env.DB, MEDIA: proxy.env.MEDIA, APP_SECRET: SECRET, SETUP_TOKEN };
  if (opts.migrate !== false) await applyMigrations(env.DB);
  return { env, dispose: () => proxy.dispose() };
}

/** 쿠키를 기억하는 간단한 API 클라이언트 */
export class Client {
  cookie = '';
  bearer = '';
  constructor(
    private env: Env,
    private admin = false,
    public ip = '10.0.0.1',
  ) {}

  async raw(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
    const headers: Record<string, string> = { 'cf-connecting-ip': this.ip, ...extraHeaders };
    if (this.admin) headers['x-cbt-admin'] = '1';
    if (this.cookie) headers.cookie = this.cookie;
    if (this.bearer) headers.authorization = `Bearer ${this.bearer}`;
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await handleApi(new Request(`http://localhost${path}`, { method, headers, body: payload }), this.env);
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const m = /cbt_admin=([^;]*)/.exec(setCookie);
      if (m) this.cookie = m[1] ? `cbt_admin=${m[1]}` : '';
    }
    return res;
  }

  async call<T = any>(method: string, path: string, body?: unknown, expectStatus?: number): Promise<{ status: number; data: T }> {
    const res = await this.raw(method, path, body);
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : await res.text();
    if (expectStatus !== undefined && res.status !== expectStatus) {
      throw new Error(`${method} ${path} → ${res.status} (expected ${expectStatus}): ${JSON.stringify(data)}`);
    }
    return { status: res.status, data: data as T };
  }

  get = <T = any>(p: string, s = 200) => this.call<T>('GET', p, undefined, s).then((r) => r.data);
  post = <T = any>(p: string, b: unknown = {}, s = 200) => this.call<T>('POST', p, b, s).then((r) => r.data);
  put = <T = any>(p: string, b: unknown = {}, s = 200) => this.call<T>('PUT', p, b, s).then((r) => r.data);
  del = <T = any>(p: string, s = 200) => this.call<T>('DELETE', p, undefined, s).then((r) => r.data);
}

/** 1x1 PNG */
export const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);
/** ID3 태그로 시작하는 MP3 흉내 데이터 */
export const MP3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0, ...new Array(200).fill(0x11)]);

export function fileForm(bytes: Uint8Array, name: string, type: string, kind?: string) {
  const f = new FormData();
  f.append('file', new File([bytes], name, { type }));
  if (kind) f.append('kind', kind);
  return f;
}
