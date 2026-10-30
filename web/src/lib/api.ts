export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public data: Record<string, any> = {},
  ) {
    super(message);
  }
}

const STUDENT_TOKEN_KEY = 'cbt.student.token';

export const studentToken = {
  get: () => sessionStorage.getItem(STUDENT_TOKEN_KEY) || '',
  set: (t: string) => sessionStorage.setItem(STUDENT_TOKEN_KEY, t),
  clear: () => sessionStorage.removeItem(STUDENT_TOKEN_KEY),
};

async function request<T>(scope: 'admin' | 'student', method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = {};
  if (scope === 'admin') headers['x-cbt-admin'] = '1';
  else {
    const t = studentToken.get();
    if (t) headers.authorization = `Bearer ${t}`;
  }
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    // 관리자 API는 Cloudflare Access 로그인 페이지로 리디렉션될 수 있으므로 직접 따라가지 않음
    res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin', signal, redirect: scope === 'admin' ? 'manual' : 'follow' });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, '인터넷 연결을 확인하세요.');
  }
  if (res.type === 'opaqueredirect') {
    // Access 로그인 시간이 끝남 → 새로고침하면 Access 로그인 화면으로 이동
    setTimeout(() => window.location.reload(), 1500);
    throw new ApiError(401, '보안 로그인 시간이 끝났습니다. 잠시 후 로그인 화면으로 이동합니다.');
  }
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json().catch(() => ({})) : {};
  if (!res.ok) throw new ApiError(res.status, (data as any).error || `요청에 실패했습니다. (${res.status})`, data as any);
  return data as T;
}

const make = (scope: 'admin' | 'student') => ({
  get: <T = any>(p: string, signal?: AbortSignal) => request<T>(scope, 'GET', p, undefined, signal),
  post: <T = any>(p: string, b: unknown = {}) => request<T>(scope, 'POST', p, b),
  put: <T = any>(p: string, b: unknown = {}) => request<T>(scope, 'PUT', p, b),
  del: <T = any>(p: string) => request<T>(scope, 'DELETE', p),
});

export const adminApi = make('admin');
export const studentApi = make('student');

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : '알 수 없는 오류가 발생했습니다.');
