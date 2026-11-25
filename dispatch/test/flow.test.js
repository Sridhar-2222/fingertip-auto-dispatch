// End-to-end flow against a real Postgres + PostGIS with the migration applied.
// WhatsApp, Sarvam, FCM and Exotel are fakes that record what was sent.
// Run with TEST_DATABASE_URL pointing at a THROWAWAY database (it is wiped).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { createDb } from '../src/db.js';
import { createDispatcher } from '../src/dispatch.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createApp } from '../src/app.js';

const DB_URL = process.env.TEST_DATABASE_URL;
const root = path.resolve(import.meta.dirname, '../../supabase');
const skip = !DB_URL && 'set TEST_DATABASE_URL to run';

let admin, db, sent, pushes, calls, dispatcher;
const STAND = { latitude: 18.4386, longitude: 79.1288 };
const D = { ravi: '00000000-0000-0000-0000-00000000000a', srinu: '00000000-0000-0000-0000-00000000000b' };

const fakeWa = {
  verifySignature: () => true,
  sendText: async (to, text) => { sent.push({ to, type: 'text', text }); return `wamid.out.${sent.length}`; },
  sendLocationRequest: async (to, text) => { sent.push({ to, type: 'location_request', text }); return 'w'; },
  sendList: async (to, body, button, rows) => { sent.push({ to, type: 'list', text: body, rows }); return 'w'; },
  sendAudio: async (to, link) => { sent.push({ to, type: 'audio', link }); return 'w'; },
  sendContact: async (to, c) => { sent.push({ to, type: 'contact', ...c }); return 'w'; },
  downloadMedia: async (id) => ({ buffer: Buffer.from(id), mimeType: 'audio/ogg' }),
};
// "Transcribes" by returning the media id, so tests choose what was "said"
const fakeStt = { transcribe: async (buf) => buf.toString() };

let n = 0;
const inbound = (from, body) => ({ id: `wamid.in.${++n}`, from, ...body });

before(async () => {
  if (skip) return;
  admin = new pg.Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query('drop schema if exists public cascade; create schema public;');
  await admin.query(fs.readFileSync(`${root}/tests/00_local_supabase_stub.sql`, 'utf8'));
  await admin.query(fs.readFileSync(`${root}/migrations/20261125120000_auto_dispatch.sql`, 'utf8'));
  db = createDb(DB_URL);
});
after(async () => { if (skip) return; await db.end(); await admin.end(); });

beforeEach(async () => {
  if (skip) return;
  sent = []; pushes = []; calls = [];
  await admin.query('truncate driver_pings, ride_requests, drivers, processed_messages cascade');
  await admin.query(`
    set search_path = public, extensions;
    insert into drivers (id, name, phone, auto_number, status, last_location, last_ping_at, push_token) values
      ('${D.ravi}',  'Ravi',  '919800000001', 'TS02UB0001', 'AVAILABLE', ST_MakePoint(79.1288, 18.4431)::geography, now(), 'tok-ravi'),
      ('${D.srinu}', 'Srinu', '919800000002', 'TS02UB0002', 'AVAILABLE', ST_MakePoint(79.1288, 18.4494)::geography, now(), 'tok-srinu');`);
  dispatcher = createDispatcher({
    db, wa: fakeWa, stt: fakeStt,
    push: { send: async (tokens, data) => pushes.push({ tokens, ...data }) },
    exotel: { enabled: true, call: async (phone, outcome) => calls.push({ phone, outcome }) },
    publicBaseUrl: 'https://fingertip.in',
    log: { info() {}, warn() {}, error(m) { throw new Error(m); } },
  });
});

test('voice note → location request → pin → drivers alerted', { skip }, async () => {
  const P = '919811111111';
  await dispatcher.handleMessage(inbound(P, { type: 'audio', audio: { id: 'కోతిరాంపూర్ కి ఆటో కావాలి' } }));
  assert.equal(sent[0].type, 'location_request');
  assert.match(sent[0].text, /^🛺 కోతిరాంపూర్ కి/);       // Telugu first
  assert.doesNotMatch(sent[0].text, /₹|ఛార్జీ|fare/i);
  assert.match(sent[0].text, /only with the driver/);

  await dispatcher.handleMessage(inbound(P, { type: 'location', location: STAND }));
  assert.match(sent.at(-1).text, /2 ఆటోలకు/);
  assert.deepEqual(pushes[0].tokens, ['tok-ravi', 'tok-srinu']);   // nearest first
  assert.equal(pushes[0].kind, 'RIDE_ALERT');
  assert.equal(pushes[0].destination, 'KOTHIRAMPUR');

  // a second pin while searching does not start a second search
  await dispatcher.handleMessage(inbound(P, { type: 'location', location: STAND }));
  assert.match(sent.at(-1).text, /Still looking/);
  assert.equal(pushes.length, 1);
});

test('two drivers tap ACCEPT at the same moment → exactly one wins', { skip }, async () => {
  const P = '919822222222';
  await dispatcher.handleMessage(inbound(P, { type: 'text', text: { body: 'bus stand' } }));
  await dispatcher.handleMessage(inbound(P, { type: 'location', location: STAND }));
  const { rows: [r] } = await admin.query('select id from ride_requests where passenger_phone = $1', [P]);

  const results = await Promise.all([
    dispatcher.driverAccept(r.id, { id: D.ravi }),
    dispatcher.driverAccept(r.id, { id: D.srinu }),
  ]);
  const winners = results.filter((x) => x.ok);
  const losers = results.filter((x) => !x.ok);
  assert.equal(winners.length, 1);
  assert.equal(losers[0].reason, 'taken');
  assert.match(losers[0].message, /వేరే డ్రైవర్/);
  assert.equal(winners[0].passenger_phone, P);
  assert.ok(Math.abs(winners[0].pickup.lat - STAND.latitude) < 1e-6);

  const confirm = sent.find((m) => m.type === 'text' && m.text.startsWith('✅'));
  assert.ok(confirm, 'passenger told');
  assert.match(confirm.text, /https:\/\/fingertip\.in\/r\/[0-9a-f]{36}/);
  assert.ok(sent.some((m) => m.type === 'contact'), 'driver contact card sent');
  assert.ok(pushes.some((p) => p.kind === 'RIDE_TAKEN' && p.tokens.length === 1), 'loser dismissed');
});

test('nobody nearby → passenger told immediately', { skip }, async () => {
  await admin.query("update drivers set status = 'OFFLINE'");
  await dispatcher.handleMessage(inbound('919833333333', { type: 'location', location: STAND }));
  assert.match(sent.at(-1).text, /3 కి\.మీ\./);
  assert.equal(pushes.length, 0);
});

test('nobody accepts in 30 s → worker closes it and tells passenger + drivers', { skip }, async () => {
  const P = '919844444444';
  await dispatcher.handleMessage(inbound(P, { type: 'location', location: STAND }));
  await admin.query("update ride_requests set expires_at = now() - interval '1 s' where passenger_phone = $1", [P]);
  assert.equal(await dispatcher.expireTick(), 1);
  assert.match(sent.at(-1).text, /అందుబాటులో లేవు/);
  assert.ok(pushes.some((p) => p.kind === 'RIDE_EXPIRED' && p.tokens.length === 2));
  assert.equal(await dispatcher.expireTick(), 0);
});

test('unread outcome after 20 s → one fallback call', { skip }, async () => {
  const P = '919855555555';
  await dispatcher.handleMessage(inbound(P, { type: 'location', location: STAND }));
  const { rows: [r] } = await admin.query('select id from ride_requests where passenger_phone = $1', [P]);
  await dispatcher.driverAccept(r.id, { id: D.ravi });
  assert.equal(await dispatcher.fallbackTick(), 0);
  await admin.query("update ride_requests set confirmed_at = now() - interval '21 s' where id = $1", [r.id]);
  assert.equal(await dispatcher.fallbackTick(), 1);
  assert.deepEqual(calls, [{ phone: P, outcome: 'CONFIRMED' }]);
  assert.equal(await dispatcher.fallbackTick(), 0);
});

test('read receipt prevents the fallback call', { skip }, async () => {
  const P = '919866666666';
  await dispatcher.handleMessage(inbound(P, { type: 'location', location: STAND }));
  const { rows: [r] } = await admin.query('select id from ride_requests where passenger_phone = $1', [P]);
  await dispatcher.driverAccept(r.id, { id: D.ravi });
  const { rows: [w] } = await admin.query('select notify_wamid from ride_requests where id = $1', [r.id]);
  await dispatcher.handleWebhook({ entry: [{ changes: [{ value: { statuses: [{ id: w.notify_wamid, status: 'read' }] } }] }] });
  await admin.query("update ride_requests set confirmed_at = now() - interval '21 s' where id = $1", [r.id]);
  assert.equal(await dispatcher.fallbackTick(), 0);
});

test('not understood → destination list; pick → location request', { skip }, async () => {
  const P = '919877777777';
  await dispatcher.handleMessage(inbound(P, { type: 'audio', audio: { id: 'ఆటో కావాలి' } }));
  assert.equal(sent[0].type, 'list');
  assert.equal(sent[0].rows.length, 6);
  assert.ok(sent[0].rows.every((r) => r.title.length <= 24));
  await dispatcher.handleMessage(inbound(P, { type: 'interactive', interactive: { list_reply: { id: 'dest:KAMAN' } } }));
  assert.equal(sent[1].type, 'location_request');
  assert.match(sent[1].text, /కమాన్/);
  const { rows } = await admin.query('select destination_name, raw_transcript from ride_requests where passenger_phone = $1 and status = $2', [P, 'AWAITING_LOCATION']);
  assert.deepEqual(rows, [{ destination_name: 'KAMAN', raw_transcript: 'ఆటో కావాలి' }]);
});

test('images / documents get a rides-only reply (nothing medicine-related handled)', { skip }, async () => {
  await dispatcher.handleMessage(inbound('919888888888', { type: 'image', image: { id: 'x' } }));
  assert.match(sent[0].text, /ఆటో బుకింగ్ కోసం మాత్రమే/);
  const { rows } = await admin.query('select count(*)::int c from ride_requests');
  assert.equal(rows[0].c, 0);
});

test('Meta retry of the same message is ignored', { skip }, async () => {
  const m = inbound('919899999999', { type: 'text', text: { body: 'kaman' } });
  await dispatcher.handleMessage(m);
  await dispatcher.handleMessage(m);
  assert.equal(sent.length, 1);
});

test('passenger cancels from link → driver freed and alerted', { skip }, async () => {
  const P = '919812345678';
  await dispatcher.handleMessage(inbound(P, { type: 'location', location: STAND }));
  const { rows: [r] } = await admin.query('select id, access_token from ride_requests where passenger_phone = $1', [P]);
  await dispatcher.driverAccept(r.id, { id: D.ravi });
  assert.deepEqual(await dispatcher.passengerCancel(r.access_token), { ok: true });
  const { rows: [d] } = await admin.query('select status from drivers where id = $1', [D.ravi]);
  assert.equal(d.status, 'AVAILABLE');
  assert.ok(pushes.some((p) => p.kind === 'RIDE_CANCELLED' && p.tokens[0] === 'tok-ravi'));
});

test('HTTP: webhook rejects bad signatures, accepts good ones; token route', { skip }, async () => {
  const secret = 'test-secret';
  const wa = { ...fakeWa, verifySignature: createWhatsApp({ appSecret: secret }).verifySignature };
  const app = createApp({ dispatcher, wa, db, verifyToken: 'vt', verifyDriver: async () => null, log: { error() {} } });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const body = JSON.stringify({ entry: [{ changes: [{ value: { messages: [inbound('919800011111', { type: 'text', text: { body: 'kaman' } })] } }] }] });
    const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

    assert.equal((await fetch(`${base}/webhook`, { method: 'POST', body, headers: { 'x-hub-signature-256': 'sha256=00' } })).status, 401);
    assert.equal((await fetch(`${base}/webhook`, { method: 'POST', body, headers: { 'x-hub-signature-256': sig } })).status, 200);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(sent.at(-1).type, 'location_request');

    assert.equal(await (await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=42`)).text(), '42');
    assert.equal((await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=no&hub.challenge=42`)).status, 403);

    const { rows: [r] } = await admin.query("select access_token from ride_requests where passenger_phone = '919800011111'");
    const st = await (await fetch(`${base}/api/r/${r.access_token}`)).json();
    assert.equal(st.status, 'AWAITING_LOCATION');
    assert.equal((await fetch(`${base}/api/r/1234`)).status, 404);              // 4-digit code is not access
    assert.equal((await fetch(`${base}/driver/rides/x/accept`, { method: 'POST' })).status, 401);
  } finally {
    server.close();
  }
});
