const pad = (n: number) => String(n).padStart(2, '0');

export function formatDateTime(t: number | null | undefined) {
  if (!t) return '-';
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatFullDateTime(t: number | null | undefined) {
  if (!t) return '-';
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** <input type="datetime-local"> 값 ↔ 밀리초 */
export function toLocalInput(t: number | null | undefined) {
  if (!t) return '';
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export const fromLocalInput = (s: string) => (s ? new Date(s).getTime() : null);

export function formatRemaining(ms: number) {
  if (ms <= 0) return '0:00';
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

export const studentLabel = (s: { grade: number; class_no?: number; classNo?: number; number: number; name: string }) =>
  `${s.grade}-${s.class_no ?? s.classNo}-${s.number} ${s.name}`;
