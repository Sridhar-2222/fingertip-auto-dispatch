import crypto from 'node:crypto';

// Wakes the driver's Android app with a high-priority FCM data message.
// The app (not this server) decides how to ring: full-screen alert + loud
// looping sound on its own notification channel.
// If FCM isn't configured, this logs and does nothing — the app still gets
// the ride through Supabase Realtime while it is open on screen.
export function createPush(serviceAccountJson, fetchImpl = fetch, log = console) {
  if (!serviceAccountJson) {
    return { send: async (tokens, data) => log.info?.(`[push disabled] ${data.kind} → ${tokens.length} driver(s)`) };
  }
  const sa = JSON.parse(serviceAccountJson);
  let cached = { token: null, exp: 0 };

  async function accessToken() {
    const now = Math.floor(Date.now() / 1000);
    if (cached.token && cached.exp - 60 > now) return cached.token;
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
      iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
    })}`;
    const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');
    const res = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`FCM auth failed: ${JSON.stringify(body)}`);
    cached = { token: body.access_token, exp: now + body.expires_in };
    return cached.token;
  }

  return {
    // data values must be strings
    async send(tokens, data) {
      if (!tokens.length) return;
      const bearer = await accessToken();
      const stringData = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v ?? '')]));
      await Promise.allSettled(tokens.map(async (t) => {
        const res = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: { token: t, data: stringData, android: { priority: 'HIGH', ttl: '30s' } } }),
        });
        if (!res.ok) log.warn?.(`FCM send failed ${res.status}`);
      }));
    },
  };
}
