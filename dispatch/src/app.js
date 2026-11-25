import express from 'express';

// HTTP routes. Meta gets a 200 straight away; the work runs after, because
// speech-to-text can take a few seconds and Meta retries slow webhooks.
export function createApp({ dispatcher, wa, db, verifyToken, verifyDriver, log = console }) {
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => res.json({ ok: true }));

  // Meta webhook verification handshake
  app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === verifyToken) {
      return res.status(200).send(req.query['hub.challenge']);
    }
    return res.sendStatus(403);
  });

  app.post('/webhook', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    if (!wa.verifySignature(req.body, req.get('x-hub-signature-256'))) return res.sendStatus(401);
    let payload;
    try { payload = JSON.parse(req.body.toString('utf8')); } catch { return res.sendStatus(400); }
    res.sendStatus(200);
    dispatcher.handleWebhook(payload).catch((e) => log.error?.(`webhook: ${e.message}`));
  });

  // ---- Driver app (Bearer = driver's Supabase login) -------------------
  const driverRoute = (action) => async (req, res) => {
    const driver = await verifyDriver(req.get('authorization')).catch(() => null);
    if (!driver) return res.status(401).json({ ok: false, reason: 'unauthorized' });
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).json({ ok: false, reason: 'bad_id' });
    try {
      res.json(await dispatcher[action](req.params.id, driver));
    } catch (e) {
      log.error?.(`${action}: ${e.message}`);
      res.status(500).json({ ok: false, reason: 'server_error' });
    }
  };
  app.post('/driver/rides/:id/accept', driverRoute('driverAccept'));
  app.post('/driver/rides/:id/decline', driverRoute('driverDecline'));
  app.post('/driver/rides/:id/complete', driverRoute('driverComplete'));

  // ---- Passenger link (long random token, no login) ---------------------
  const tokenOk = (t) => /^[0-9a-f]{32,64}$/.test(t);
  app.get('/api/r/:token', async (req, res) => {
    if (!tokenOk(req.params.token)) return res.sendStatus(404);
    const status = await db.rideStatusByToken(req.params.token);
    return status ? res.json(status) : res.sendStatus(404);
  });
  app.post('/api/r/:token/cancel', async (req, res) => {
    if (!tokenOk(req.params.token)) return res.sendStatus(404);
    res.json(await dispatcher.passengerCancel(req.params.token));
  });

  return app;
}

// Checks a driver app's Supabase access token and maps it to a driver row
export function createDriverVerifier({ supabaseUrl, supabaseAnonKey, db }, fetchImpl = fetch) {
  return async (authHeader) => {
    if (!authHeader?.startsWith('Bearer ') || !supabaseUrl) return null;
    const res = await fetchImpl(`${supabaseUrl}/auth/v1/user`, {
      headers: { Authorization: authHeader, apikey: supabaseAnonKey },
    });
    if (!res.ok) return null;
    const user = await res.json();
    return user?.id ? db.driverByUser(user.id) : null;
  };
}
