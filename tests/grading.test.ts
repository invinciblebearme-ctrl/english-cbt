import { describe, expect, it } from 'vitest';
import { arrangeToText, gradeResponse, normalizeText, validateQuestion } from '../shared/grading';
import type { ChoiceInput, QuestionType } from '../shared/types';

const choices = (...t: string[]): ChoiceInput[] => t.map((text) => ({ text, mediaId: null }));
const base = { prompt: '문제', imageMediaId: null, audioMediaId: null, choices: [] as ChoiceInput[], answer: {}, points: 5 };

describe('validateQuestion (공개 전 누락 검사)', () => {
  it('완성된 객관식은 문제 없음', () => {
    expect(validateQuestion({ ...base, type: 'mc_text', choices: choices('a', 'b', 'c'), answer: { choices: [2] } })).toEqual([]);
  });
  it('듣기 문제는 음성이 없으면 공개 불가', () => {
    const issues = validateQuestion({ ...base, type: 'listen_mc', choices: choices('a', 'b'), answer: { choices: [1] } });
    expect(issues).toContain('듣기 음성 파일이 없습니다.');
  });
  it('그림 선택형은 선택지마다 그림이 필요', () => {
    const issues = validateQuestion({ ...base, type: 'mc_image', choices: [{ text: '', mediaId: 'm1' }, { text: '', mediaId: null }], answer: { choices: [1] } });
    expect(issues).toEqual(['2번 선택지 그림이 없습니다.']);
  });
  it('정답 범위, 빈 문제, 배점 검사', () => {
    const issues = validateQuestion({ ...base, prompt: ' ', points: 0, type: 'mc_text', choices: choices('a', 'b'), answer: { choices: [3] } });
    expect(issues).toEqual(expect.arrayContaining(['문제 내용이 없습니다.', '배점이 0보다 커야 합니다.', '정답 번호가 선택지 범위를 벗어났습니다.']));
  });
  it('O/X, 단답형, 문장형, 철자 배열', () => {
    expect(validateQuestion({ ...base, type: 'ox' })).toContain('O 또는 X 정답을 지정하세요.');
    expect(validateQuestion({ ...base, type: 'short', answer: { accepted: [' '] } })).toContain('정답을 1개 이상 입력하세요.');
    expect(validateQuestion({ ...base, type: 'sentence', answer: { mode: 'keywords' } })).toContain('필수 낱말을 1개 이상 입력하세요.');
    expect(validateQuestion({ ...base, type: 'sentence', answer: { mode: 'manual' } })).toEqual([]);
    expect(validateQuestion({ ...base, type: 'arrange', choices: choices('a') })).toHaveLength(1);
  });
});

describe('gradeResponse (자동 채점)', () => {
  const g = (type: QuestionType, answer: object, response: string, c = choices('a', 'b', 'c'), perm?: number[]) =>
    gradeResponse({ type, choices: c, answer }, response, 4, perm);

  it('객관식·듣기 객관식', () => {
    expect(g('mc_text', { choices: [2] }, '2')).toEqual({ score: 4, isCorrect: true, status: 'auto' });
    expect(g('listen_image', { choices: [2] }, '1').score).toBe(0);
    expect(g('mc_text', { choices: [2] }, '2abc').score).toBe(0);
  });
  it('O/X', () => {
    expect(g('ox', { value: 'X' }, 'x').isCorrect).toBe(true);
    expect(g('ox', { value: 'X' }, 'O').isCorrect).toBe(false);
  });
  it('빈 답안은 0점', () => {
    expect(g('short', { accepted: ['apple'] }, '   ')).toEqual({ score: 0, isCorrect: false, status: 'auto' });
  });
  it('단답형: 대소문자, 공백, 복수 정답, 허용 답안', () => {
    expect(g('short', { accepted: ['apple'] }, '  Apple ').isCorrect).toBe(true);
    expect(g('short', { accepted: ['apple'], caseSensitive: true }, 'Apple').isCorrect).toBe(false);
    expect(g('short', { accepted: ['apple'], trimSpaces: false }, ' apple').isCorrect).toBe(false);
    expect(g('short', { accepted: ['cat', 'kitten'] }, 'kitten').isCorrect).toBe(true);
    expect(g('short', { accepted: ['I am fine'], alternatives: ["I'm fine"] }, 'I’m   fine').isCorrect).toBe(true);
  });
  it('문장형: 정확히 일치(문장부호 무시), 필수 낱말, 부분 점수, 수동 채점', () => {
    expect(g('sentence', { mode: 'exact', accepted: ['How are you?'] }, 'how are you').isCorrect).toBe(true);
    expect(g('sentence', { mode: 'keywords', keywords: ['like', 'apples'] }, 'I like apples.').score).toBe(4);
    expect(g('sentence', { mode: 'keywords', keywords: ['like', 'apples'] }, 'I like bananas.').score).toBe(0);
    expect(g('sentence', { mode: 'keywords', keywords: ['like', 'apples'], partialCredit: true }, 'I like bananas.').score).toBe(2);
    expect(g('sentence', { mode: 'keywords', keywords: ['thank you'] }, 'Thank you very much').isCorrect).toBe(true);
    expect(g('sentence', { mode: 'manual' }, 'anything')).toEqual({ score: 0, isCorrect: null, status: 'pending' });
    expect(g('sentence', { mode: 'exact', accepted: ['Yes'], reviewIfIncorrect: true }, 'Yeah').status).toBe('pending');
  });
  it('철자 배열: 섞인 카드 번호를 원래 순서로 되돌려 채점', () => {
    const c = choices('a', 'p', 'p', 'l', 'e');
    // 화면에는 perm 순서로 보임: shown 0 → 원래 4('e'), shown 1 → 0('a') ...
    const perm = [4, 0, 3, 1, 2];
    expect(arrangeToText('1,3,4,2,0', c, perm)).toBe('apple');
    expect(g('arrange', {}, '1,3,4,2,0', c, perm).isCorrect).toBe(true);
    expect(g('arrange', {}, '0,1,2,3,4', c, perm).isCorrect).toBe(false);
    expect(g('arrange', { joiner: ' ' }, '1,0', choices('I', 'am'), [1, 0]).isCorrect).toBe(true);
    expect(g('arrange', {}, '9,9', c, perm).score).toBe(0);
  });
  it('정규화', () => {
    expect(normalizeText('  Hello   World ', {})).toBe('hello world');
    expect(normalizeText('Hello!', { ignorePunctuation: true })).toBe('hello');
  });
});
