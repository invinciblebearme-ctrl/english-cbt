import { fail, json, SECURITY_HEADERS, type Ctx } from './http';
import { hmac, safeEqual, uid } from './crypto';
import { appSecret, audit, now } from './db';
import { resolveAdmin } from './auth';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 15 * 1024 * 1024;

type Kind = 'image' | 'audio';

/** 파일 앞부분(매직 넘버)으로 실제 형식을 판별합니다. 확장자·Content-Type은 믿지 않습니다. */
export function sniffMedia(b: Uint8Array): { kind: Kind; mime: string } | null {
  const at = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x);
  const ascii = (i: number, s: string) => at(i, ...Array.from(s, (c) => c.charCodeAt(0)));
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { kind: 'image', mime: 'image/png' };
  if (at(0, 0xff, 0xd8, 0xff)) return { kind: 'image', mime: 'image/jpeg' };
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return { kind: 'image', mime: 'image/gif' };
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return { kind: 'image', mime: 'image/webp' };
  if (ascii(0, 'RIFF') && ascii(8, 'WAVE')) return { kind: 'audio', mime: 'audio/wav' };
  if (ascii(0, 'ID3')) return { kind: 'audio', mime: 'audio/mpeg' };
  // MPEG 오디오 프레임 동기 비트 (11비트 1) + Layer III
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x06) === 0x02) return { kind: 'audio', mime: 'audio/mpeg' };
  return null;
}

export async function uploadMedia(ctx: Ctx) {
  const len = Number(ctx.req.headers.get('content-length') || 0);
  if (len > MAX_AUDIO_BYTES + 64 * 1024) fail(413, '파일이 너무 큽니다. (그림 5MB, 음성 15MB 이하)');
  let form: FormData;
  try {
    form = await ctx.req.formData();
  } catch {
    return fail(400, '업로드 형식이 올바르지 않습니다.');
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') fail(400, '파일을 선택하세요.');
  const f = file as File;
  const expect = form.get('kind');
  const bytes = new Uint8Array(await f.arrayBuffer());
  const info = sniffMedia(bytes.subarray(0, 16));
  if (!info) fail(415, 'PNG·JPG·GIF·WEBP 그림 또는 MP3·WAV 음성만 올릴 수 있습니다.');
  if (expect && expect !== info!.kind) fail(415, expect === 'image' ? '그림 파일을 선택하세요.' : '음성(MP3/WAV) 파일을 선택하세요.');
  const max = info!.kind === 'image' ? MAX_IMAGE_BYTES : MAX_AUDIO_BYTES;
  if (bytes.length === 0) fail(400, '빈 파일입니다.');
  if (bytes.length > max) fail(413, info!.kind === 'image' ? '그림은 5MB 이하만 올릴 수 있습니다.' : '음성은 15MB 이하만 올릴 수 있습니다.');

  const id = uid();
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'audio/wav': 'wav', 'audio/mpeg': 'mp3' }[info!.mime];
  const key = `${info!.kind}/${id}.${ext}`;
  const name = (f.name || '').replace(/[\u0000-\u001f<>"'`\\]/g, '').slice(0, 200);
  await ctx.env.MEDIA.put(key, bytes, { httpMetadata: { contentType: info!.mime } });
  await ctx.env.DB.prepare('INSERT INTO media(id,r2_key,kind,mime,original_name,size,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .bind(id, key, info!.kind, info!.mime, name, bytes.length, ctx.admin!.id, now())
    .run();
  await audit(ctx, 'media.upload', 'media', id, { kind: info!.kind, size: bytes.length });
  return json({ id, kind: info!.kind, mime: info!.mime, name, size: bytes.length, url: `/api/media/${id}` }, 201);
}

/** 응시자용 미디어 서명 URL (해당 응시·만료 시각에 묶임) */
export async function signedMediaUrl(ctx: Ctx, mediaId: string, attemptId: string, exp: number) {
  const sig = await hmac(appSecret(ctx.env), `media:${mediaId}:${attemptId}:${exp}`);
  return `/api/media/${mediaId}?a=${encodeURIComponent(attemptId)}&e=${exp}&s=${sig}`;
}

export async function serveMedia(ctx: Ctx) {
  const id = ctx.params.id;
  const a = ctx.url.searchParams.get('a');
  const e = Number(ctx.url.searchParams.get('e'));
  const s = ctx.url.searchParams.get('s') || '';
  let allowed = false;
  if (a && e && s) {
    if (e < now()) fail(403, '재생 시간이 만료되었습니다. 다시 시도하세요.');
    const expect = await hmac(appSecret(ctx.env), `media:${id}:${a}:${e}`);
    if (!safeEqual(expect, s)) fail(403, '접근 권한이 없습니다.');
    const att = await ctx.env.DB.prepare("SELECT status FROM attempts WHERE id=? AND archived=0").bind(a).first<{ status: string }>();
    if (!att) fail(403, '접근 권한이 없습니다.');
    allowed = true;
  } else {
    allowed = !!(await resolveAdmin(ctx));
  }
  if (!allowed) fail(403, '접근 권한이 없습니다.');

  const row = await ctx.env.DB.prepare('SELECT r2_key, mime, size FROM media WHERE id=?').bind(id).first<{ r2_key: string; mime: string; size: number }>();
  if (!row) fail(404, '파일을 찾을 수 없습니다.');

  const headers: Record<string, string> = {
    ...SECURITY_HEADERS,
    'content-type': row!.mime,
    'cache-control': 'private, no-store',
    'accept-ranges': 'bytes',
    'content-security-policy': "default-src 'none'; sandbox",
  };
  const range = parseRange(ctx.req.headers.get('range'));
  if (range) {
    const obj = await ctx.env.MEDIA.get(row!.r2_key, { range });
    if (!obj) fail(404, '파일을 찾을 수 없습니다.');
    const total = obj!.size;
    const offset = 'offset' in range ? (range.offset ?? 0) : 0;
    const len = 'length' in range ? range.length : undefined;
    const start = 'suffix' in range ? Math.max(0, total - range.suffix) : offset;
    const end = 'suffix' in range ? total - 1 : len !== undefined ? Math.min(total - 1, offset + len - 1) : total - 1;
    return new Response((obj as R2ObjectBody).body, {
      status: 206,
      headers: { ...headers, 'content-range': `bytes ${start}-${end}/${total}`, 'content-length': String(end - start + 1) },
    });
  }
  const obj = await ctx.env.MEDIA.get(row!.r2_key);
  if (!obj) fail(404, '파일을 찾을 수 없습니다.');
  return new Response(obj!.body, { headers: { ...headers, 'content-length': String(obj!.size) } });
}

function parseRange(h: string | null): R2Range | null {
  const m = h && /^bytes=(\d*)-(\d*)$/.exec(h.trim());
  if (!m || (!m[1] && !m[2])) return null;
  if (!m[1]) return { suffix: Number(m[2]) };
  const offset = Number(m[1]);
  return m[2] ? { offset, length: Number(m[2]) - offset + 1 } : { offset };
}
