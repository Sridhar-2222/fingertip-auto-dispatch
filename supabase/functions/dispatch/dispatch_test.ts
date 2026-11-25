// LOCAL TESTING ONLY — runs the Edge Function against a real Postgres + PostGIS
// with both migrations applied. WhatsApp and Sarvam are fakes that record calls.
//   TEST_DATABASE_URL=postgresql://... deno test -A dispatch_test.ts   (wipes that database)
import A from 'node:assert/strict';
const assert = (c: unknown, m?: string) => A.ok(c, m ?? 'assertion failed');
const assertEquals = (a: unknown, b: unknown) => A.deepEqual(a, b);
const assertMatch = (s: string, r: RegExp) => A.match(s, r);
import pg from 'npm:pg@8.13.1';
import { makeDb, makeDispatcher, makeHandler, makeWhatsApp, matchDestination, isCancel, MAX_VOICE_BYTES } from './index.ts';

const URL_ = Deno.env.get('TEST_DATABASE_URL')!;
const root = new URL('../../', import.meta.url);
const read = (p: string) => Deno.readTextFileSync(new URL(p, root));
const SET_FNS = new Set(['start_search_svc', 'expire_due_rides_svc', 'claim_fallback_calls_svc']);

const pool = new pg.Pool({ connectionString: URL_, max: 10 });
// Mimics PostgREST: scalar → value, composite → object, set → array; named args
const rpc = async (fn: string, args: Record<string, unknown> = {}) => {
  const keys = Object.keys(args);
  const { rows, fields } = await pool.query(`select * from public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`, keys.map((k) => args[k]));
  if (SET_FNS.has(fn)) return rows;
  if (fields.length === 1 && fields[0].name === fn) return rows[0]?.[fn] ?? null;
  return rows[0] ?? null;
};

const SECRET = 'app-secret';
let sent: any[] = [];
const realWa = makeWhatsApp({ token: 't', phoneNumberId: '1', appSecret: SECRET });
const wa: any = {
  verifySignature: realWa.verifySignature,
  sendText: async (to: string, text: string) => { sent.push({ to, type: 'text', text }); return `wamid.out.${sent.length}`; },
  sendLocationRequest: async (to: string, text: string) => { sent.push({ to, type: 'loc', text }); return 'w'; },
  sendList: async (to: string, body: string, _b: string, rows: any[]) => { sent.push({ to, type: 'list', text: body, rows }); return 'w'; },
  sendContact: async (to: string, c: any) => { sent.push({ to, type: 'contact', ...c }); return 'w'; },
  mediaInfo: async (id: string) => ({ url: id, mime_type: 'audio/ogg', file_size: id.startsWith('LONG') ? MAX_VOICE_BYTES + 1 : 9000 }),
  download: async (url: string) => new TextEncoder().encode(url),
};
let sttCalls = 0;
const stt = { transcribe: async (b: Uint8Array) => { sttCalls++; return new TextDecoder().decode(b); } };
const db = makeDb(rpc);
const dispatcher = makeDispatcher(db, wa, stt, { warn() {}, error(m: string) { throw new Error(m); }, info() {} } as any);
const handler = makeHandler({ dispatcher, wa, db, verifyToken: 'vt', cronSecret: 'cron-s', userFromJwt: async (j) => j, background: (p) => { pending.push(p); } });
const pending: Promise<unknown>[] = [];

let n = 0;
const inbound = (from: string, body: Record<string, unknown>) => ({ id: `wamid.in.${++n}`, from, ...body });
const lastText = () => sent.filter((m) => m.type !== 'contact').at(-1);
async function hook(m: unknown) {
  const raw = JSON.stringify({ entry: [{ changes: [{ value: { messages: [m] } }] }] });
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw)))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const res = await handler(new Request('http://x/functions/v1/dispatch/whatsapp', { method: 'POST', body: raw, headers: { 'x-hub-signature-256': 'sha256=' + sig } }));
  assertEquals(res.status, 200);
  await Promise.all(pending.splice(0));   // wait for the work Meta doesn't wait for
}
const driverCall = (action: string, uid: string | null, ride_id: string) =>
  handler(new Request(`http://x/functions/v1/dispatch/driver/${action}`, { method: 'POST', body: JSON.stringify({ ride_id }), headers: uid ? { authorization: 'Bearer ' + uid } : {} }));

const STAND = { latitude: 18.4386, longitude: 79.1288 };
const U = { ravi: '30000000-0000-0000-0000-0000000000a1', srinu: '30000000-0000-0000-0000-0000000000a2' };

Deno.test({ name: 'setup', fn: async () => {
  const c = await pool.connect();
  await c.query('drop schema if exists public cascade; create schema public; drop schema if exists net cascade; drop schema if exists vault cascade;');
  for (const f of ['tests/00_local_supabase_stub.sql', 'tests/00c_local_vault_net_stub.sql', 'migrations/20261125120000_auto_dispatch.sql',
    'tests/00b_supabase_default_grants.sql', 'migrations/20261125150000_standalone_app.sql']) await c.query(read(f));
  c.release();
}, sanitizeResources: false, sanitizeOps: false });

async function reset() {
  sent = []; sttCalls = 0;
  await pool.query('truncate driver_pings, ride_requests, drivers, processed_messages cascade');
  await pool.query(`set search_path = public, extensions;
    insert into drivers (id, user_id, name, name_te, phone, auto_number, status, last_location, last_ping_at) values
     ('00000000-0000-0000-0000-0000000000a1', '${U.ravi}',  'Ravi',  'రవి',   '919800000001', 'TS 02 UB 4512', 'AVAILABLE', ST_MakePoint(79.1288, 18.4410)::geography, now()),
     ('00000000-0000-0000-0000-0000000000a2', '${U.srinu}', 'Srinu', 'శ్రీను', '919800000002', 'TS 02 UC 1188', 'AVAILABLE', ST_MakePoint(79.1288, 18.4470)::geography, now());`);
}
const opts = { sanitizeResources: false, sanitizeOps: false };
const rideIdOf = async (phone: string) => (await pool.query('select id from ride_requests where passenger_phone = $1 order by created_at desc limit 1', [phone])).rows[0].id;

Deno.test({ name: 'matcher + cancel words', ...opts, fn: () => {
  assertEquals(matchDestination('కోతిరాంపూర్ కి ఆటో కావాలి'), 'KOTHIRAMPUR');
  assertEquals(matchDestination('bus stand nundi kothirampur ki'), 'KOTHIRAMPUR');
  assertEquals(matchDestination('kothrampur'), 'KOTHIRAMPUR');
  assertEquals(matchDestination('hello'), null);
  assert(isCancel('రద్దు') && isCancel('రద్దు చేయండి') && isCancel('Cancel ride') && !isCancel('kaman'));
}});

Deno.test({ name: 'voice note → location request → pin → both drivers alerted', ...opts, fn: async () => {
  await reset();
  const P = '919811111111';
  await hook(inbound(P, { type: 'audio', audio: { id: 'కోతిరాంపూర్ కి ఆటో కావాలి' } }));
  assertEquals(lastText().type, 'loc');
  assertMatch(lastText().text, /^🛺 కోతిరాంపూర్ కి/);
  assert(!/₹|ఛార్జీ|fare/i.test(lastText().text), 'no fare');
  await hook(inbound(P, { type: 'location', location: STAND }));
  assertMatch(lastText().text, /2 ఆటోలకు/);
  const { rows } = await pool.query('select count(*)::int c from driver_pings');
  assertEquals(rows[0].c, 2);
  await hook(inbound(P, { type: 'location', location: STAND }));
  assertMatch(lastText().text, /Still looking/);
}});

Deno.test({ name: 'two drivers tap ACCEPT together → exactly one wins; passenger told', ...opts, fn: async () => {
  await reset();
  const P = '919822222222';
  await hook(inbound(P, { type: 'text', text: { body: 'bus stand' } }));
  await hook(inbound(P, { type: 'location', location: STAND }));
  const rid = await rideIdOf(P);
  const res = await Promise.all([driverCall('accept', U.ravi, rid), driverCall('accept', U.srinu, rid)]);
  const bodies = await Promise.all(res.map((r) => r.json()));
  const win = bodies.filter((b) => b.ok);
  assertEquals(win.length, 1);
  assertEquals(bodies.find((b) => !b.ok).reason, 'taken');
  assertEquals(win[0].passenger_phone, P);
  assert(Math.abs(win[0].pickup.lat - STAND.latitude) < 1e-6);
  const conf = sent.find((m) => m.type === 'text' && m.text.startsWith('✅'));
  assert(conf && /Reply CANCEL/.test(conf.text), 'confirmation with cancel hint');
  assert(sent.some((m) => m.type === 'contact'), 'contact card');
  // passenger replies cancel → driver freed
  await hook(inbound(P, { type: 'text', text: { body: 'రద్దు' } }));
  assertEquals(lastText().text, 'మీ రైడ్ రద్దు చేయబడింది. / Your ride has been cancelled.');
  const { rows } = await pool.query("select count(*)::int c from drivers where status = 'AVAILABLE'");
  assertEquals(rows[0].c, 2);
}});

Deno.test({ name: 'driver endpoints need a paired login; complete frees driver', ...opts, fn: async () => {
  await reset();
  const P = '919833333333';
  await hook(inbound(P, { type: 'location', location: STAND }));
  const rid = await rideIdOf(P);
  assertEquals((await driverCall('accept', null, rid)).status, 401);
  assertEquals((await driverCall('accept', '99999999-0000-0000-0000-000000000000', rid)).status, 401);
  assertEquals((await (await driverCall('accept', U.ravi, 'not-a-uuid')).json()).reason, 'bad_id');
  assert((await (await driverCall('accept', U.ravi, rid)).json()).ok);
  assert((await (await driverCall('complete', U.ravi, rid)).json()).ok);
  const { rows } = await pool.query("select status from drivers where user_id = $1", [U.ravi]);
  assertEquals(rows[0].status, 'AVAILABLE');
}});

Deno.test({ name: 'everyone skips → passenger told right away', ...opts, fn: async () => {
  await reset();
  const P = '919844444444';
  await hook(inbound(P, { type: 'location', location: STAND }));
  const rid = await rideIdOf(P);
  await driverCall('decline', U.ravi, rid);
  assertMatch(lastText().text, /Still|ఆటోలకు/);   // not yet
  await driverCall('decline', U.srinu, rid);
  assertMatch(lastText().text, /అందుబాటులో లేవు/);
}});

Deno.test({ name: 'timer /notify needs the secret and tells the passenger', ...opts, fn: async () => {
  await reset();
  const call = (secret: string) => handler(new Request('http://x/functions/v1/dispatch/notify', { method: 'POST', headers: { 'x-cron-secret': secret }, body: JSON.stringify({ kind: 'NO_AUTO', ride_id: '00000000-0000-0000-0000-000000000000', passenger_phone: '919855555555' }) }));
  assertEquals((await call('wrong')).status, 403);
  assertEquals((await call('cron-s')).status, 200);
  assertEquals(lastText().to, '919855555555');
  assertMatch(lastText().text, /అందుబాటులో లేవు/);
}});

Deno.test({ name: 'long voice note is not sent to Sarvam; images get rides-only; retries ignored', ...opts, fn: async () => {
  await reset();
  await hook(inbound('919866666666', { type: 'audio', audio: { id: 'LONG recording' } }));
  assertEquals(sttCalls, 0);
  assertEquals(lastText().type, 'list');
  assertMatch(lastText().text, /చిన్న వాయిస్/);
  await hook(inbound('919877777777', { type: 'image', image: { id: 'x' } }));
  assertMatch(lastText().text, /ఆటో బుకింగ్ కోసం మాత్రమే/);
  const m = inbound('919888888888', { type: 'text', text: { body: 'kaman' } });
  const before = sent.length;
  await hook(m); await hook(m);
  assertEquals(sent.length, before + 1);
}});

Deno.test({ name: 'not understood → list → pick → location request', ...opts, fn: async () => {
  await reset();
  const P = '919899999999';
  await hook(inbound(P, { type: 'audio', audio: { id: 'ఆటో కావాలి' } }));
  assertEquals(lastText().type, 'list');
  assertEquals(lastText().rows.length, 6);
  await hook(inbound(P, { type: 'interactive', interactive: { list_reply: { id: 'dest:KAMAN' } } }));
  assertEquals(lastText().type, 'loc');
  assertMatch(lastText().text, /కమాన్/);
}});

Deno.test({ name: 'webhook security', ...opts, fn: async () => {
  const bad = await handler(new Request('http://x/functions/v1/dispatch/whatsapp', { method: 'POST', body: '{}', headers: { 'x-hub-signature-256': 'sha256=00' } }));
  assertEquals(bad.status, 401);
  assertEquals(await (await handler(new Request('http://x/functions/v1/dispatch/whatsapp?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=42'))).text(), '42');
  assertEquals((await handler(new Request('http://x/functions/v1/dispatch/whatsapp?hub.mode=subscribe&hub.verify_token=no&hub.challenge=42'))).status, 403);
  assertEquals((await handler(new Request('http://x/functions/v1/dispatch/nope'))).status, 404);
}});

Deno.test({ name: 'teardown', ...opts, fn: async () => { await pool.end(); } });
