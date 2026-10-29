import type { Env } from './env';
import { HttpError, json, Router, type Ctx } from './http';
import { requireAdmin } from './auth';
import { cleanup } from './db';
import { finalizeExpired } from './attempts';
import { serveMedia, uploadMedia } from './media';
import { adminAuthRoutes } from './routes/admin-auth';
import { questionRoutes } from './routes/questions';
import { examRoutes } from './routes/exams';
import { studentRoutes as adminStudentRoutes } from './routes/students';
import { resultRoutes } from './routes/results';
import { studentRoutes } from './routes/student';

const router = new Router();
router.get('/api/health', async (ctx) => ({ ok: true, db: !!ctx.env.DB, media: !!ctx.env.MEDIA, secret: (ctx.env.APP_SECRET?.length ?? 0) >= 32 }));
router.post('/api/admin/media', async (ctx) => {
  await requireAdmin(ctx);
  return uploadMedia(ctx);
});
router.get('/api/media/:id', serveMedia);
adminAuthRoutes(router);
questionRoutes(router);
examRoutes(router);
adminStudentRoutes(router);
resultRoutes(router);
studentRoutes(router);

export async function handleApi(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const ctx: Ctx = {
    req,
    env,
    url,
    params: {},
    ip: req.headers.get('cf-connecting-ip') || 'local',
    headers: new Headers(),
  };
  try {
    const m = router.match(req.method, url.pathname);
    if (!m) return json({ error: '요청한 API를 찾을 수 없습니다.' }, 404);
    if (m === 'method') return json({ error: '허용되지 않은 요청 방식입니다.' }, 405);
    ctx.params = m.params;
    const out = await m.handler(ctx);
    const res = out instanceof Response ? out : json(out);
    ctx.headers.forEach((v, k) => res.headers.append(k, v));
    return res;
  } catch (e) {
    if (e instanceof HttpError) {
      const res = json({ error: e.message, ...e.extra }, e.status);
      ctx.headers.forEach((v, k) => res.headers.append(k, v));
      return res;
    }
    console.error('API error', url.pathname, e);
    return json({ error: '서버에서 요청을 처리하지 못했습니다. 잠시 후 다시 시도하세요.' }, 500);
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) return handleApi(req, env);
    if (env.ASSETS) return env.ASSETS.fetch(req);
    return new Response('Not found', { status: 404 });
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(Promise.all([finalizeExpired(env), cleanup(env)]));
  },
} satisfies ExportedHandler<Env>;
