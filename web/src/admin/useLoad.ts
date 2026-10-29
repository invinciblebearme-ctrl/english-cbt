import { useCallback, useEffect, useState } from 'react';
import { ApiError, errorMessage } from '../lib/api';

/** 관리자 화면 데이터 불러오기 (세션 만료 시 로그인 화면으로) */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(fn, deps);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await run());
      setError('');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) window.dispatchEvent(new Event('cbt-admin-expired'));
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [run]);
  useEffect(() => void reload(), [reload]);
  return { data, error, loading, reload, setData, setError };
}

/** 버튼 동작 공통 처리: 진행 표시 + 성공/오류 메시지 */
export function useAction() {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const run = useCallback(async (key: string, fn: () => Promise<unknown>, success?: string) => {
    setBusy(key);
    setError('');
    setNotice('');
    try {
      await fn();
      if (success) setNotice(success);
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) window.dispatchEvent(new Event('cbt-admin-expired'));
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy('');
    }
  }, []);
  return { busy, error, notice, setError, setNotice, run };
}
