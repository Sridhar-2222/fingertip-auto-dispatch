// LOCAL TESTING ONLY. Drives the real app (www/) as TWO phones in headless Chromium:
// a passenger at Karimnagar bus stand and an auto driver 1 km north.
// The database functions are replaced by a small in-memory stand-in (same names and
// answers as supabase/migrations/20261125180000_app_device_keys.sql). Voice and phone
// plugins are fakes that record what was spoken and return scripted speech.
// Usage: node test/app.test.mjs   (needs the playwright package; Chromium is pre-installed)
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');
const WWW = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'www');
const URL_BASE = 'https://test.supabase.local';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) failed++; };

// ---------------- in-memory stand-in for the auto_* database functions ----------------
const db = {
  drivers: [{ id: 'd1', name: 'Ramesh', name_te: 'రమేష్', phone: '919000000011', auto_number: 'TS02T0011', status: 'OFFLINE', lat: null, lng: null, pair_code: '111111', pair_fails: 0 }],
  passengers: [{ id: 'p1', name: 'Lakshmi', phone: '919000000022', pair_code: '222222', pair_fails: 0 }],
  devices: {}, rides: [], pings: [],
};
const dist = (a, b) => { const R = 6371, r = Math.PI / 180, x = (b.lng - a.lng) * r * Math.cos((a.lat + b.lat) * r / 2), y = (b.lat - a.lat) * r; return Math.hypot(x, y) * R; };
const dev = (k) => db.devices[k];
const fns = {
  auto_pair({ p_role, p_phone, p_code }) {
    const ph = '91' + p_phone.replace(/\D/g, '').slice(-10);
    const list = p_role === 'driver' ? db.drivers : db.passengers;
    const x = list.find((r) => r.phone === ph);
    if (!x) return { ok: false, reason: 'unknown_phone' };
    if (x.pair_fails >= 5) return { ok: false, reason: 'locked' };
    if (x.pair_code !== p_code) { x.pair_fails++; return { ok: false, reason: 'wrong_code' }; }
    const key = 'k'.repeat(20) + Math.random().toString(16).slice(2).padEnd(44, '0');
    db.devices[key] = { role: p_role, id: x.id }; x.pair_code = null;
    return { ok: true, key, role: p_role, name: x.name };
  },
  auto_driver_me({ p_key }) { const d = dev(p_key); if (d?.role !== 'driver') return { ok: false, reason: 'not_paired' }; const x = db.drivers.find((r) => r.id === d.id); return { ok: true, ...x }; },
  auto_driver_duty({ p_key, p_on }) { const x = db.drivers.find((r) => r.id === dev(p_key).id); if (x.status !== 'BUSY') x.status = p_on ? 'AVAILABLE' : 'OFFLINE'; return { ok: true, status: x.status }; },
  auto_driver_beat({ p_key, p_lat, p_lng }) { const x = db.drivers.find((r) => r.id === dev(p_key).id); x.lat = p_lat; x.lng = p_lng; return { ok: true }; },
  auto_driver_poll({ p_key }) {
    const d = dev(p_key); if (d?.role !== 'driver') return { ok: false, reason: 'not_paired' };
    const x = db.drivers.find((r) => r.id === d.id);
    const p = db.pings.find((q) => q.driver_id === x.id && q.status === 'SENT' && q.expires > Date.now());
    const r = db.rides.find((q) => q.driver_id === x.id && q.status === 'CONFIRMED');
    return { ok: true, status: x.status,
      alert: p ? { ride_id: p.ride_id, distance_km: p.km, destination_name: db.rides.find((q) => q.id === p.ride_id).dest, expires_at: new Date(p.expires).toISOString() } : null,
      ride: r ? { ride_id: r.id, ride_code: r.code, passenger_phone: r.phone, destination_name: r.dest, pickup_lat: r.lat, pickup_lng: r.lng } : null };
  },
  auto_driver_accept({ p_key, p_ride_id }) {
    const x = db.drivers.find((r) => r.id === dev(p_key).id); const r = db.rides.find((q) => q.id === p_ride_id);
    if (r.status !== 'SEARCHING') return { ok: false, reason: 'taken' };
    r.status = 'CONFIRMED'; r.driver_id = x.id; x.status = 'BUSY';
    db.pings.forEach((p) => { if (p.ride_id === r.id) p.status = p.driver_id === x.id ? 'ACCEPTED' : 'TAKEN'; });
    return { ok: true, ride_id: r.id, ride_code: r.code, passenger_phone: r.phone, destination_name: r.dest, pickup_lat: r.lat, pickup_lng: r.lng };
  },
  auto_driver_skip({ p_key, p_ride_id }) { db.pings.forEach((p) => { if (p.ride_id === p_ride_id && p.driver_id === dev(p_key).id) p.status = 'DECLINED'; }); return { ok: true }; },
  auto_driver_done({ p_key, p_ride_id }) { const r = db.rides.find((q) => q.id === p_ride_id); r.status = 'COMPLETED'; r.closed = Date.now(); db.drivers.find((x) => x.id === dev(p_key).id).status = 'AVAILABLE'; return { ok: true }; },
  auto_passenger_me({ p_key }) { const d = dev(p_key); if (d?.role !== 'passenger') return { ok: false, reason: 'not_paired' }; return { ok: true, ...db.passengers.find((r) => r.id === d.id) }; },
  auto_book({ p_key, p_lat, p_lng, p_said, p_place }) {
    const pa = db.passengers.find((r) => r.id === dev(p_key).id);
    if (db.rides.some((r) => r.pid === pa.id && ['SEARCHING', 'CONFIRMED'].includes(r.status))) return { ok: false, reason: 'already_booked' };
    const r = { id: 'r' + (db.rides.length + 1), code: '4821', pid: pa.id, phone: pa.phone, dest: p_place || p_said, lat: p_lat, lng: p_lng, status: 'SEARCHING', expires: Date.now() + 30000, said: p_said };
    db.rides.push(r);
    for (const x of db.drivers) {
      if (x.status !== 'AVAILABLE' || x.lat == null) continue;
      const km = dist({ lat: p_lat, lng: p_lng }, x);
      if (km <= 3) db.pings.push({ ride_id: r.id, driver_id: x.id, km: Math.round(km * 100) / 100, status: 'SENT', expires: r.expires });
    }
    const n = db.pings.filter((p) => p.ride_id === r.id).length;
    if (!n) { r.status = 'NO_AUTO'; r.closed = Date.now(); }
    return { ok: true, ride_id: r.id, drivers_alerted: n };
  },
  auto_passenger_poll({ p_key }) {
    const d = dev(p_key); const r = [...db.rides].reverse().find((q) => q.pid === d.id);
    if (!r) return { ok: true, ride: null };
    const x = db.drivers.find((y) => y.id === r.driver_id);
    return { ok: true, ride: { ride_id: r.id, ride_code: r.code, status: r.status, destination_name: r.dest, expires_at: new Date(r.expires).toISOString(),
      closed_at: r.closed ? new Date(r.closed).toISOString() : null, drivers_alerted: db.pings.filter((p) => p.ride_id === r.id).length,
      driver: r.status === 'CONFIRMED' ? { name: x.name, name_te: x.name_te, auto_number: x.auto_number, phone: x.phone, lat: x.lat, lng: x.lng, distance_km: Math.round(dist(r, x) * 100) / 100 } : null } };
  },
  auto_passenger_cancel({ p_key }) { const r = db.rides.find((q) => q.pid === dev(p_key).id && ['SEARCHING', 'CONFIRMED'].includes(q.status)); if (!r) return { ok: false }; r.status = 'CANCELLED'; r.closed = Date.now(); const x = db.drivers.find((y) => y.id === r.driver_id); if (x) x.status = 'AVAILABLE'; return { ok: true }; },
};

// ---------------- fake phone plugins (voice is scripted per phone) ----------------
const plugins = (hear) => `
window.__said = []; window.__heard = ${JSON.stringify(hear)}; window.__opened = [];
window.Capacitor = { Plugins: {
  TextToSpeech: { async isLanguageSupported() { return { supported: true }; }, async speak(o) { __said.push(o.text); await new Promise(r => setTimeout(r, 30)); }, async stop() {} },
  SpeechRecognition: { async available() { return { available: true }; }, async checkPermissions() { return { speechRecognition: 'granted' }; },
    async requestPermissions() { return { speechRecognition: 'granted' }; },
    async start() { await new Promise(r => setTimeout(r, 1500)); return { matches: [__heard.shift() || ''] }; }, async stop() {} },
  BackgroundGeolocation: { async addWatcher(o, cb) { setTimeout(() => cb({ latitude: 18.4438, longitude: 79.1325 }), 50); return 'w1'; }, async removeWatcher() {}, async openSettings() {} },
  LocalNotifications: { async createChannel() {}, async requestPermissions() { return {}; }, async schedule() {}, addListener() {} },
  KeepAwake: { async keepAwake() {}, async allowSleep() {} } } };
HTMLAnchorElement.prototype.click = function () { __opened.push(this.href); };
window.confirm = () => true;`;

const browser = await chromium.launch();
async function phone(name, hear, geo) {
  const ctx = await browser.newContext({ geolocation: geo, permissions: ['geolocation'], viewport: { width: 390, height: 800 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route(URL_BASE + '/rest/v1/rpc/*', async (route) => {
    const fn = route.request().url().split('/').pop();
    const body = JSON.parse(route.request().postData() || '{}');
    const out = fns[fn] ? fns[fn](body) : { ok: false, reason: 'no_fn' };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
  });
  await page.route('**/config.js', (route) => route.fulfill({ contentType: 'text/javascript',
    body: `window.FINGERTIP_CONFIG = { SUPABASE_URL: '${URL_BASE}', SUPABASE_ANON_KEY: 'sb_publishable_test' };` }));
  await page.addInitScript(plugins(hear));
  await page.goto('file://' + WWW + '/index.html');
  page.errors = errors; page.who = name;
  return page;
}
const said = (p) => p.evaluate(() => window.__said.join(' || '));

// Passenger at Karimnagar bus stand; driver 1 km north (driver GPS comes from the fake plugin)
const pas = await phone('passenger', ['కమాన్ కి వెళ్ళాలి'], { latitude: 18.4348, longitude: 79.1325 });
const drv = await phone('driver', ['సరే'], { latitude: 18.4438, longitude: 79.1325 });

// --- pairing ---
ok(await pas.locator('#s-role.on').isVisible(), 'first open shows Passenger / Driver choice');
await drv.click('[data-role=driver]');
await drv.fill('#pPhone', '9000000011'); await drv.fill('#pCode', '000000'); await drv.click('#pBtn');
await drv.waitForTimeout(200);
ok((await drv.textContent('#pErr')).includes('Wrong code'), 'wrong code is refused');
await drv.fill('#pCode', '111111'); await drv.click('#pBtn');
await drv.waitForSelector('#s-main.on');
ok((await drv.textContent('#hName')).includes('రమేష్'), 'driver paired, name shown');

await pas.click('[data-role=passenger]');
await pas.fill('#pPhone', '9000000022'); await pas.fill('#pCode', '222222'); await pas.click('#pBtn');
await pas.waitForSelector('#s-pass.on');
ok((await pas.textContent('#hName')).includes('Lakshmi'), 'passenger paired, name shown');
ok(await pas.evaluate(() => !!localStorage.getItem('rxf-auto-device')), 'device key kept on the phone');

// --- driver goes on duty ---
await drv.click('#duty');
await drv.waitForTimeout(400);
ok((await drv.textContent('#duty')).includes('ON DUTY'), 'driver on duty');
ok(db.drivers[0].lat === 18.4438, 'driver GPS sent (1 km north of passenger)');
ok((await said(drv)).includes('డ్యూటీ ప్రారంభమైంది'), 'driver hears "on duty" in Telugu');

// --- passenger speaks the destination ---
await pas.click('#pMic');
await pas.waitForSelector('#pSaidBox:not([hidden])');
ok((await pas.textContent('#pSaid')).includes('Kaman'), 'spoken "కమాన్ కి వెళ్ళాలి" matched to Kaman');
ok((await said(pas)).includes('ఎక్కడికి వెళ్ళాలి'), 'passenger asked "where to" aloud');
await pas.click('#pGo');
await pas.waitForSelector('text=Finding an auto');
ok(db.pings.length === 1 && db.pings[0].km > 0.9 && db.pings[0].km < 1.1, 'booking alerted the driver 1 km away');

// --- driver gets the alert, hears it, says "సరే" ---
await drv.waitForSelector('#alert.on', { timeout: 6000 });
ok((await drv.textContent('#aKm')).includes('1.0'), 'driver alert shows 1.0 km');
ok((await drv.textContent('#aDest')).includes('కమాన్'), 'driver alert shows destination in Telugu');
await drv.waitForFunction(() => !document.getElementById('alert').classList.contains('on'), null, { timeout: 8000 });
const dSaid = await said(drv);
ok(dSaid.includes('కొత్త రైడ్') && dSaid.includes('సరే అనండి'), 'driver heard the ride read aloud');
ok(db.rides[0].status === 'CONFIRMED', 'voice "సరే" accepted the ride');
await drv.waitForTimeout(300);
ok((await drv.evaluate(() => __opened.join())).includes('google.com/maps/dir'), 'map route opened after accepting');
ok((await said(drv)).includes('రైడ్ మీది'), 'driver heard "ride is yours" + destination');
ok((await drv.textContent('#rPhone')).includes('919000000022'), 'driver sees passenger phone');

// --- passenger sees and hears the driver ---
await pas.waitForSelector('text=Auto is coming', { timeout: 6000 });
ok((await pas.textContent('#pRide')).includes('TS02T0011'), 'passenger sees auto number');
ok((await said(pas)).includes('ఆటో దొరికింది'), 'passenger hears "auto found"');

// --- trip done ---
await drv.click('#rDone');
await pas.waitForSelector('text=Trip done', { timeout: 6000 });
ok(db.drivers[0].status === 'AVAILABLE', 'driver free again after trip');

// --- second ride: driver says "వద్దు" → skipped, passenger told no auto after the window ---
await pas.click('#pOk');
await drv.evaluate(() => { __heard.push('వద్దు'); });
await pas.evaluate(() => { __heard.push('బస్ స్టాండ్'); });
await pas.click('#pMic'); await pas.waitForSelector('#pSaidBox:not([hidden])');
ok((await pas.textContent('#pSaid')).includes('Bus Stand'), 'second destination matched (Bus Stand)');
await pas.click('#pGo');
await drv.waitForSelector('#alert.on', { timeout: 6000 });
await drv.waitForFunction(() => !document.getElementById('alert').classList.contains('on'), null, { timeout: 8000 });
ok(db.pings.find((p) => p.ride_id === 'r2').status === 'DECLINED', 'voice "వద్దు" skipped the ride');
db.rides[1].status = 'NO_AUTO'; db.rides[1].closed = Date.now();   // the 5-second timer's job in the real database
await pas.waitForSelector('text=No auto found', { timeout: 6000 });
ok((await said(pas)).includes('ఆటో దొరకలేదు'), 'passenger hears "no auto"');

for (const p of [pas, drv]) ok(p.errors.length === 0, `${p.who}: no page errors ${p.errors.join('; ')}`);
await pas.screenshot({ path: '/tmp/claude-0/-home-user/4b14ac94-30f8-537c-b795-b94c25bc5146/scratchpad/passenger.png' });
await browser.close();
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
