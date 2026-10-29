// 1차 스키마(0001)의 데이터가 2차 스키마로 옮겨지는지 확인
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../worker/src/env';
import { applyMigrations, createTestEnv } from './helpers';

let env: Env;
let dispose: () => Promise<void>;

beforeAll(async () => {
  ({ env, dispose } = await createTestEnv({ migrate: false }));
  await applyMigrations(env.DB, ['0001_init.sql']);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO media(id,key,mime,name) VALUES('m1','m1/a.png','image/png','a.png')"),
    env.DB.prepare("INSERT INTO media(id,key,mime,name) VALUES('m2','m2/a.mp3','audio/mpeg','a.mp3')"),
    env.DB.prepare(
      `INSERT INTO questions(id,grade,unit,domain,type,prompt,choices,answer,points,media,ready) VALUES
       ('q1',4,9,'듣기','multiple','Listen','["red","blue"]','2',5,'{"image":"/api/media/m1","audio":"/api/media/m2"}',1),
       ('q2',4,9,'읽기','ox','True?','[]','1',5,'{}',1),
       ('q3',4,9,'쓰기','short','Write','[]','apple',5,'{}',0),
       ('q4',4,9,'기타','image','Pick','["/api/media/m1","/api/media/m1"]','1',5,'{}',0)`,
    ),
    env.DB.prepare("INSERT INTO students(id,grade,class_no,student_no,name) VALUES('s1',4,1,1,'김하나'),('s2',4,1,2,'이둘'),('s3',4,2,1,'박셋')"),
  ]);
  await applyMigrations(env.DB, ['0002_full_schema.sql']);
});
afterAll(async () => dispose?.());

describe('0002 마이그레이션', () => {
  it('기존 테이블은 legacy_* 로 보존', async () => {
    const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM legacy_questions").first<{ n: number }>();
    expect(r?.n).toBe(4);
  });
  it('문제·선택지·미디어 이전 (모두 임시 저장 상태)', async () => {
    const q = await env.DB.prepare('SELECT * FROM questions ORDER BY id').all<any>();
    expect(q.results.map((x) => x.type)).toEqual(['mc_text', 'ox', 'short', 'mc_image']);
    expect(q.results.every((x) => x.status === 'draft')).toBe(true);
    expect(q.results[0].image_media_id).toBe('m1');
    expect(q.results[0].audio_media_id).toBe('m2');
    expect(JSON.parse(q.results[0].answer)).toEqual({ choices: [2] });
    expect(JSON.parse(q.results[1].answer)).toEqual({ value: 'O' });
    expect(JSON.parse(q.results[2].answer)).toEqual({ accepted: ['apple'], caseSensitive: false });
    expect(q.results[3].domain).toBe('듣기');
    const c = await env.DB.prepare("SELECT * FROM question_choices WHERE question_id='q4' ORDER BY seq").all<any>();
    expect(c.results.map((x) => x.media_id)).toEqual(['m1', 'm1']);
    const c1 = await env.DB.prepare("SELECT text FROM question_choices WHERE question_id='q1' ORDER BY seq").all<any>();
    expect(c1.results.map((x) => x.text)).toEqual(['red', 'blue']);
  });
  it('학생과 학급 이전', async () => {
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM classes').first<any>()).n).toBe(2);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM students').first<any>()).n).toBe(3);
  });
});
