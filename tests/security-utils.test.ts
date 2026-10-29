import { describe, expect, it } from 'vitest';
import { generateAccessCode, hashPassword, normalizeCode, randomPermutation, safeEqual, verifyPassword } from '../worker/src/crypto';
import { sniffMedia } from '../worker/src/media';
import { MP3, PNG } from './helpers';

describe('응시 코드', () => {
  it('형식: XXXX-XXXX, 혼동 문자 제외', () => {
    for (let i = 0; i < 200; i++) expect(generateAccessCode()).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  });
  it('충돌이 거의 없음', () => {
    const set = new Set(Array.from({ length: 5000 }, generateAccessCode));
    expect(set.size).toBe(5000);
  });
  it('입력 정규화 (소문자, 하이픈·공백 허용)', () => {
    expect(normalizeCode(' ab3d-ef9h ')).toBe('AB3DEF9H');
  });
});

describe('비밀번호 해시', () => {
  it('PBKDF2 저장 및 검증', async () => {
    const h = await hashPassword('teacher1234');
    expect(h.startsWith('pbkdf2$100000$')).toBe(true);
    expect(await verifyPassword('teacher1234', h)).toBe(true);
    expect(await verifyPassword('teacher1235', h)).toBe(false);
    expect(await verifyPassword('x', null)).toBe(false);
  });
  it('safeEqual', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'ab')).toBe(false);
  });
});

describe('업로드 파일 형식 판별', () => {
  it('실제 파일 시그니처로 판별', () => {
    expect(sniffMedia(PNG)).toEqual({ kind: 'image', mime: 'image/png' });
    expect(sniffMedia(MP3)).toEqual({ kind: 'audio', mime: 'audio/mpeg' });
    expect(sniffMedia(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))?.mime).toBe('image/jpeg');
    const wav = new TextEncoder().encode('RIFF\0\0\0\0WAVEfmt ');
    expect(sniffMedia(wav)?.mime).toBe('audio/wav');
    expect(sniffMedia(new TextEncoder().encode('<svg onload=alert(1)>'))).toBeNull();
    expect(sniffMedia(new TextEncoder().encode('<html><script>'))).toBeNull();
  });
});

describe('무작위 순열', () => {
  it('모든 원소를 한 번씩 포함', () => {
    const p = randomPermutation(10);
    expect([...p].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
