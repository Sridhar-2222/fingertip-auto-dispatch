// LOCAL TESTING ONLY. Drives the real driver app (www/) in headless Chrome
// against test/server.ts. Phone plugins (GPS service, notifications,
// keep-awake) are fakes that record calls; Supabase auth/realtime are faked
// in the page, database calls and the Edge Function are real.
// Usage: start test/server.ts, then  node test/app.test.mjs
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const API = 'http://localhost:8787';
const WWW = new URL('../www/', import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (p, body) => (await fetch(API + p, body ? { method: 'POST', body: JSON.stringify(body) } : {})).json();
let failed = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) failed++; };

// Fake Supabase client: real RPCs through the test server, fake auth, no realtime (tests the polling backup)
const FAKE_SUPABASE = `window.supabase = { createClient(url) {
  let uid = localStorage.getItem('uid');
  return {
    auth: {
      async getSession() { return { data: { session: uid ? { access_token: uid } : null } }; },
      async signInAnonymously() { uid = '40000000-0000-0000-0000-0000000000a1'; localStorage.setItem('uid', uid); return { data: {}, error: null }; },
    },
    async rpc(fn, args) {
      const r = await fetch(url + '/rest/v1/rpc/' + fn, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(uid ? { Authorization: 'Bearer ' + uid } : {}) }, body: JSON.stringify(args || {}) });
      const j = await r.json(); return j.error ? { data: null, error: j.error } : { data: j.data, error: null };
    },
    channel() { const c = { on() { return c; }, subscribe() { return c; } }; return c; },
  };
} };`;
const FAKE_PLUGINS = `window.__calls = []; window.Capacitor = { Plugins: {
  BackgroundGeolocation: {
    async addWatcher(opts, cb) { __calls.push(['addWatcher', opts.backgroundTitle]); window.__gps = cb; setTimeout(() => cb({ latitude: 18.4400, longitude: 79.1290 }), 50); return 'w1'; },
    async removeWatcher() { __calls.push(['removeWatcher']); }, async openSettings() {} },
  LocalNotifications: { async createChannel(c) { __calls.push(['channel', c.id, c.importance]); }, async requestPermissions() { __calls.push(['notifPerm']); return { display: 'granted' }; },
    async schedule(n) { __calls.push(['notify', n.notifications[0].title]); }, addListener() {} },
  KeepAwake: { async keepAwake() { __calls.push(['keepAwake']); }, async allowSleep() { __calls.push(['allowSleep']); } } } };`;

const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--allow-file-access-from-files', '--autoplay-policy=no-user-gesture-required'] });
const errors = [];
async function openApp(config) {
  const page = await browser.newPage();
  await page.setViewport({ width: 400, height: 860, isMobile: true });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    const u = r.url();
    if (u.endsWith('/lib/supabase.js')) return r.respond({ contentType: 'application/javascript', body: FAKE_SUPABASE });
    if (u.endsWith('/config.js')) return r.respond({ contentType: 'application/javascript', body: `window.FINGERTIP_CONFIG = ${JSON.stringify(config)};` });
    r.continue();
  });
  await page.evaluateOnNewDocument(FAKE_PLUGINS);
  await page.goto(new URL('index.html', WWW).href);
  return page;
}
const visible = (page, id) => page.$eval('#' + id, (e) => e.classList.contains('on'));
const text = (page, sel) => page.$eval(sel, (e) => e.innerText);
async function waitFor(fn, ms = 9000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(250); } return false; }

// 0. Not configured
let page = await openApp({ SUPABASE_URL: 'https://YOUR-PROJECT-REF.supabase.co', SUPABASE_ANON_KEY: 'YOUR-KEY' });
await sleep(300);
ok(await visible(page, 's-setup'), 'unconfigured build shows setup message');
await page.close();

page = await openApp({ SUPABASE_URL: API, SUPABASE_ANON_KEY: 'test-anon' });
ok(await waitFor(() => visible(page, 's-pair')), 'first start: pairing screen');
const calls = () => page.evaluate(() => window.__calls);
ok((await calls()).some((c) => c[0] === 'channel' && c[1] === 'rides' && c[2] === 5), 'high-importance "rides" notification channel created');

// 1. Pairing
await page.type('#pPhone', '9800000001'); await page.type('#pCode', '000000'); await page.click('#pBtn');
ok(await waitFor(async () => (await text(page, '#pErr')).includes('కోడ్ తప్పు')), 'wrong code → Telugu error');
await page.$eval('#pCode', (e) => (e.value = '')); await page.type('#pCode', '123456'); await page.click('#pBtn');
ok(await waitFor(() => visible(page, 's-main')), 'right code → main screen');
ok((await text(page, '#hName')).includes('రవి') && (await text(page, '#hSub')).includes('TS 02 UB 4512'), 'header shows driver + auto number');
ok((await api('/test/driver?name=Ravi')).paired, 'driver row linked to this phone');

// 2. Duty on → GPS service + heartbeat
await page.click('#duty');
ok(await waitFor(async () => (await text(page, '#duty')).includes('డ్యూటీలో')), 'ON DUTY');
ok(await waitFor(async () => (await api('/test/driver?name=Ravi')).has_gps), 'GPS heartbeat saved');
const d = await api('/test/driver?name=Ravi');
ok(d.status === 'AVAILABLE' && Number(d.lat) === 18.44, 'database: AVAILABLE at the GPS position');
ok((await calls()).some((c) => c[0] === 'addWatcher') && (await calls()).some((c) => c[0] === 'notifPerm'), 'background GPS service started, notification permission asked');

// 3. Ride from WhatsApp → alert within one poll
await api('/test/srinu-free');
await page.evaluate(() => { window.__calls.length = 0; });
let r = await api('/test/ride', { phone: '919811111111', dest: 'KOTHIRAMPUR' });
ok(r.pinged.includes('Ravi'), 'Ravi alerted by the database');
ok(await waitFor(() => visible(page, 'alert'), 7000), 'alert appears (polling backup, no realtime)');
ok((await text(page, '#aDest')).includes('కోతిరాంపూర్'), 'alert shows destination in Telugu');
ok((await calls()).some((c) => c[0] === 'keepAwake'), 'screen kept awake during alert');
fs.mkdirSync('/home/claude/scratch', { recursive: true });
await page.screenshot({ path: '/home/claude/scratch/apk-alert.png' });

// 4. Accept (Srinu also alerted but Ravi is first)
await page.click('#aAcc');
ok(await waitFor(async () => (await text(page, '#rideBox')).includes('+919811111111')), 'accepted: passenger phone shown');
ok(await page.$eval('#rCall', (a) => a.href === 'tel:+919811111111'), 'Call button dials passenger');
ok(await page.$eval('#rRoute', (a) => a.href.startsWith('https://www.google.com/maps/dir/?api=1&destination=18.4386,79.1288')), 'Route opens Google Maps to pickup');
let sent = await api('/test/sent');
ok(sent.some((m) => m.to === '919811111111' && m.text?.startsWith('✅') && m.text.includes('Ravi')), 'passenger got WhatsApp confirmation');
await page.screenshot({ path: '/home/claude/scratch/apk-ride.png' });

// 5. Duty off blocked during ride; trip done
await page.click('#duty'); await sleep(200);
ok((await text(page, '#toast')).includes('ముందు రైడ్ పూర్తి'), 'cannot go off duty mid-ride');
await page.click('#rDone');
ok(await waitFor(async () => !(await text(page, '#rideBox')).trim()), 'trip done → ride card gone');
ok((await api('/test/driver?name=Ravi')).status === 'AVAILABLE', 'database: Ravi AVAILABLE again');

// 6. Skip → only driver skipped → passenger told "no autos"
await api('/test/srinu-accept', { ride_id: '00000000-0000-0000-0000-000000000000' }); // no-op
await page.evaluate(() => fetch('http://localhost:8787/test/srinu-free'));
r = await api('/test/ride', { phone: '919822222222', dest: 'KAMAN' });
ok(await waitFor(() => visible(page, 'alert'), 7000), 'second alert');
await page.click('#aSkip');
await sleep(600);
// Srinu was also pinged; make Srinu skip too via the function
await fetch(API + '/functions/v1/dispatch/driver/decline', { method: 'POST', headers: { authorization: 'Bearer 40000000-0000-0000-0000-0000000000a2' }, body: JSON.stringify({ ride_id: r.ride_id }) });
await sleep(300);
sent = await api('/test/sent');
ok(sent.some((m) => m.to === '919822222222' && m.text?.includes('అందుబాటులో లేవు')), 'all skipped → passenger told no autos');

// 7. Other driver takes it first → Ravi's alert closes
r = await api('/test/ride', { phone: '919833333333', dest: 'BUS_STAND' });
ok(await waitFor(() => visible(page, 'alert'), 7000), 'third alert');
const j = await api('/test/srinu-accept', { ride_id: r.ride_id });
ok(j.ok, 'Srinu accepted first');
ok(await waitFor(async () => !(await visible(page, 'alert')), 7000), 'Ravi alert closes by itself');
await page.click('#aAcc').catch(() => {});

// 8. Passenger cancels on WhatsApp → driver app notices
await api('/test/srinu-free');
r = await api('/test/ride', { phone: '919844444444', dest: 'KAMAN' });
ok(await waitFor(() => visible(page, 'alert'), 7000), 'fourth alert');
await page.click('#aAcc');
ok(await waitFor(async () => (await text(page, '#rideBox')).includes('+919844444444')), 'accepted fourth');
await api('/test/cancel', { phone: '919844444444' });
ok(await waitFor(async () => !(await text(page, '#rideBox')).trim(), 17000), 'passenger cancelled → ride card removed');
ok((await text(page, '#toast')).includes('రద్దు'), 'driver told passenger cancelled');

// 9. Off duty → GPS service stopped
await page.click('#duty');
ok(await waitFor(async () => (await text(page, '#duty')).includes('ఆఫ్ డ్యూటీ')), 'OFF DUTY');
ok((await calls()).some((c) => c[0] === 'removeWatcher'), 'background GPS stopped');
ok((await api('/test/driver?name=Ravi')).status === 'OFFLINE', 'database: OFFLINE');
await page.screenshot({ path: '/home/claude/scratch/apk-main.png' });

// 10. Reopen app: stays paired, no pairing screen
await page.close();
page = await openApp({ SUPABASE_URL: API, SUPABASE_ANON_KEY: 'test-anon' });
ok(await waitFor(() => visible(page, 's-main')), 'reopen: still paired');

ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
process.exit(failed ? 1 : 0);
