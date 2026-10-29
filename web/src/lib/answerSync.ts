// 답안 자동 저장 + 오프라인 대비
// - 답을 고르면 바로 브라우저(localStorage)에 보관하고 잠시 뒤 서버로 전송합니다.
// - 인터넷이 끊기면 보관해 두었다가 다시 연결되면 자동으로 보냅니다.
// - rev(시각 기반 순번)를 함께 보내 서버가 늦게 도착한 옛 답안으로 덮어쓰지 않게 합니다.

export type SyncStatus = 'idle' | 'saving' | 'saved' | 'pending' | 'offline' | 'closed';

export interface PendingAnswer {
  itemId: string;
  response: string;
  rev: number;
}

export interface SyncDeps {
  send: (answers: PendingAnswer[]) => Promise<void>;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  /** 서버가 시험 종료(409)를 알리면 호출 */
  onClosed?: () => void;
  debounceMs?: number;
  now?: () => number;
}

export class AnswerSync {
  private pending: Record<string, PendingAnswer> = {};
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> | null = null;
  private retryDelay = 2000;
  private lastRev = 0;
  private listeners = new Set<(s: SyncStatus, pendingCount: number) => void>();
  status: SyncStatus = 'idle';
  private key: string;

  constructor(
    attemptId: string,
    private deps: SyncDeps,
  ) {
    this.key = `cbt.pending.${attemptId}`;
    try {
      this.pending = JSON.parse(this.storage?.getItem(this.key) || '{}');
    } catch {
      this.pending = {};
    }
    for (const p of Object.values(this.pending)) this.lastRev = Math.max(this.lastRev, p.rev);
    if (this.count) this.setStatus('pending');
  }

  private get storage() {
    return this.deps.storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined);
  }
  get count() {
    return Object.keys(this.pending).length;
  }
  /** 아직 서버에 저장되지 않은 답안 */
  pendingAnswers(): PendingAnswer[] {
    return Object.values(this.pending);
  }

  subscribe(fn: (s: SyncStatus, pendingCount: number) => void) {
    this.listeners.add(fn);
    fn(this.status, this.count);
    return () => void this.listeners.delete(fn);
  }

  private setStatus(s: SyncStatus) {
    this.status = s;
    this.listeners.forEach((fn) => fn(s, this.count));
  }

  private persist() {
    try {
      if (this.count) this.storage?.setItem(this.key, JSON.stringify(this.pending));
      else this.storage?.removeItem(this.key);
    } catch {
      /* 저장 공간이 없어도 서버 전송은 계속 시도 */
    }
  }

  nextRev() {
    const t = (this.deps.now ?? Date.now)();
    this.lastRev = Math.max(t, this.lastRev + 1);
    return this.lastRev;
  }

  set(itemId: string, response: string) {
    if (this.status === 'closed') return;
    this.pending[itemId] = { itemId, response, rev: this.nextRev() };
    this.persist();
    this.setStatus('pending');
    this.schedule(this.deps.debounceMs ?? 600);
  }

  private schedule(ms: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, ms);
  }

  /** 대기 중인 답안을 지금 보냅니다. 실패하면 점점 간격을 늘려 다시 시도합니다. */
  async flush(): Promise<boolean> {
    if (this.inflight) await this.inflight;
    if (!this.count || this.status === 'closed') return !this.count;
    const batch = this.pendingAnswers();
    let ok = false;
    this.setStatus('saving');
    this.inflight = (async () => {
      try {
        await this.deps.send(batch);
        // 보내는 사이 다시 바뀐 답안은 남겨 둠
        for (const b of batch) if (this.pending[b.itemId]?.rev === b.rev) delete this.pending[b.itemId];
        this.persist();
        this.retryDelay = 2000;
        ok = true;
        this.setStatus(this.count ? 'pending' : 'saved');
        if (this.count) this.schedule(200);
      } catch (e) {
        const status = (e as { status?: number }).status;
        if (status === 409) {
          this.setStatus('closed');
          this.deps.onClosed?.();
          return;
        }
        this.setStatus(status === 0 || status === undefined ? 'offline' : 'pending');
        this.schedule(this.retryDelay);
        this.retryDelay = Math.min(this.retryDelay * 2, 15000);
      }
    })();
    await this.inflight;
    this.inflight = null;
    return ok;
  }

  /** 제출이 끝나면 보관한 답안 정리 */
  clear() {
    if (this.timer) clearTimeout(this.timer);
    this.pending = {};
    this.persist();
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.listeners.clear();
  }
}
