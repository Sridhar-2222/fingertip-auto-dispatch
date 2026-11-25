// Fingertip driver app — runs inside the Android app (Capacitor).
// Talks only to your Supabase: database functions for duty/GPS/alerts,
// the "dispatch" Edge Function for accept / skip / trip done (which also
// sends the passenger's WhatsApp message).
(() => {
  'use strict';
  const CFG = window.FINGERTIP_CONFIG || {};
  const P = (window.Capacitor && window.Capacitor.Plugins) || {};
  const BG = P.BackgroundGeolocation, LN = P.LocalNotifications, KA = P.KeepAwake;
  const FN = (CFG.SUPABASE_URL || '').replace(/\/+$/, '') + '/functions/v1/dispatch';
  const HEARTBEAT_MS = 60000, POLL_MS = 5000, RIDE_POLL_MS = 15000;

  const PLACES = {
    KOTHIRAMPUR: ['కోతిరాంపూర్', 'Kothirampur'], ALGUNUR: ['అలుగునూరు', 'Algunur'],
    BUS_STAND: ['కరీంనగర్ బస్ స్టాండ్', 'Karimnagar Bus Stand'], CIVIL_HOSPITAL: ['సివిల్ హాస్పిటల్', 'Civil Hospital'],
    KAMAN: ['కమాన్', 'Kaman'], HUSNABAD: ['హుస్నాబాద్', 'Husnabad'],
  };
  const T = {
    taken: 'ఈ రైడ్ వేరే డ్రైవర్ తీసుకున్నారు · Ride already taken',
    closed: 'ఈ రైడ్ ముగిసింది · This ride has closed',
    expired: 'సమయం అయిపోయింది · Time is up',
    driver_not_available: 'మీరు ఇప్పటికే ఒక రైడ్‌లో ఉన్నారు · You are already on a ride',
    not_pinged: 'ఈ రైడ్ మీకు పంపలేదు · This ride was not sent to you',
    not_paired: 'మళ్ళీ చేరండి · Please join again',
    cancelled: 'ప్రయాణికుడు రైడ్ రద్దు చేశారు · Passenger cancelled the ride',
    net: 'ఇంటర్నెట్ లేదు, మళ్ళీ ప్రయత్నించండి · No internet, try again',
    finishFirst: 'ముందు రైడ్ పూర్తి చేయండి · Finish the ride first',
    yours: '✅ రైడ్ మీది! ప్రయాణికుడి వద్దకు వెళ్ళండి · Ride is yours!',
    done: 'ట్రిప్ పూర్తయింది · Trip done',
    noGps: 'GPS అనుమతి ఇవ్వండి · Please allow location',
  };
  const PAIR_ERR = {
    wrong_code: 'కోడ్ తప్పు · Wrong code', unknown_phone: 'ఈ నంబర్ నమోదు కాలేదు · This number is not registered',
    locked: 'చాలా సార్లు తప్పు. Fingertip ని సంప్రదించండి · Too many tries — contact Fingertip', not_signed_in: T.net,
  };

  const $ = (id) => document.getElementById(id);
  const placeTe = (k) => (PLACES[k] ? `${PLACES[k][0]}\n${PLACES[k][1]}` : '—');
  let sb = null, me = null, onDuty = false, ride = null, alertP = null, accepting = false;
  let watcherId = null, geoWatch = null, lastFix = null, lastSentAt = 0, lastSentFix = null;
  let hbTimer = null, pollTimer = null, ridePollTimer = null, alertTimer = null, actx = null, channel = null;
  const skipped = new Set();

  // ---------- small helpers ----------
  function show(id) { document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('on', s.id === 's-' + id)); }
  function toast(t) { const el = $('toast'); el.textContent = t; el.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('on'), 4000); }
  async function rpc(fn, args) { const { data, error } = await sb.rpc(fn, args || {}); if (error) throw error; return data; }
  async function callFn(action, rideId) {
    const { data } = await sb.auth.getSession();
    const res = await fetch(`${FN}/driver/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session?.access_token || ''}`, apikey: CFG.SUPABASE_ANON_KEY },
      body: JSON.stringify({ ride_id: rideId }),
    });
    return res.json().catch(() => ({ ok: false, reason: 'net' }));
  }
  const metres = (a, b) => { const R = 6371000, r = Math.PI / 180, x = (b.lng - a.lng) * r * Math.cos((a.lat + b.lat) * r / 2), y = (b.lat - a.lat) * r; return Math.hypot(x, y) * R; };

  // ---------- sound ----------
  function unlockAudio() { try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); actx.resume(); } catch (e) { /* no audio */ } }
  function beep() {
    if (!actx) return;
    try {
      [0, 0.22, 0.44].forEach((t, i) => { const o = actx.createOscillator(), g = actx.createGain(); o.type = 'square'; o.frequency.value = i === 1 ? 1320 : 880; g.gain.value = 0.25; o.connect(g); g.connect(actx.destination); o.start(actx.currentTime + t); o.stop(actx.currentTime + t + 0.18); });
      navigator.vibrate && navigator.vibrate([400, 150, 400]);
    } catch (e) { /* ignore */ }
  }

  // ---------- start ----------
  async function init() {
    if (!CFG.SUPABASE_URL || /YOUR-/.test(CFG.SUPABASE_URL + CFG.SUPABASE_ANON_KEY)) return show('setup');
    show('loading');
    try {
      sb = sb || window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
      const { data } = await sb.auth.getSession();
      if (!data.session) {
        const r = await sb.auth.signInAnonymously();
        if (r.error) throw r.error;
      }
      if (LN) {
        LN.createChannel({ id: 'rides', name: 'Ride alerts', description: 'New ride requests', importance: 5, visibility: 1, vibration: true }).catch(() => {});
        LN.addListener && LN.addListener('localNotificationActionPerformed', () => poll());
      }
      await loadMe();
    } catch (e) {
      $('errText').textContent = (e && e.message) || 'Could not connect.';
      show('error');
    }
  }

  async function loadMe() {
    me = await rpc('driver_me_self');
    if (!me) { show('pair'); return; }
    $('hName').textContent = `${me.name_te || me.name} · ${me.name}`;
    $('hSub').textContent = me.auto_number;
    onDuty = me.status !== 'OFFLINE';
    ride = await rpc('driver_current_ride_self').catch(() => null);
    show('main');
    render();
    subscribe();
    startPolling();
    if (onDuty) startGps();
  }

  // ---------- pairing ----------
  $('pairForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('pErr').textContent = ''; $('pBtn').disabled = true;
    try {
      const r = await rpc('claim_driver_self', { p_phone: $('pPhone').value.trim(), p_code: $('pCode').value.trim() });
      if (!r || !r.ok) { $('pErr').textContent = PAIR_ERR[r && r.reason] || T.net; return; }
      await loadMe();
    } catch (err) { $('pErr').textContent = T.net; }
    finally { $('pBtn').disabled = false; }
  });
  $('retry').addEventListener('click', init);

  // ---------- main screen ----------
  function render() {
    const d = $('duty');
    d.className = 'duty ' + (onDuty ? 'on' : 'off');
    d.setAttribute('aria-pressed', String(onDuty));
    d.innerHTML = onDuty
      ? '🟢 డ్యూటీలో ఉన్నాను<small>ON DUTY · ఆఫ్ చేయడానికి నొక్కండి</small>'
      : '⚪ ఆఫ్ డ్యూటీ<small>OFF DUTY · డ్యూటీ ప్రారంభించడానికి నొక్కండి</small>';
    $('stTitle').textContent = !onDuty ? '😴 డ్యూటీ ఆఫ్' : ride ? '🛺 రైడ్‌లో ఉన్నారు' : '⏳ రైడ్‌ల కోసం వేచి ఉన్నాం';
    $('stText').textContent = !onDuty ? 'డ్యూటీ ఆన్ చేస్తేనే రైడ్‌లు వస్తాయి. Turn on duty to get rides.'
      : 'ఫోన్ జేబులో ఉన్నా 3 కి.మీ. లోపల రైడ్ వస్తే అలర్ట్ వస్తుంది. You get an alert for rides within 3 km, even with the phone in your pocket.';
    const box = $('rideBox');
    box.textContent = '';
    if (ride) {
      const el = document.createElement('div'); el.className = 'ride';
      const lat = ride.pickup_lat, lng = ride.pickup_lng;
      el.innerHTML = `<h2>🧍 ప్రయాణికుడిని పికప్ చేయండి · Pick up</h2>
        <div class="big" id="rPhone"></div>
        <div id="rDest"></div><div class="muted" id="rCode"></div>
        <div class="row" style="margin-top:10px">
          <a class="btn solid" id="rCall">📞 కాల్ · Call</a>
          <a class="btn" id="rRoute">🗺️ దారి · Route</a></div>
        <button class="btn solid" id="rDone" style="margin-top:10px">✅ ట్రిప్ పూర్తి · Trip done</button>`;
      box.append(el);
      $('rPhone').textContent = '+' + ride.passenger_phone;
      $('rDest').textContent = '➡️ ' + placeTe(ride.destination_name).replace('\n', ' · ');
      $('rCode').textContent = 'రైడ్ కోడ్ · Ride code ' + (ride.ride_code || '');
      $('rCall').href = 'tel:+' + ride.passenger_phone;
      $('rRoute').href = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;
      $('rRoute').target = '_blank';
      $('rDone').onclick = async () => {
        const r = await callFn('complete', ride.ride_id);
        if (r.ok) { ride = null; KA && KA.allowSleep().catch(() => {}); toast(T.done); render(); } else toast(T.net);
      };
    }
  }

  $('duty').addEventListener('click', async () => {
    unlockAudio();
    if (onDuty && ride) { toast(T.finishFirst); return; }
    const want = !onDuty;
    try {
      if (want) {
        if (LN) await LN.requestPermissions().catch(() => {});
        await startGps();
      } else {
        stopGps();
      }
      const status = await rpc('set_duty_self', { p_on: want });
      onDuty = status !== 'OFFLINE';
      if (!onDuty) closeAlert();
      render();
    } catch (e) { toast(T.net); }
  });

  // ---------- GPS ----------
  async function startGps() {
    if (watcherId || geoWatch !== null) return;
    if (BG) {
      watcherId = await BG.addWatcher({
        backgroundTitle: 'Fingertip — డ్యూటీలో ఉన్నారు',
        backgroundMessage: 'రైడ్‌ల కోసం మీ లొకేషన్ పంపుతున్నాం · Sharing location for rides',
        requestPermissions: true, stale: false, distanceFilter: 25,
      }, (loc, err) => {
        if (err) { if (err.code === 'NOT_AUTHORIZED') { toast(T.noGps); BG.openSettings && BG.openSettings(); } return; }
        if (loc) onFix(loc.latitude, loc.longitude);
      });
    } else if (navigator.geolocation) {
      geoWatch = navigator.geolocation.watchPosition((p) => onFix(p.coords.latitude, p.coords.longitude),
        () => toast(T.noGps), { enableHighAccuracy: true, maximumAge: 10000 });
    }
    clearInterval(hbTimer);
    hbTimer = setInterval(() => { if (lastFix && onDuty) sendBeat(); }, HEARTBEAT_MS);
  }
  function stopGps() {
    if (watcherId && BG) BG.removeWatcher({ id: watcherId }).catch(() => {});
    if (geoWatch !== null && navigator.geolocation) navigator.geolocation.clearWatch(geoWatch);
    watcherId = null; geoWatch = null; clearInterval(hbTimer);
  }
  function onFix(lat, lng) {
    lastFix = { lat, lng };
    const moved = lastSentFix ? metres(lastSentFix, lastFix) : Infinity;
    if (Date.now() - lastSentAt > HEARTBEAT_MS || moved > 100) sendBeat();
  }
  async function sendBeat() {
    if (!lastFix) return;
    const fix = lastFix; lastSentAt = Date.now();
    try {
      await rpc('driver_heartbeat_self', { p_lat: fix.lat, p_lng: fix.lng });
      lastSentFix = fix;
      $('gpsText').textContent = `✅ ${new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })} · ${fix.lat.toFixed(4)}, ${fix.lng.toFixed(4)}`;
    } catch (e) { lastSentAt = 0; $('gpsText').textContent = '⚠️ ' + T.net; }
  }

  // ---------- ride alerts: Realtime + polling backup ----------
  function subscribe() {
    if (channel || !sb.channel) return;
    channel = sb.channel('pings-' + me.id)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'driver_pings', filter: 'driver_id=eq.' + me.id }, (p) => {
        const r = p.new; if (!r) return;
        if (p.eventType === 'INSERT' && r.ping_status === 'SENT') openAlert(r);
        else if (alertP && r.ride_id === alertP.ride_id && !['SENT', 'ACCEPTED'].includes(r.ping_status) && !accepting)
          closeAlert(r.ping_status === 'TAKEN' ? T.taken : T.closed);
      })
      .subscribe();
  }
  function startPolling() {
    clearInterval(pollTimer); clearInterval(ridePollTimer);
    pollTimer = setInterval(poll, POLL_MS);
    ridePollTimer = setInterval(pollRide, RIDE_POLL_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { poll(); pollRide(); } });
  }
  async function poll() {
    if (!me || !onDuty || ride || accepting) return;
    try {
      const p = await rpc('driver_open_ping_self');
      if (p && !alertP && !skipped.has(p.ride_id)) openAlert(p);
      else if (alertP && (!p || p.ride_id !== alertP.ride_id)) closeAlert(T.closed);
    } catch (e) { /* offline: try next tick */ }
  }
  async function pollRide() {
    if (!me || !ride) return;
    try {
      const r = await rpc('driver_current_ride_self');
      if (!r) { ride = null; toast(T.cancelled); KA && KA.allowSleep().catch(() => {}); render(); }
    } catch (e) { /* offline */ }
  }

  function openAlert(p) {
    if (alertP || ride || skipped.has(p.ride_id) || new Date(p.expires_at).getTime() <= Date.now()) return;
    alertP = p;
    $('aKm').textContent = Number(p.distance_km).toFixed(1) + ' కి.మీ.';
    $('aDest').textContent = '➡️ ' + placeTe(p.destination_name);
    $('alert').classList.add('on');
    KA && KA.keepAwake().catch(() => {});
    if (document.hidden && LN) {
      LN.schedule({ notifications: [{ id: Math.floor(Date.now() % 2e9), channelId: 'rides', title: '🔔 కొత్త రైడ్! · New ride',
        body: `${Number(p.distance_km).toFixed(1)} కి.మీ. → ${placeTe(p.destination_name).replace('\n', ' · ')}`, ongoing: false, autoCancel: true }] }).catch(() => {});
    }
    const tick = () => {
      const left = Math.max(0, Math.ceil((new Date(p.expires_at).getTime() - Date.now()) / 1000));
      $('aBar').style.width = Math.min(100, left / 30 * 100) + '%';
      $('aSec').textContent = left + ' సెకన్లు · seconds';
      if (left <= 0) { closeAlert(T.expired); return; }
      beep();
    };
    clearInterval(alertTimer); tick(); alertTimer = setInterval(tick, 1000);
  }
  function closeAlert(msg) {
    if (!alertP) return;
    alertP = null; clearInterval(alertTimer);
    $('alert').classList.remove('on');
    if (!ride) KA && KA.allowSleep().catch(() => {});
    if (msg) toast(msg);
  }

  $('aAcc').addEventListener('click', async () => {
    const p = alertP; if (!p || accepting) return;
    accepting = true; $('aAcc').disabled = true;
    try {
      const r = await callFn('accept', p.ride_id);
      alertP = p; closeAlert();
      if (r.ok) {
        ride = { ride_id: r.ride_id, ride_code: r.ride_code, passenger_phone: r.passenger_phone,
          pickup_lat: r.pickup.lat, pickup_lng: r.pickup.lng, destination_name: r.destination_name };
        KA && KA.keepAwake().catch(() => {});
        toast(T.yours); render();
      } else toast(T[r.reason] || T.net);
    } finally { accepting = false; $('aAcc').disabled = false; }
  });
  $('aSkip').addEventListener('click', async () => {
    const p = alertP; if (!p) return;
    skipped.add(p.ride_id); closeAlert();
    await callFn('decline', p.ride_id).catch(() => {});
  });

  init();
})();
