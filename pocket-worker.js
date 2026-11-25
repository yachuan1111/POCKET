// POCKET 定时消息 · Cloudflare Worker
// 部署：1) 新建 Worker 并粘贴本脚本  2) 创建 KV 命名空间，绑定变量名 KV
//       3) 设置环境变量 SECRET（访问令牌）  4) 触发器里添加 Cron：* * * * *
// 然后把 Worker 地址和 SECRET 填进 App「备份 → 服务器与推送设置」。
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS'
};
const J = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS) });
const kget = async (env, k, d) => { const v = await env.KV.get(k); return v ? JSON.parse(v) : d; };
const kput = (env, k, v) => env.KV.put(k, JSON.stringify(v));

async function sendPush(ch, title, body) {
  const c = ch || {};
  if (c.type === 'ntfy' && c.a) {
    const base = (c.b || 'https://ntfy.sh').replace(/\/+$/, '');
    await fetch(base, { method: 'POST', body: JSON.stringify({ topic: c.a, title: title, message: body }) });
  } else if (c.type === 'bark' && c.a) {
    const base = (c.b || 'https://api.day.app').replace(/\/+$/, '');
    await fetch(base + '/push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_key: c.a, title: title, body: body }) });
  } else if (c.type === 'hook' && c.a) {
    await fetch(c.a, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: title, body: body }) });
  }
}

async function tick(env) {
  const now = Date.now();
  const jobs = await kget(env, 'jobs', []);
  const cfg = await kget(env, 'cfg', {});
  let inbox = await kget(env, 'inbox', []);
  let dirty = false;
  for (const j of jobs) {
    if (!j.on || j.done || j.at > now) continue;
    const texts = j.texts && j.texts.length ? j.texts : ['…'];
    const t = texts[(j.n || 0) % texts.length];
    inbox.push({ id: j.id + '_' + j.at, jid: j.id, fid: j.fid, t: t, ts: now });
    try { await sendPush(cfg.ch, j.name || 'POCKET', t); } catch (e) {}
    j.n = (j.n || 0) + 1;
    if (j.rep === 'daily') { while (j.at <= now) j.at += 864e5; }
    else if (j.rep === 'weekly') { while (j.at <= now) j.at += 6048e5; }
    else j.done = 1;
    dirty = true;
  }
  if (dirty) {
    inbox = inbox.filter(m => now - m.ts < 6048e5).slice(-300);
    await kput(env, 'jobs', jobs);
    await kput(env, 'inbox', inbox);
  }
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (!env.SECRET || req.headers.get('Authorization') !== 'Bearer ' + env.SECRET) return J({ error: 'unauthorized' }, 401);
    const p = new URL(req.url).pathname.replace(/\/+$/, '');
    const since = +(new URL(req.url).searchParams.get('since') || 0);
    if (p === '/ping') return J({ ok: 1, now: Date.now() });
    if (p === '/jobs' && req.method === 'PUT') {
      const b = await req.json();
      const old = await kget(env, 'jobs', []);
      const jobs = (b.jobs || []).slice(0, 100).map(j => {
        const o = old.find(x => x.id === String(j.id));
        const same = o && o.at0 === +j.at0;
        return {
          id: String(j.id), fid: String(j.fid), name: String(j.name || ''), rep: j.rep === 'daily' || j.rep === 'weekly' ? j.rep : 'once',
          texts: (j.texts || []).slice(0, 30).map(String), on: j.on ? 1 : 0, at0: +j.at0,
          at: same ? o.at : +j.at0, n: same ? o.n : 0, done: same ? o.done : 0
        };
      });
      await kput(env, 'jobs', jobs);
      if (b.cfg) await kput(env, 'cfg', b.cfg);
      return J({ ok: 1, count: jobs.length });
    }
    if (p === '/inbox') {
      const inbox = await kget(env, 'inbox', []);
      const jobs = await kget(env, 'jobs', []);
      return J({ now: Date.now(), msgs: inbox.filter(m => m.ts > since), jobs: jobs.map(j => ({ id: j.id, at: j.at, done: j.done, n: j.n })) });
    }
    if (p === '/test' && req.method === 'POST') {
      const cfg = await kget(env, 'cfg', {});
      await sendPush(cfg.ch, 'POCKET', '测试推送成功');
      return J({ ok: 1 });
    }
    return J({ error: 'not found' }, 404);
  },
  async scheduled(ev, env, ctx) { ctx.waitUntil(tick(env)); }
};
