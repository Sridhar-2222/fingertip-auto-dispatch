// =====================================================================
// Fingertip Auto Dispatch — Supabase Edge Function "dispatch"
// One file, so it can be pasted into the Supabase dashboard editor.
//
// Routes (https://<project>.supabase.co/functions/v1/dispatch/...):
//   GET  /whatsapp            Meta webhook verification
//   POST /whatsapp            Meta webhook (voice notes, text, location, replies)
//   POST /driver/accept       driver app: { ride_id }   (Bearer = driver's login)
//   POST /driver/decline      driver app: { ride_id }
//   POST /driver/complete     driver app: { ride_id }
//   POST /notify              Supabase Cron timer: a ride closed with no auto
//
// Turn OFF "Enforce JWT verification" for this function (Meta can't send a
// Supabase login). Every route does its own check instead.
//
// Secrets (Edge Functions → Secrets): WA_ACCESS_TOKEN, WA_PHONE_NUMBER_ID,
// WA_APP_SECRET, WA_VERIFY_TOKEN, SARVAM_API_KEY, CRON_SECRET.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
//
// Rides only — never anything medicine-related on WhatsApp. No fares.
// =====================================================================

// ---------- place names (deterministic — the only AI step is Sarvam) ----------
export const LANDMARKS: Record<string, { te: string; en: string; aliases: string[] }> = {
  KOTHIRAMPUR: { te: 'కోతిరాంపూర్', en: 'Kothirampur', aliases: ['కోతిరాంపూర్', 'కోతిరాంపూరు', 'కొత్తిరాంపూర్', 'కొత్తరాంపూర్', 'కోతి రాంపూర్', 'kothirampur', 'kotirampur', 'kothi rampur', 'kotharampur', 'kottirampur'] },
  ALGUNUR: { te: 'అలుగునూరు', en: 'Algunur', aliases: ['అలుగునూరు', 'అలుగునూర్', 'అల్గునూర్', 'అల్గునూరు', 'algunur', 'alugunur', 'alugunuru', 'algunoor'] },
  BUS_STAND: { te: 'కరీంనగర్ బస్ స్టాండ్', en: 'Karimnagar Bus Stand', aliases: ['బస్ స్టాండ్', 'బస్టాండ్', 'బస్సు స్టాండ్', 'బస్ స్టేషన్', 'బస్సు స్టేషన్', 'బస్ డిపో', 'bus stand', 'busstand', 'bus station', 'bus depot'] },
  CIVIL_HOSPITAL: { te: 'సివిల్ హాస్పిటల్', en: 'Civil Hospital', aliases: ['సివిల్ హాస్పిటల్', 'సివిల్ ఆసుపత్రి', 'ప్రభుత్వ ఆసుపత్రి', 'ప్రభుత్వ దవాఖాన', 'సర్కారు దవాఖాన', 'సర్కార్ దవాఖాన', 'గవర్నమెంట్ హాస్పిటల్', 'పెద్ద దవాఖాన', 'పెద్దాసుపత్రి', 'civil hospital', 'government hospital', 'govt hospital', 'sarkari hospital'] },
  KAMAN: { te: 'కమాన్', en: 'Kaman', aliases: ['కమాన్', 'కమాను', 'kaman', 'kamaan'] },
  HUSNABAD: { te: 'హుస్నాబాద్', en: 'Husnabad', aliases: ['హుస్నాబాద్', 'హుస్నాబాదు', 'husnabad', 'husnabaad'] },
};
const TO_MARKERS = ['కి', 'కు', 'వరకు', 'దాకా', 'ki', 'ku', 'ke', 'varaku', 'daaka', 'daka'];
const CANCEL_WORDS = ['రద్దు', 'క్యాన్సిల్', 'cancel', 'raddu'];

export const normalize = (s: string) =>
  (s || '').normalize('NFC').toLowerCase().replace(/[​-‍﻿]/g, '').replace(/[^\p{L}\p{M}\p{N}]+/gu, '');

function lev(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let p = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, p + (a[i - 1] === b[j - 1] ? 0 : 1)); p = t; }
  }
  return d[b.length];
}
const NORM = Object.entries(LANDMARKS).map(([key, l]) => ({ key, aliases: [...new Set(l.aliases.map(normalize))] }));

export function matchDestination(transcript: string): string | null {
  const text = normalize(transcript);
  if (!text) return null;
  const hits: { key: string; pos: number; end: number }[] = [];
  for (const { key, aliases } of NORM) {
    let best = -1, len = 0;
    for (const a of aliases) { const p = text.lastIndexOf(a); if (p > best || (p === best && a.length > len)) { best = p; len = a.length; } }
    if (best >= 0) hits.push({ key, pos: best, end: best + len });
  }
  if (!hits.length) {
    const words = (transcript || '').toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 5);
    for (const { key, aliases } of NORM) {
      if (aliases.some((a) => /^[a-z]+$/.test(a) && a.length >= 5 && words.some((w) => lev(w, a) <= 2))) hits.push({ key, pos: 0, end: 0 });
    }
  }
  if (!hits.length) return null;
  if (hits.length === 1) return hits[0].key;
  const marked = hits.filter((h) => TO_MARKERS.some((m) => text.startsWith(normalize(m), h.end)));
  if (marked.length === 1) return marked[0].key;
  return hits.sort((a, b) => b.pos - a.pos)[0].key;
}
// a short reply that starts with a cancel word: "రద్దు", "రద్దు చేయండి", "cancel", "Cancel ride"
export const isCancel = (t: string) => { const n = normalize(t); return n.length <= 30 && CANCEL_WORDS.some((w) => n.startsWith(normalize(w))); };
const label = (k: string | null) => (k && LANDMARKS[k]) ? LANDMARKS[k] : { te: 'మీరు చెప్పిన చోటు', en: 'your destination' };

// ---------- messages: Telugu first, English second ----------
export const msg = {
  askLocation: (k: string | null) => {
    const l = label(k);
    return [`🛺 ${l.te} కి ఆటో వెతుకుతాం.`, 'క్రింద ఉన్న బటన్ నొక్కి మీ లొకేషన్ పంపండి.', '',
      `We'll find an auto to ${l.en}.`, 'Tap the button below to send your location.', '',
      'ℹ️ ఆటో దొరికితే మీ ఫోన్ నంబర్ ఆ డ్రైవర్‌కి మాత్రమే ఇస్తాం. / Your number is shared only with the driver who accepts.'].join('\n');
  },
  askDestinationBody: 'ఎక్కడికి వెళ్ళాలి? క్రింద ఎంచుకోండి లేదా వాయిస్ మెసేజ్ పంపండి.\nWhere do you want to go? Pick below or send a voice note.',
  askDestinationButton: 'చోటు ఎంచుకోండి',
  notHeard: 'క్షమించండి, మీ మాట సరిగ్గా వినిపించలేదు. ఎక్కడికి వెళ్ళాలో క్రింద ఎంచుకోండి.\nSorry, we couldn\'t hear that clearly. Please pick your destination below.',
  tooLong: 'దయచేసి చిన్న వాయిస్ మెసేజ్ పంపండి (10 సెకన్లు చాలు), లేదా క్రింద ఎంచుకోండి.\nPlease send a short voice note (10 seconds is enough), or pick below.',
  searching: (n: number) => `🔔 దగ్గరలో ఉన్న ${n} ఆటోలకు చెప్పాము. 30 సెకన్లలో తెలియజేస్తాం.\nWe've alerted ${n} nearby auto${n === 1 ? '' : 's'}. We'll tell you within 30 seconds.`,
  confirmed: (d: { name: string; name_te?: string; auto_number: string; phone: string }, code: string) => [
    '✅ ఆటో వస్తోంది!', `డ్రైవర్: ${d.name_te || d.name}`, `ఆటో నంబర్: ${d.auto_number}`, `కాల్: +${d.phone}`, `రైడ్ కోడ్: ${code}`, '',
    `Auto confirmed! ${d.name} · ${d.auto_number}`, '',
    'రద్దు చేయడానికి "రద్దు" అని రిప్లై చేయండి. / Reply CANCEL to cancel.'].join('\n'),
  noAuto: '😔 క్షమించండి, ఇప్పుడు 3 కి.మీ. లోపల ఆటోలు అందుబాటులో లేవు. కొద్దిసేపటి తర్వాత మళ్ళీ ప్రయత్నించండి.\nSorry, no autos are free within 3 km right now. Please try again in a few minutes.',
  stillSearching: 'ఇంకా ఆటో కోసం వెతుకుతున్నాం, కొద్ది సెకన్లు ఆగండి.\nStill looking for your auto, please wait a few seconds.',
  alreadyConfirmed: 'మీ ఆటో ఇప్పటికే బుక్ అయింది. రద్దు చేయడానికి "రద్దు" అని రిప్లై చేయండి.\nYour auto is already booked. Reply CANCEL to cancel.',
  cancelled: 'మీ రైడ్ రద్దు చేయబడింది. / Your ride has been cancelled.',
  nothingToCancel: 'రద్దు చేయడానికి రైడ్ ఏదీ లేదు. / You have no ride to cancel.',
  ridesOnly: 'ఈ నంబర్ ఆటో బుకింగ్ కోసం మాత్రమే. 🛺 ఎక్కడికి వెళ్ళాలో వాయిస్ మెసేజ్ పంపండి.\nThis number is only for booking autos. Send a voice note saying where you want to go.',
  driver: {
    taken: 'ఈ రైడ్ వేరే డ్రైవర్ తీసుకున్నారు. / Ride already taken.',
    expired: 'సమయం అయిపోయింది. / This ride request has expired.',
    driver_not_available: 'మీరు ఇప్పటికే ఒక రైడ్‌లో ఉన్నారు. / You are already on a ride.',
    not_pinged: 'ఈ రైడ్ మీకు పంపలేదు. / This ride was not sent to you.',
    not_found: 'రైడ్ కనిపించలేదు. / Ride not found.',
  } as Record<string, string>,
};

// ---------- database calls (all rules live in SQL) ----------
type Rpc = (fn: string, args?: Record<string, unknown>) => Promise<any>;
const rec = (r: any) => (r && r.id ? r : null);
export function makeDb(rpc: Rpc) {
  return {
    claimMessage: (wamid: string) => rpc('claim_message_svc', { p_wamid: wamid }),
    createRide: async (phone: string, transcript: string | null, dest: string | null) =>
      rec(await rpc('create_ride_svc', { p_passenger_phone: phone, p_transcript: transcript, p_destination: dest })),
    setDestination: async (id: string, dest: string) => rec(await rpc('set_destination_svc', { p_ride_id: id, p_destination: dest })),
    awaitingRide: async (phone: string) => rec(await rpc('awaiting_ride_svc', { p_passenger_phone: phone })),
    openRide: async (phone: string) => rec(await rpc('open_ride_svc', { p_passenger_phone: phone })),
    startSearch: async (id: string, lat: number, lng: number) => (await rpc('start_search_svc', { p_ride_id: id, p_lat: lat, p_lng: lng })) || [],
    acceptRide: (id: string, driverId: string) => rpc('accept_ride_svc', { p_ride_id: id, p_driver_id: driverId }),
    declineRide: (id: string, driverId: string) => rpc('decline_ride_svc', { p_ride_id: id, p_driver_id: driverId }),
    completeRide: (id: string, driverId: string) => rpc('complete_ride_svc', { p_ride_id: id, p_driver_id: driverId }),
    cancelByPhone: (phone: string) => rpc('cancel_by_phone_svc', { p_passenger_phone: phone }),
    setNotifyWamid: (id: string, wamid: string) => rpc('set_notify_wamid_svc', { p_ride_id: id, p_wamid: wamid }),
    markNotifyRead: (wamid: string) => rpc('mark_notify_read_svc', { p_wamid: wamid }),
    driverByUser: async (uid: string) => rec(await rpc('driver_by_user_svc', { p_user_id: uid })),
  };
}
export type Db = ReturnType<typeof makeDb>;

// ---------- WhatsApp Cloud API ----------
export function makeWhatsApp(cfg: { token: string; phoneNumberId: string; appSecret: string; graph?: string }, f: typeof fetch = fetch) {
  const base = `https://graph.facebook.com/${cfg.graph || 'v23.0'}`;
  async function send(to: string, payload: Record<string, unknown>) {
    const res = await f(`${base}/${cfg.phoneNumberId}/messages`, {
      method: 'POST', headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, ...payload }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`WhatsApp send failed ${res.status}: ${JSON.stringify(body?.error || body)}`);
    return body?.messages?.[0]?.id || null;
  }
  return {
    async verifySignature(raw: string, header: string | null) {
      if (!header?.startsWith('sha256=')) return false;
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(cfg.appSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw)));
      const hex = [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
      const got = header.slice(7);
      if (got.length !== hex.length) return false;
      let diff = 0; for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ got.charCodeAt(i);
      return diff === 0;
    },
    sendText: (to: string, text: string) => send(to, { type: 'text', text: { body: text } }),
    sendLocationRequest: (to: string, text: string) => send(to, { type: 'interactive', interactive: { type: 'location_request_message', body: { text }, action: { name: 'send_location' } } }),
    sendList: (to: string, body: string, button: string, rows: { id: string; title: string; description: string }[]) =>
      send(to, { type: 'interactive', interactive: { type: 'list', body: { text: body }, action: { button, sections: [{ title: 'Destinations', rows }] } } }),
    sendContact: (to: string, c: { name: string; phone: string }) =>
      send(to, { type: 'contacts', contacts: [{ name: { formatted_name: c.name, first_name: c.name }, phones: [{ phone: `+${c.phone}`, type: 'CELL', wa_id: c.phone }] }] }),
    async mediaInfo(id: string) {
      const r = await f(`${base}/${id}`, { headers: { Authorization: `Bearer ${cfg.token}` } });
      if (!r.ok) throw new Error(`media lookup ${r.status}`);
      return await r.json() as { url: string; mime_type?: string; file_size?: number };
    },
    async download(url: string) {
      const r = await f(url, { headers: { Authorization: `Bearer ${cfg.token}` } });
      if (!r.ok) throw new Error(`media download ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    },
  };
}
export type WhatsApp = ReturnType<typeof makeWhatsApp>;

// ---------- Sarvam speech-to-text ----------
export const MAX_VOICE_BYTES = 60_000;   // ≈ 20 s of a WhatsApp voice note; longer ones are not sent (cost cap)
export function makeSarvam(apiKey: string, f: typeof fetch = fetch) {
  return {
    async transcribe(bytes: Uint8Array, mime = 'audio/ogg') {
      const form = new FormData();
      form.append('file', new Blob([bytes as unknown as BlobPart], { type: mime.split(';')[0] }), 'voice.ogg');
      form.append('model', 'saaras:v4');
      form.append('language_code', 'te-IN');
      const r = await f('https://api.sarvam.ai/speech-to-text', { method: 'POST', headers: { 'api-subscription-key': apiKey }, body: form, signal: AbortSignal.timeout(15000) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`Sarvam ${r.status}: ${JSON.stringify(body)}`);
      return String(body.transcript || '').trim();
    },
  };
}

// ---------- the flow ----------
export function makeDispatcher(db: Db, wa: WhatsApp, stt: { transcribe(b: Uint8Array, m?: string): Promise<string> }, log = console) {
  const rows = () => Object.entries(LANDMARKS).map(([k, l]) => ({ id: `dest:${k}`, title: l.te.slice(0, 24), description: l.en }));
  const askDestination = (to: string, body = msg.askDestinationBody) => wa.sendList(to, body, msg.askDestinationButton, rows());
  const askLocation = (to: string, dest: string | null) => wa.sendLocationRequest(to, msg.askLocation(dest));

  async function notifyNoAuto(rideId: string, phone: string) {
    const w = await wa.sendText(phone, msg.noAuto);
    if (w) await db.setNotifyWamid(rideId, w);
  }

  async function heard(from: string, transcript: string) {
    if (isCancel(transcript)) return cancel(from);
    const k = matchDestination(transcript);
    if (!k) {
      if (transcript) await db.createRide(from, transcript, null);  // keep transcript for tuning place names
      return askDestination(from, transcript ? msg.askDestinationBody : msg.notHeard);
    }
    const ride = await db.createRide(from, transcript, k);
    return askLocation(from, ride?.destination_name ?? k);
  }

  async function cancel(from: string) {
    const r = await db.cancelByPhone(from);
    await wa.sendText(from, r?.ok ? msg.cancelled : msg.nothingToCancel);
  }

  async function location(from: string, loc: { latitude: number; longitude: number }) {
    let ride = await db.awaitingRide(from);
    if (!ride) {
      const open = await db.openRide(from);
      if (open?.status === 'SEARCHING') return wa.sendText(from, msg.stillSearching);
      if (open?.status === 'CONFIRMED') return wa.sendText(from, msg.alreadyConfirmed);
      ride = await db.createRide(from, null, null);
    }
    const drivers = await db.startSearch(ride.id, loc.latitude, loc.longitude);
    if (!drivers.length) return notifyNoAuto(ride.id, from);
    await wa.sendText(from, msg.searching(drivers.length));
    // Drivers' apps hear the new ping through Supabase Realtime.
  }

  async function handleMessage(m: any) {
    if (!(await db.claimMessage(m.id))) return;           // Meta retry
    const from = m.from;
    switch (m.type) {
      case 'audio': {
        let t = '';
        try {
          const info = await wa.mediaInfo(m.audio.id);
          if ((info.file_size ?? 0) > MAX_VOICE_BYTES) return askDestination(from, msg.tooLong);
          t = await stt.transcribe(await wa.download(info.url), info.mime_type || 'audio/ogg');
        } catch (e) { log.warn?.(`STT failed: ${(e as Error).message}`); }
        return heard(from, t);
      }
      case 'text': return heard(from, m.text?.body || '');
      case 'location': return location(from, m.location);
      case 'interactive': {
        const id = m.interactive?.list_reply?.id || m.interactive?.button_reply?.id || '';
        if (id.startsWith('dest:') && LANDMARKS[id.slice(5)]) {
          const k = id.slice(5);
          const w = await db.awaitingRide(from);
          const ride = w ? await db.setDestination(w.id, k) : await db.createRide(from, null, k);
          return askLocation(from, ride?.destination_name ?? k);
        }
        return askDestination(from);
      }
      default: return wa.sendText(from, msg.ridesOnly);    // images, documents… autos only
    }
  }

  async function handleWebhook(payload: any) {
    for (const e of payload?.entry || []) for (const c of e.changes || []) {
      const v = c.value || {};
      for (const s of v.statuses || []) if (s.status === 'read') await db.markNotifyRead(s.id).catch(() => {});
      for (const m of v.messages || []) {
        try { await handleMessage(m); } catch (err) { log.error?.(`message ${m.id}: ${(err as Error).message}`); }
      }
    }
  }

  async function driverAccept(rideId: string, driver: { id: string }) {
    const r = await db.acceptRide(rideId, driver.id);
    if (!r?.ok) return { ok: false, reason: r?.reason, message: msg.driver[r?.reason] || '' };
    const w = await wa.sendText(r.passenger_phone, msg.confirmed(r.driver, r.ride_code)).catch((e) => { log.error?.(e.message); return null; });
    if (w) await db.setNotifyWamid(r.ride_id, w);
    await wa.sendContact(r.passenger_phone, { name: `${r.driver.name} (Auto ${r.driver.auto_number})`, phone: r.driver.phone }).catch(() => {});
    return { ok: true, ride_id: r.ride_id, ride_code: r.ride_code, passenger_phone: r.passenger_phone,
      pickup: { lat: r.pickup_lat, lng: r.pickup_lng }, destination_name: r.destination_name };
  }
  async function driverDecline(rideId: string, driver: { id: string }) {
    const r = await db.declineRide(rideId, driver.id);
    if (r?.all_declined) await notifyNoAuto(r.ride_id, r.passenger_phone);
    return { ok: true };
  }
  async function driverComplete(rideId: string, driver: { id: string }) {
    return { ok: Boolean(await db.completeRide(rideId, driver.id)) };
  }

  return { handleWebhook, handleMessage, driverAccept, driverDecline, driverComplete, notifyNoAuto };
}

// ---------- HTTP ----------
type Deps = {
  dispatcher: ReturnType<typeof makeDispatcher>;
  wa: WhatsApp;
  verifyToken: string;
  cronSecret: string;
  userFromJwt: (jwt: string) => Promise<string | null>;
  db: Db;
  background?: (p: Promise<unknown>) => void;
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS' };
const UUID = /^[0-9a-f-]{36}$/i;

export function makeHandler(d: Deps) {
  const bg = d.background || ((p: Promise<unknown>) => { p.catch(() => {}); });
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '');
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

    if (path.endsWith('/whatsapp')) {
      if (req.method === 'GET') {
        const ok = url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === d.verifyToken;
        return ok ? new Response(url.searchParams.get('hub.challenge') || '', { status: 200 }) : new Response('forbidden', { status: 403 });
      }
      const raw = await req.text();
      if (!(await d.wa.verifySignature(raw, req.headers.get('x-hub-signature-256')))) return new Response('bad signature', { status: 401 });
      let payload: unknown; try { payload = JSON.parse(raw); } catch { return new Response('bad json', { status: 400 }); }
      bg(d.dispatcher.handleWebhook(payload));     // reply to Meta at once; work continues
      return new Response('ok', { status: 200 });
    }

    if (path.endsWith('/notify') && req.method === 'POST') {
      if (!d.cronSecret || req.headers.get('x-cron-secret') !== d.cronSecret) return new Response('forbidden', { status: 403 });
      const b = await req.json().catch(() => ({}));
      if (b.kind === 'NO_AUTO' && b.ride_id && b.passenger_phone) await d.dispatcher.notifyNoAuto(b.ride_id, b.passenger_phone);
      return json({ ok: true });
    }

    const m = path.match(/\/driver\/(accept|decline|complete)$/);
    if (m && req.method === 'POST') {
      const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
      const uid = jwt ? await d.userFromJwt(jwt).catch(() => null) : null;
      const driver = uid ? await d.db.driverByUser(uid) : null;
      if (!driver) return json({ ok: false, reason: 'not_paired' }, 401);
      const b = await req.json().catch(() => ({}));
      if (!UUID.test(String(b.ride_id || ''))) return json({ ok: false, reason: 'bad_id' }, 400);
      try {
        const fn = m[1] === 'accept' ? d.dispatcher.driverAccept : m[1] === 'decline' ? d.dispatcher.driverDecline : d.dispatcher.driverComplete;
        return json(await fn(b.ride_id, driver));
      } catch (e) {
        console.error(`${m[1]}: ${(e as Error).message}`);
        return json({ ok: false, reason: 'server_error' }, 500);
      }
    }
    return new Response('not found', { status: 404 });
  };
}

// ---------- start (Supabase) ----------
// Always serve on Supabase; tests import this file with FINGERTIP_TEST=1.
if (Deno.env.get('FINGERTIP_TEST') !== '1') {
  const { createClient } = await import('npm:@supabase/supabase-js@2.49.4');
  const env = (k: string) => Deno.env.get(k) || '';
  const sb = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
  const rpc: Rpc = async (fn, args) => { const { data, error } = await sb.rpc(fn, args); if (error) throw new Error(`${fn}: ${error.message}`); return data; };
  const db = makeDb(rpc);
  const wa = makeWhatsApp({ token: env('WA_ACCESS_TOKEN'), phoneNumberId: env('WA_PHONE_NUMBER_ID'), appSecret: env('WA_APP_SECRET') });
  const dispatcher = makeDispatcher(db, wa, makeSarvam(env('SARVAM_API_KEY')));
  // deno-lint-ignore no-explicit-any
  const er = (globalThis as any).EdgeRuntime;
  Deno.serve(makeHandler({
    dispatcher, wa, db,
    verifyToken: env('WA_VERIFY_TOKEN'),
    cronSecret: env('CRON_SECRET'),
    userFromJwt: async (jwt) => { const { data } = await sb.auth.getUser(jwt); return data?.user?.id ?? null; },
    background: er?.waitUntil ? (p) => er.waitUntil(p) : undefined,
  }));
}
