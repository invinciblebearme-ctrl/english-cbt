import { useRef, useState } from 'react';
import { adminApi, errorMessage } from '../lib/api';
import { mediaUrl } from './types';

/** 그림/음성 업로드 + 미리보기. 파일은 나중에 올려도 됩니다. */
export default function MediaPicker({
  kind,
  value,
  onChange,
  compact,
  label,
}: {
  kind: 'image' | 'audio';
  value: string | null;
  onChange: (id: string | null) => void;
  compact?: boolean;
  label?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function upload(file: File) {
    setError('');
    const max = kind === 'image' ? 5 : 15;
    if (file.size > max * 1024 * 1024) return setError(`${max}MB 이하 파일만 올릴 수 있습니다.`);
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('kind', kind);
      const r = await adminApi.post<{ id: string }>('/api/admin/media', form);
      onChange(r.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  const url = mediaUrl(value);
  return (
    <div className={compact ? 'space-y-1' : 'space-y-2 rounded-xl border border-dashed border-slate-300 p-3'}>
      {url && kind === 'image' && <img src={url} alt={label || '업로드한 그림'} className={compact ? 'h-20 w-full rounded-lg object-contain' : 'max-h-48 rounded-lg object-contain'} />}
      {url && kind === 'audio' && <audio controls src={url} className="w-full" preload="none" />}
      {!url && !compact && <p className="text-sm text-slate-500">{kind === 'image' ? '그림 없음 (PNG·JPG·GIF·WEBP, 5MB 이하)' : '음성 없음 (MP3·WAV, 15MB 이하)'}</p>}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => input.current?.click()}
          disabled={busy}
          className="rounded-lg bg-slate-100 px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-200 disabled:opacity-50"
          aria-label={`${label || ''} ${kind === 'image' ? '그림' : '음성'} ${url ? '바꾸기' : '올리기'}`}
        >
          {busy ? '올리는 중…' : url ? '바꾸기' : kind === 'image' ? '🖼 그림 올리기' : '🔊 음성 올리기'}
        </button>
        {url && (
          <button type="button" onClick={() => onChange(null)} className="rounded-lg px-3 py-1.5 text-sm font-semibold text-red-600 hover:bg-red-50">
            빼기
          </button>
        )}
      </div>
      <input
        ref={input}
        type="file"
        hidden
        accept={kind === 'image' ? 'image/png,image/jpeg,image/gif,image/webp' : 'audio/mpeg,audio/mp3,audio/wav,audio/x-wav,.mp3,.wav'}
        onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
      />
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
