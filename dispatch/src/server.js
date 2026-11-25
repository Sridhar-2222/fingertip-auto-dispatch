import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { createWhatsApp } from './whatsapp.js';
import { createSarvam } from './sarvam.js';
import { createPush } from './push.js';
import { createExotel } from './exotel.js';
import { createDispatcher } from './dispatch.js';
import { createApp, createDriverVerifier } from './app.js';

const cfg = loadConfig();
const db = createDb(cfg.databaseUrl);
const wa = createWhatsApp(cfg.whatsapp);
const dispatcher = createDispatcher({
  db, wa,
  stt: createSarvam(cfg.sarvam),
  push: createPush(cfg.fcmServiceAccountJson),
  exotel: createExotel(cfg.exotel),
  audio: cfg.audio,
  publicBaseUrl: cfg.publicBaseUrl,
});

const app = createApp({
  dispatcher, wa, db,
  verifyToken: cfg.whatsapp.verifyToken,
  verifyDriver: createDriverVerifier({ supabaseUrl: cfg.supabaseUrl, supabaseAnonKey: cfg.supabaseAnonKey, db }),
});

// Workers: close timed-out searches every 2 s; fallback calls every 5 s.
// Each tick is safe to run on several servers at once (SKIP LOCKED / claim).
function every(ms, fn, name) {
  let running = false;
  return setInterval(async () => {
    if (running) return;
    running = true;
    try { await fn(); } catch (e) { console.error(`${name}: ${e.message}`); } finally { running = false; }
  }, ms);
}
const timers = [every(2000, dispatcher.expireTick, 'expire'), every(5000, dispatcher.fallbackTick, 'fallback')];

const server = app.listen(cfg.port, () => console.log(`Fingertip dispatch listening on :${cfg.port}`));

function shutdown() {
  timers.forEach(clearInterval);
  server.close(() => db.end().then(() => process.exit(0)));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
