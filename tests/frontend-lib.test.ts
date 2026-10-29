import { describe, expect, it, vi } from 'vitest';
import { AnswerSync, type PendingAnswer } from '../web/src/lib/answerSync';
import { crc32, parseCsv, toCsv, toXlsx } from '../web/src/lib/exporters';

class MemStorage {
  m = new Map<string, string>();
  getItem = (k: string) => this.m.get(k) ?? null;
  setItem = (k: string, v: string) => void this.m.set(k, v);
  removeItem = (k: string) => void this.m.delete(k);
}

const offline = () => Object.assign(new Error('offline'), { status: 0 });

describe('AnswerSync (자동 저장·오프라인 동기화)', () => {
  it('답안을 모아 서버로 보내고 저장 완료 상태가 됨', async () => {
    const sent: PendingAnswer[][] = [];
    const s = new AnswerSync('a1', { send: async (l) => void sent.push(l), storage: new MemStorage(), debounceMs: 10_000 });
    s.set('i1', '1');
    s.set('i2', 'apple');
    s.set('i1', '2');
    expect(s.count).toBe(2);
    await s.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0].find((x) => x.itemId === 'i1')!.response).toBe('2');
    expect(s.status).toBe('saved');
    expect(s.count).toBe(0);
    s.dispose();
  });

  it('인터넷이 끊기면 기기에 보관, 새로고침해도 남아 있고 연결되면 전송', async () => {
    const storage = new MemStorage();
    const s1 = new AnswerSync('a2', { send: async () => Promise.reject(offline()), storage, debounceMs: 10_000 });
    s1.set('i1', 'O');
    expect(await s1.flush()).toBe(false);
    expect(s1.status).toBe('offline');
    s1.dispose();

    // 브라우저 새로고침 → 새 인스턴스가 보관된 답안을 복원
    const send = vi.fn(async () => {});
    const s2 = new AnswerSync('a2', { send, storage, debounceMs: 10_000 });
    expect(s2.count).toBe(1);
    expect(s2.status).toBe('pending');
    expect(await s2.flush()).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    expect(storage.getItem('cbt.pending.a2')).toBeNull();
    s2.dispose();
  });

  it('전송 중 다시 바뀐 답은 지우지 않고 다음에 보냄', async () => {
    let release!: () => void;
    const calls: PendingAnswer[][] = [];
    const s = new AnswerSync('a3', {
      send: (l) => {
        calls.push(l);
        return calls.length === 1 ? new Promise<void>((r) => (release = r)) : Promise.resolve();
      },
      storage: new MemStorage(),
      debounceMs: 10_000,
    });
    s.set('i1', 'first');
    const p = s.flush();
    s.set('i1', 'second');
    release();
    await p;
    expect(s.count).toBe(1);
    await s.flush();
    expect(calls[1][0].response).toBe('second');
    expect(calls[1][0].rev).toBeGreaterThan(calls[0][0].rev);
    s.dispose();
  });

  it('rev는 항상 증가', () => {
    const s = new AnswerSync('a4', { send: async () => {}, storage: new MemStorage(), now: () => 1000 });
    expect([s.nextRev(), s.nextRev(), s.nextRev()]).toEqual([1000, 1001, 1002]);
    s.dispose();
  });

  it('서버가 시험 종료(409)를 알리면 closed', async () => {
    const onClosed = vi.fn();
    const s = new AnswerSync('a5', { send: async () => Promise.reject(Object.assign(new Error('closed'), { status: 409 })), storage: new MemStorage(), onClosed, debounceMs: 10_000 });
    s.set('i1', 'x');
    await s.flush();
    expect(s.status).toBe('closed');
    expect(onClosed).toHaveBeenCalled();
    s.dispose();
  });
});

describe('CSV', () => {
  it('BOM·따옴표·수식 주입 방지', () => {
    const csv = toCsv([
      ['이름', '메모'],
      ['김"하나', '=1+1'],
    ]);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain('"김""하나"');
    expect(csv).toContain("'=1+1");
  });
  it('파싱 (붙여넣기 탭 구분 포함)', () => {
    expect(parseCsv('학년,반,번호,이름\r\n4,1,1,"김, 하나"\n4\t1\t2\t이둘\n')).toEqual([
      ['학년', '반', '번호', '이름'],
      ['4', '1', '1', '김, 하나'],
      ['4', '1', '2', '이둘'],
    ]);
  });
});

describe('XLSX', () => {
  it('CRC32 표준 값', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
  it('올바른 ZIP 구조와 시트 내용', () => {
    const bytes = toXlsx([{ name: '성적', rows: [['이름', '점수'], ['김<하나>', 95]] }]);
    expect(String.fromCharCode(bytes[0], bytes[1])).toBe('PK');
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('xl/worksheets/sheet1.xml');
    expect(text).toContain('김&lt;하나&gt;');
    expect(text).toContain('<v>95</v>');
    expect(text).toContain('name="성적"');
    // 끝 레코드(EOCD) 존재
    const dv = new DataView(bytes.buffer, bytes.byteOffset + bytes.length - 22);
    expect(dv.getUint32(0, true)).toBe(0x06054b50);
    expect(dv.getUint16(10, true)).toBe(6);
  });
});
