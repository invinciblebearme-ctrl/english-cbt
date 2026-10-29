const enc = new TextEncoder();

export const uid = () => crypto.randomUUID();

const toHex = (buf: ArrayBuffer | Uint8Array) =>
  Array.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(s: string): Uint8Array {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** 세션 토큰 등 무작위 비밀값 */
export const randomToken = (bytes = 32) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));

export async function sha256(s: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

const hmacKeys = new Map<string, Promise<CryptoKey>>();
function hmacKey(secret: string) {
  let k = hmacKeys.get(secret);
  if (!k) {
    k = crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    hmacKeys.set(secret, k);
  }
  return k;
}

export async function hmac(secret: string, data: string): Promise<string> {
  return toHex(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(data)));
}

/** 길이가 같을 때 비교 시간이 일정한 문자열 비교 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// 혼동하기 쉬운 I, O, 0, 1 을 뺀 32자 → 바이트 & 31 로 편향 없이 선택
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 8;

/** 학생 응시 코드 (예: 7KQ4-MZ9P, 32^8 ≈ 1조 가지) */
export function generateAccessCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  const raw = Array.from(bytes, (b) => CODE_ALPHABET[b & 31]).join('');
  return raw.slice(0, 4) + '-' + raw.slice(4);
}

export const normalizeCode = (code: string) =>
  String(code || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

const PBKDF2_ITERATIONS = 100_000; // Workers 런타임 상한

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64url(salt)}$${b64url(bits)}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [scheme, iter, salt, hash] = stored.split('$');
  if (scheme !== 'pbkdf2') return false;
  const bits = await pbkdf2(password, fromB64url(salt), Number(iter));
  return safeEqual(b64url(bits), hash);
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

/** 0..n-1 을 무작위로 섞은 배열 */
export function randomPermutation(n: number): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  const r = crypto.getRandomValues(new Uint32Array(Math.max(n, 1)));
  for (let i = n - 1; i > 0; i--) {
    const j = r[i] % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
