// LOCAL TESTING ONLY. A stand-in for Supabase so the driver app can be tested
// end to end in a browser:
//   /rest/v1/rpc/<fn>          → runs the real database function as the driver
//                                (Bearer token = driver's auth uid; none = anon)
//   /functions/v1/dispatch/... → the real Edge Function code, with fake WhatsApp
//   /test/...                  → helpers for the test (make a ride, read sent messages)
// Usage: TEST_DATABASE_URL=... deno run -A server.ts   (wipes that database)
import pg from 'npm:pg@8.13.1';
import { makeDb, makeDispatcher, makeHandler } from '../../supabase/functions/dispatch/index.ts';

const pool = new pg.Pool({ connectionString: Deno.env.get('TEST_DATABASE_URL')!, max: 10 });
const root = new URL('../../supabase/', import.meta.url);
const SET_FNS = new Set(['start_search_svc', 'expire_due_rides_svc']);

{
  const c = await pool.connect();
  await c.query('drop schema if exists public cascade; create schema public; drop schema if exists net cascade; drop schema if exists vault cascade;');
  for (const f of ['tests/00_local_supabase_stub.sql', 'tests/00c_local_vault_net_stub.sql', 'migrations/20261125120000_auto_dispatch.sql',
    'tests/00b_supabase_default_grants.sql', 'migrations/20261125150000_standalone_app.sql']) await c.query(Deno.readTextFileSync(new URL(f, root)));
  await c.query(`set search_path = public, extensions;
    insert into drivers (id, name, name_te, phone, auto_number, pair_code) values
      ('00000000-0000-0000-0000-0000000000a1', 'Ravi', 'రవి', '919800000001', 'TS 02 UB 4512', '123456'),
      ('00000000-0000-0000-0000-0000000000a2', 'Srinu', 'శ్రీను', '919800000002', 'TS 02 UC 1188', null);
    update drivers set user_id = '40000000-0000-0000-0000-0000000000a2', status = 'AVAILABLE',
      last_location = ST_MakePoint(79.1288, 18.4470)::geography, last_ping_at = now() where name = 'Srinu';`);
  c.release();
}

async function asRole(uid: string | null, sql: string, params: unknown[]) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid || '']);
    await c.query(`set local role ${uid ? 'authenticated' : 'anon'}`);
    const r = await c.query(sql, params);
    await c.query('commit');
    return r;
  } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
}
const svcRpc = async (fn: string, args: Record<string, unknown> = {}) => {
  const k = Object.keys(args);
  const { rows, fields } = await pool.query(`select * from public.${fn}(${k.map((x, i) => `${x} => $${i + 1}`).join(', ')})`, k.map((x) => args[x]));
  if (SET_FNS.has(fn)) return rows;
  if (fields.length === 1 && fields[0].name === fn) return rows[0]?.[fn] ?? null;
  return rows[0] ?? null;
};

const sent: any[] = [];
const wa: any = {
  verifySignature: async () => true,
  sendText: async (to: string, text: string) => { sent.push({ to, type: 'text', text }); return 'wamid.' + sent.length; },
  sendLocationRequest: async () => 'w', sendList: async () => 'w',
  sendContact: async (to: string, c: any) => { sent.push({ to, type: 'contact', ...c }); return 'w'; },
  mediaInfo: async () => ({ url: '', file_size: 1 }), download: async () => new Uint8Array(),
};
const db = makeDb(svcRpc);
const dispatcher = makeDispatcher(db, wa, { transcribe: async () => '' });
const fnHandler = makeHandler({ dispatcher, wa, db, verifyToken: 'vt', cronSecret: 'c', userFromJwt: async (j) => j });

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', ...CORS } });

Deno.serve({ port: 8787, onListen: () => console.log('READY') }, async (req) => {
  const url = new URL(req.url);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const m = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/);
    if (m) {
      const uid = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') || null;
      const args = await req.json().catch(() => ({}));
      const k = Object.keys(args);
      const r = await asRole(uid, `select public.${m[1]}(${k.map((x, i) => `${x} => $${i + 1}`).join(', ')}) as v`, k.map((x) => args[x]));
      return json({ data: r.rows[0]?.v ?? null });
    }
    if (url.pathname.startsWith('/functions/v1/dispatch/')) {
      const res = await fnHandler(req);
      const h = new Headers(res.headers); Object.entries(CORS).forEach(([a, b]) => h.set(a, b));
      return new Response(res.body, { status: res.status, headers: h });
    }
    if (url.pathname === '/test/ride') {   // a passenger books on WhatsApp near the bus stand
      const b = await req.json();
      const r = await svcRpc('create_ride_svc', { p_passenger_phone: b.phone, p_transcript: null, p_destination: b.dest });
      const drivers = await svcRpc('start_search_svc', { p_ride_id: r.id, p_lat: 18.4386, p_lng: 79.1288 });
      return json({ ride_id: r.id, pinged: drivers.map((d: any) => d.driver_name) });
    }
    if (url.pathname === '/test/cancel') { const b = await req.json(); return json(await svcRpc('cancel_by_phone_svc', { p_passenger_phone: b.phone })); }
    if (url.pathname === '/test/sent') return json(sent);
    if (url.pathname === '/test/driver') {
      const { rows } = await pool.query(`select name, status, last_ping_at is not null as has_gps, user_id is not null as paired,
        round(ST_Y(last_location::geometry)::numeric, 4) as lat from drivers where name = $1`, [url.searchParams.get('name')]);
      return json(rows[0]);
    }
    if (url.pathname === '/test/srinu-accept') {   // the other driver taps ACCEPT first
      const b = await req.json();
      return fnHandler(new Request('http://x/functions/v1/dispatch/driver/accept', { method: 'POST', headers: { authorization: 'Bearer 40000000-0000-0000-0000-0000000000a2' }, body: JSON.stringify({ ride_id: b.ride_id }) }));
    }
    if (url.pathname === '/test/srinu-free') { await pool.query(`update drivers set status='AVAILABLE' where name='Srinu'`); await pool.query(`update ride_requests set status='COMPLETED' where status='CONFIRMED' and assigned_driver_id='00000000-0000-0000-0000-0000000000a2'`); return json({ ok: true }); }
    return new Response('not found', { status: 404, headers: CORS });
  } catch (e) {
    return json({ error: { message: (e as Error).message } }, 400);
  }
});
