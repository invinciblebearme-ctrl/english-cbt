import type { ReactNode } from 'react';
import type { StudentItem } from '../../../shared/types';
import { cx } from './ui';

const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];

/** 학생 화면과 교사 미리보기에서 같이 쓰는 문항 표시 */
export default function QuestionView({
  item,
  value,
  onChange,
  audio,
  disabled,
  correctChoice,
}: {
  item: StudentItem;
  value: string;
  onChange: (v: string) => void;
  audio?: ReactNode;
  disabled?: boolean;
  /** 미리보기에서 정답 표시용 */
  correctChoice?: string;
}) {
  const isChoice = ['mc_text', 'mc_image', 'listen_mc', 'listen_image'].includes(item.type);
  const imageChoices = item.type === 'mc_image' || item.type === 'listen_image';

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3">
        <span className="mt-1 shrink-0 rounded-lg bg-blue-600 px-2.5 py-1 text-lg font-bold text-white">{item.no}</span>
        <div className="min-w-0 flex-1">
          <p className="text-2xl leading-relaxed font-bold break-words whitespace-pre-line text-slate-900 sm:text-[1.7rem]">{item.prompt}</p>
          <p className="mt-1 text-sm text-slate-500">
            {item.domain} · {item.points}점
          </p>
        </div>
      </div>

      {item.hasAudio && audio}

      {item.passage && <div className="rounded-2xl bg-slate-50 p-5 text-xl leading-relaxed whitespace-pre-line text-slate-800 ring-1 ring-slate-200">{item.passage}</div>}

      {item.imageUrl && (
        <div className="flex justify-center">
          <img src={item.imageUrl} alt="문제 그림" className="max-h-80 rounded-2xl object-contain ring-1 ring-slate-200" />
        </div>
      )}

      {isChoice && (
        <div role="radiogroup" aria-label="선택지" className={cx('grid gap-3', imageChoices ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-1')}>
          {item.choices.map((c) => {
            const v = String(c.no);
            const selected = value === v;
            return (
              <button
                key={c.no}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={disabled}
                onClick={() => onChange(selected ? '' : v)}
                className={cx(
                  'relative flex items-center gap-3 rounded-2xl border-2 p-4 text-left text-xl transition',
                  imageChoices && 'flex-col justify-center',
                  selected ? 'border-blue-600 bg-blue-50 ring-2 ring-blue-200' : 'border-slate-200 bg-white hover:border-blue-300',
                  correctChoice === v && 'outline-3 outline-emerald-500',
                )}
              >
                <span className={cx('text-2xl font-bold', selected ? 'text-blue-700' : 'text-slate-500')}>{CIRCLED[c.no - 1] ?? c.no}</span>
                {c.imageUrl ? <img src={c.imageUrl} alt={`${c.no}번 그림`} className="h-32 w-full object-contain" /> : null}
                {c.text && <span className="font-medium break-words">{c.text}</span>}
                {!c.text && !c.imageUrl && <span className="text-base text-slate-400">(그림 없음)</span>}
              </button>
            );
          })}
        </div>
      )}

      {item.type === 'ox' && (
        <div role="radiogroup" aria-label="O 또는 X" className="grid grid-cols-2 gap-4">
          {(['O', 'X'] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={value === v}
              disabled={disabled}
              onClick={() => onChange(value === v ? '' : v)}
              className={cx(
                'rounded-2xl border-2 py-8 text-6xl font-black transition',
                value === v ? (v === 'O' ? 'border-blue-600 bg-blue-50 text-blue-700' : 'border-red-500 bg-red-50 text-red-600') : 'border-slate-200 bg-white text-slate-400 hover:border-slate-400',
                correctChoice === v && 'outline-3 outline-emerald-500',
              )}
            >
              {v}
            </button>
          ))}
        </div>
      )}

      {item.type === 'short' && (
        <input
          aria-label="정답 입력"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          maxLength={200}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="여기에 영어로 답을 쓰세요"
          className="w-full rounded-2xl border-2 border-slate-300 px-5 py-4 text-2xl focus:border-blue-500 focus:outline-none"
        />
      )}

      {item.type === 'sentence' && (
        <textarea
          aria-label="문장 입력"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          maxLength={1000}
          rows={3}
          autoComplete="off"
          autoCapitalize="sentences"
          spellCheck={false}
          placeholder="여기에 영어 문장을 쓰세요"
          className="w-full rounded-2xl border-2 border-slate-300 px-5 py-4 text-2xl leading-relaxed focus:border-blue-500 focus:outline-none"
        />
      )}

      {item.type === 'arrange' && <ArrangeInput item={item} value={value} onChange={onChange} disabled={disabled} />}
    </div>
  );
}

function ArrangeInput({ item, value, onChange, disabled }: { item: StudentItem; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const picked = value ? value.split(',').map(Number).filter((n) => item.tiles.some((t) => t.index === n)) : [];
  const set = (arr: number[]) => onChange(arr.join(','));
  const tile = (i: number) => item.tiles.find((t) => t.index === i)!;
  return (
    <div className="space-y-4">
      <div className="min-h-20 rounded-2xl border-2 border-dashed border-blue-300 bg-blue-50/50 p-3" aria-label="만든 답">
        {picked.length ? (
          <div className="flex flex-wrap gap-2">
            {picked.map((i, k) => (
              <button
                key={`${i}-${k}`}
                type="button"
                disabled={disabled}
                onClick={() => set(picked.filter((_, j) => j !== k))}
                className="rounded-xl bg-blue-600 px-4 py-3 text-2xl font-bold text-white shadow"
                aria-label={`${tile(i).text} 빼기`}
              >
                {tile(i).text}
              </button>
            ))}
          </div>
        ) : (
          <p className="p-3 text-lg text-slate-500">아래 카드를 순서대로 눌러 답을 만드세요.</p>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {item.tiles.map((t) => {
          const used = picked.includes(t.index);
          return (
            <button
              key={t.index}
              type="button"
              disabled={disabled || used}
              onClick={() => set([...picked, t.index])}
              className={cx('rounded-xl border-2 px-4 py-3 text-2xl font-bold transition', used ? 'border-slate-200 bg-slate-100 text-slate-300' : 'border-slate-300 bg-white text-slate-800 hover:border-blue-400')}
            >
              {t.text}
            </button>
          );
        })}
      </div>
      {picked.length > 0 && (
        <div className="flex items-center gap-3">
          <span className="text-lg text-slate-600">
            만든 답: <b className="text-slate-900">{picked.map((i) => tile(i).text).join(item.joiner)}</b>
          </span>
          <button type="button" disabled={disabled} onClick={() => set([])} className="rounded-lg px-3 py-1 text-sm font-semibold text-blue-700 hover:bg-blue-50">
            다시 하기
          </button>
        </div>
      )}
    </div>
  );
}
