import webpush from 'web-push';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/send-push') {
      return handleSendPush(request, env);
    }

    if (url.pathname.startsWith('/api/kv/')) {
      const key = decodeURIComponent(url.pathname.slice('/api/kv/'.length));
      if (!key) return new Response(JSON.stringify({ error: 'Missing key' }), { status: 400 });
      return handleKV(request, env, key);
    }

    // One-time migration from JSONBin into KV. Safe to leave deployed — it's
    // idempotent (just re-copies the same data) — but once you've confirmed
    // the app is fully working off KV, feel free to delete this whole route
    // and the runMigration() function below.
    if (request.method === 'POST' && url.pathname === '/api/migrate-from-jsonbin') {
      return runMigration(env);
    }

    // Everything else (index.html, sw.js, manifest.json, icons) is served as a
    // plain static file straight from the assets binding.
    return env.ASSETS.fetch(request);
  },
};

// ─── KV DATA API ────────────────────────────────────────────────────────────
// Simple JSON-blob-by-key store, mirroring the shape the app previously used
// against JSONBin's per-bin GET/PUT so the client only needed its internal
// jbGet/jbSet/jbCreate helpers rewritten, nothing else.
async function handleKV(request, env, key) {
  if (!env.APP_KV) {
    return new Response(JSON.stringify({ error: 'KV namespace not bound. Add an APP_KV binding in wrangler.jsonc.' }), { status: 500 });
  }
  if (request.method === 'GET') {
    const value = await env.APP_KV.get(key);
    if (value === null) {
      return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
    }
    return new Response(value, { headers: { 'Content-Type': 'application/json' } });
  }
  if (request.method === 'PUT') {
    let text;
    try {
      text = await request.text();
      JSON.parse(text); // validate it's actually JSON before storing
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400 });
    }
    await env.APP_KV.put(key, text);
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  }
  if (request.method === 'DELETE') {
    await env.APP_KV.delete(key);
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  }
  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
}

// ─── ONE-TIME JSONBIN → KV MIGRATION ───────────────────────────────────────
// Reuses the exact same bin-id strings as KV keys, so nothing else in the app
// needs to change once jbGet/jbSet/jbCreate point at /api/kv/ instead of
// JSONBin's API — every existing reference to a "bin id" still resolves.
const JSONBIN_BASE   = 'https://api.jsonbin.io/v3/b';
const BUILTIN_MASTER = '$2a$10$6YBkVxzejBooontWHndzWeZZkgYgKnaK8vwxju.4q6wewIrOOrsY.';
const BUILTIN_ACCESS = '$2a$10$PDs46AiwGkqgyXEuEBF/vefvg5FeUoD1oMQkhRn23Kj1LViInj.Tu';
const BUILTIN_TRIPS  = '6a405994f5f4af5e293ac4f3';
const BUILTIN_PHOTOS = '6a405994da38895dfe09386e';
const USERS_MASTER   = '$2a$10$TyfnoNZx363q.aJ20AuDE.BH5BiPzBCgFZn89qXiG2/1kg/Oi2hNy';
const USERS_ACCESS   = '$2a$10$BRz.waSciF.U9V02VsNNQuUFf/qeAwYz5qFo2BqPy5gWlGCtIwy6m';
const BUILTIN_USERS_BIN = '6a430f75f5f4af5e2944a8bf';

function isBinId(s) { return typeof s === 'string' && /^[a-f0-9]{24}$/i.test(s); }

async function jsonbinGet(binId, master, access) {
  const r = await fetch(JSONBIN_BASE + '/' + binId + '/latest', {
    headers: { 'X-Master-Key': master, 'X-Access-Key': access },
  });
  if (!r.ok) throw new Error('GET ' + binId + ' -> ' + r.status);
  return (await r.json()).record;
}

async function runMigration(env) {
  if (!env.APP_KV) {
    return new Response(JSON.stringify({ error: 'KV namespace not bound. Add an APP_KV binding in wrangler.jsonc.' }), { status: 500 });
  }
  const log = [];
  const copy = async (key, master, access, label) => {
    try {
      const data = await jsonbinGet(key, master, access);
      await env.APP_KV.put(key, JSON.stringify(data));
      log.push({ key, label, ok: true });
      return data;
    } catch (e) {
      log.push({ key, label, ok: false, error: e.message });
      return null;
    }
  };

  // Core bins.
  const trips  = await copy(BUILTIN_TRIPS, BUILTIN_MASTER, BUILTIN_ACCESS, 'trips');
  await copy(BUILTIN_USERS_BIN, USERS_MASTER, USERS_ACCESS, 'users');
  const photosIdx = await copy(BUILTIN_PHOTOS, BUILTIN_MASTER, BUILTIN_ACCESS, 'photos-index');

  // Dynamic bins recorded inside the trips record (only exist once someone
  // first used that feature — skip cleanly if absent).
  if (trips && trips.infoBin && isBinId(trips.infoBin)) {
    await copy(trips.infoBin, BUILTIN_MASTER, BUILTIN_ACCESS, 'info');
  }
  if (trips && trips.pushSubsBin && isBinId(trips.pushSubsBin)) {
    await copy(trips.pushSubsBin, BUILTIN_MASTER, BUILTIN_ACCESS, 'pushsubs');
  }

  // Every individual per-item photo bin referenced from the photo index.
  if (photosIdx && photosIdx.photos) {
    const idx = photosIdx.photos;
    const refs = new Set();
    Object.values(idx).forEach((val) => {
      if (isBinId(val)) refs.add(val);
      else if (Array.isArray(val)) val.forEach((v) => { if (isBinId(v)) refs.add(v); });
    });
    for (const ref of refs) {
      await copy(ref, BUILTIN_MASTER, BUILTIN_ACCESS, 'photo-bin');
    }
  }

  const okCount = log.filter((l) => l.ok).length;
  const failCount = log.filter((l) => !l.ok).length;
  return new Response(JSON.stringify({ summary: `${okCount} copied, ${failCount} failed`, log }, null, 2), {
    headers: { 'Content-Type': 'application/json' },
  });
}

// POST /send-push
// body: { subscriptions: [{endpoint, keys:{p256dh,auth}}, ...], title, body }
// This is the ONLY server-side piece this app needs for push. It never touches
// storage or knows about users/trust levels — the browser already resolved
// which subscriptions to target and just hands them over here to be delivered.
//
// Requires, in the Cloudflare dashboard for this Worker (Settings > Variables and Secrets):
//   VAPID_PUBLIC_KEY  = (the public key from `npx web-push generate-vapid-keys`)
//   VAPID_PRIVATE_KEY = (the private key — add this one as a Secret)
//   VAPID_SUBJECT     = mailto:you@example.com  (or your site's https:// URL)
async function handleSendPush(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400 });
  }

  const { subscriptions, title, body: message } = body || {};
  if (!Array.isArray(subscriptions) || !subscriptions.length) {
    return new Response(JSON.stringify({ error: 'subscriptions[] is required' }), { status: 400 });
  }
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    return new Response(JSON.stringify({ error: 'VAPID keys are not configured on the server' }), { status: 500 });
  }

  webpush.setVapidDetails(
    env.VAPID_SUBJECT || 'mailto:admin@example.com',
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY
  );

  const payload = JSON.stringify({ title: title || 'Equipment Tracker', body: message || '' });

  const results = await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, payload);
        return { endpoint: sub.endpoint, ok: true };
      } catch (err) {
        return { endpoint: sub.endpoint, ok: false, status: err.statusCode || 0, message: err.message };
      }
    })
  );

  return new Response(JSON.stringify({ results }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
