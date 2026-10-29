import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../lib/api';
import { cx } from './ui';

type Phase = 'idle' | 'requesting' | 'loading' | 'playing' | 'paused' | 'ended' | 'error';

/**
 * 듣기 문항 재생기.
 * 새로 듣기를 누를 때만 서버에 재생을 요청해 횟수를 차감하고(새로고침해도 유지),
 * 일시정지 후 이어 듣기는 횟수를 쓰지 않습니다.
 */
export default function AudioPlayer({
  playsUsed,
  playLimit,
  requestPlay,
  disabled,
}: {
  playsUsed: number;
  playLimit: number;
  requestPlay: () => Promise<{ url: string; playsUsed: number }>;
  disabled?: boolean;
}) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [used, setUsed] = useState(playsUsed);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState(0);
  const [completed, setCompleted] = useState(false);

  useEffect(() => setUsed(playsUsed), [playsUsed]);
  useEffect(
    () => () => {
      audio.current?.pause();
      audio.current = null;
    },
    [],
  );

  const unlimited = playLimit === 0;
  const remaining = unlimited ? Infinity : Math.max(0, playLimit - used);

  async function startNew() {
    setError('');
    setPhase('requesting');
    try {
      const r = await requestPlay();
      setUsed(r.playsUsed);
      audio.current?.pause();
      const el = new Audio(r.url);
      el.preload = 'auto';
      el.onwaiting = () => setPhase('loading');
      el.onplaying = () => setPhase('playing');
      el.onpause = () => !el.ended && setPhase('paused');
      el.ontimeupdate = () => el.duration && setProgress(el.currentTime / el.duration);
      el.onended = () => {
        setPhase('ended');
        setProgress(1);
        setCompleted(true);
      };
      el.onerror = () => {
        setPhase('error');
        setError('음성을 불러오지 못했습니다. 인터넷 연결을 확인하세요.');
      };
      audio.current = el;
      setPhase('loading');
      await el.play();
    } catch (e) {
      setPhase('error');
      setError(errorMessage(e));
      const d = (e as { data?: { playsUsed?: number } }).data;
      if (d?.playsUsed !== undefined) setUsed(d.playsUsed);
    }
  }

  const canStart = !disabled && remaining > 0 && phase !== 'requesting' && phase !== 'loading';

  return (
    <div className="rounded-2xl border-2 border-blue-200 bg-blue-50 p-4">
      <div className="flex flex-wrap items-center gap-3">
        {phase === 'playing' || phase === 'loading' ? (
          <button
            type="button"
            onClick={() => audio.current?.pause()}
            className="flex min-w-36 items-center justify-center gap-2 rounded-xl bg-white px-5 py-3 text-lg font-bold text-blue-700 ring-2 ring-blue-300"
          >
            ⏸ 일시정지
          </button>
        ) : phase === 'paused' ? (
          <button
            type="button"
            onClick={() => audio.current?.play().catch((e) => setError(errorMessage(e)))}
            className="flex min-w-36 items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 py-3 text-lg font-bold text-white"
          >
            ▶ 이어 듣기
          </button>
        ) : null}
        {phase !== 'playing' && phase !== 'loading' && (
          <button
            type="button"
            onClick={startNew}
            disabled={!canStart}
            className={cx(
              'flex min-w-36 items-center justify-center gap-2 rounded-xl px-5 py-3 text-lg font-bold disabled:cursor-not-allowed disabled:opacity-50',
              phase === 'paused' ? 'bg-white text-blue-700 ring-2 ring-blue-300' : 'bg-blue-600 text-white',
            )}
          >
            {phase === 'requesting' ? '준비 중…' : used === 0 ? '🔊 듣기' : '🔁 처음부터 다시 듣기'}
          </button>
        )}
        <div className="text-base font-semibold text-slate-700" aria-live="polite">
          {unlimited ? `들은 횟수 ${used}번` : `들은 횟수 ${used} / ${playLimit}`}
          {!unlimited && remaining === 0 && <span className="ml-2 text-red-600">(모두 들었어요)</span>}
        </div>
        {phase === 'loading' && <span className="text-sm text-blue-700">음성 불러오는 중…</span>}
        {completed && phase !== 'playing' && phase !== 'loading' && <span className="text-sm font-semibold text-emerald-700">✓ 재생 완료</span>}
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-blue-100" aria-hidden>
        <div className="h-full bg-blue-500 transition-all" style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>
      {error && (
        <p className="mt-2 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
