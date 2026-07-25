// POST /send-push
// body: { subscriptions: [{endpoint, keys:{p256dh,auth}}, ...], title, body }
// This is the ONLY server-side piece this app needs. It never touches JSONBin or
// knows about users/trust levels — the browser already resolved which subscriptions
// to target and just hands them over here to be delivered. That keeps the VAPID
// private key (the one genuinely secret value) isolated to this one file.
//
// Requires, in the Cloudflare Pages project settings:
//   - Compatibility flag: nodejs_compat
//   - Environment variables (set as "Secret" for VAPID_PRIVATE_KEY):
//       VAPID_PUBLIC_KEY  = (the public key from `npx web-push generate-vapid-keys`)
//       VAPID_PRIVATE_KEY = (the private key — keep this secret)
//       VAPID_SUBJECT     = mailto:you@example.com  (or your site's https:// URL)
// Requires, in package.json at the project root: "web-push" as a dependency.

import webpush from 'web-push';

export async function onRequestPost({ request, env }) {
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
