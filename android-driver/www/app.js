// Fingertip Auto — one Android app for passengers and auto drivers (Capacitor).
// Sign-in: phone + 6-digit code once → a private device key kept on this phone.
// Every call goes to database functions auto_* with that key (no anonymous login).
// Voice: the phone speaks alerts in Telugu; drivers can say "సరే / OK" or "వద్దు / no";
// passengers say where they want to go.
(() => {
  'use strict';
  const CFG = window.FINGERTIP_CONFIG || {};
  const P = (window.Capacitor && window.Capacitor.Plugins) || {};
  const BG = P.BackgroundGeolocation, LN = P.LocalNotifications, KA = P.KeepAwake;
  const TTS = P.TextToSpeech, SR = P.SpeechRecognition;
  const API = (CFG.SUPABASE_URL || '').replace(/\/+$/, '') + '/rest/v1/rpc/';
  const HEARTBEAT_MS = 60000, POLL_MS = 3000;
  const STORE = 'rxf-auto-device';

  // Places on the Karimnagar–Kothirampur pilot corridor, with words people say for them
  const PLACES = {
    KOTHIRAMPUR: { te: 'కోతిరాంపూర్', en: 'Kothirampur', say: ['కోతిరాంపూర్', 'కోతిరాంపుర్', 'కొత్తిరాంపూర్', 'kothirampur', 'kothi rampur'] },
    ALGUNUR: { te: 'అలుగునూరు', en: 'Algunur', say: ['అలుగునూరు', 'అలుగునూర్', 'అల్గునూర్', 'algunur', 'alugunur'] },
    BUS_STAND: { te: 'కరీంనగర్ బస్ స్టాండ్', en: 'Karimnagar Bus Stand', say: ['బస్ స్టాండ్', 'బస్టాండ్', 'బస్సు స్టాండ్', 'bus stand', 'bus stop', 'bustand'] },
    CIVIL_HOSPITAL: { te: 'సివిల్ హాస్పిటల్', en: 'Civil Hospital', say: ['సివిల్ హాస్పిటల్', 'సివిల్ ఆసుపత్రి', 'ప్రభుత్వ ఆసుపత్రి', 'ఆసుపత్రి', 'హాస్పిటల్', 'civil hospital', 'hospital'] },
    KAMAN: { te: 'కమాన్', en: 'Kaman', say: ['కమాన్', 'కమాను', 'kaman', 'kamaan'] },
    HUSNABAD: { te: 'హుస్నాబాద్', en: 'Husnabad', say: ['హుస్నాబాద్', 'హుస్నాబాదు', 'husnabad'] },
  };
  const YES = ['సరే', 'సరి', 'ఓకే', 'ఒకే', 'అంగీకర', 'తీసుకుంట', 'తీసుకో', 'హా', 'అవును', 'ok', 'okay', 'accept', 'yes', 'haa', 'sare', 'sari'];
  const NO = ['వద్దు', 'వద్ద', 'వొద్దు', 'కాదు', 'లేదు', 'no', 'skip', 'vaddu', 'nahi', 'nako'];

  const T = {
    taken: 'ఈ రైడ్ వేరే డ్రైవర్ తీసుకున్నారు · Ride already taken',
    closed: 'ఈ రైడ్ ముగిసింది · This ride has closed',
    expired: 'సమయం అయిపోయింది · Time is up',
    cancelled: 'ప్రయాణికుడు రైడ్ రద్దు చేశారు · Passenger cancelled the ride',
    driver_not_available: 'మీరు ఇప్పటికే ఒక రైడ్‌లో ఉన్నారు · You are already on a ride',
    not_pinged: 'ఈ రైడ్ మీకు పంపలేదు · This ride was not sent to you',
    net: 'ఇంటర్నెట్ లేదు, మళ్ళీ ప్రయత్నించండి · No internet, try again',
    finishFirst: 'ముందు రైడ్ పూర్తి చేయండి · Finish the ride first',
    yours: '✅ రైడ్ మీది! ప్రయాణికుడి వద్దకు వెళ్ళండి · Ride is yours!',
    done: 'ట్రిప్ పూర్తయింది · Trip done',
    started: '▶️ ట్రిప్ ప్రారంభమైంది · Trip started',
    wrongCode: 'కోడ్ తప్పు. మిగిలిన ప్రయత్నాలు · Wrong code. Tries left',
    codeLocked: 'చాలా సార్లు తప్పు. 15 నిమిషాల తర్వాత · Too many wrong tries. Wait 15 minutes',
    not_started: 'ముందు ప్రయాణికుడి కోడ్‌తో ట్రిప్ ప్రారంభించండి · Start the trip with the passenger\'s code first',
    needCode: 'ప్రయాణికుడు చెప్పిన 4 అంకెల PIN ఇవ్వండి · Enter the 4-digit PIN the passenger tells you',
    noGps: 'GPS అనుమతి ఇవ్వండి · Please allow location',
    noMic: 'మైక్ అనుమతి ఇవ్వండి లేదా ప్లేస్ ఎంచుకోండి · Allow the microphone, or pick a place',
    notHeard: 'వినిపించలేదు, మళ్ళీ చెప్పండి · Did not catch that, please try again',
    no_location: 'మీ లొకేషన్ దొరకలేదు · Could not get your location',
    already_booked: 'మీకు ఇప్పటికే ఒక రైడ్ ఉంది · You already have a ride',
    no_destination: 'ఎక్కడికి వెళ్ళాలో చెప్పండి · Say where you want to go',
  };
  const PAIR_ERR = {
    wrong_code: 'కోడ్ తప్పు · Wrong code', unknown_phone: 'ఈ నంబర్ నమోదు కాలేదు · This number is not registered',
    locked: 'చాలా సార్లు తప్పు. Fingertip ని సంప్రదించండి · Too many tries — contact Fingertip',
  };

  const $ = (id) => document.getElementById(id);
  // Spoken code -> 4 digits ('నాలుగు ఎనిమిది రెండు ఒకటి', 'four eight two one' or '4821'); '' if not found.
  const NUM_WORDS = { 'సున్నా': 0, 'సున్న': 0, 'ఒకటి': 1, 'ఒక': 1, 'రెండు': 2, 'మూడు': 3, 'నాలుగు': 4, 'ఐదు': 5, 'అయిదు': 5,
    'ఆరు': 6, 'ఏడు': 7, 'ఎనిమిది': 8, 'తొమ్మిది': 9, zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
  function codeFromSpeech(text) {
    for (const alt of String(text || '').split('|')) {
      const d = alt.toLowerCase().split(/[\s,.-]+/).map((w) => (w in NUM_WORDS ? String(NUM_WORDS[w]) : w.replace(/\D/g, ''))).join('');
      if (d.length === 4) return d;
    }
    return '';
  }
  let dev = null; // { key, role, name }
  let pendingRole = null;

  // ---------- small helpers ----------
  function show(id) { document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('on', s.id === 's-' + id)); }
  function toast(t) { const el = $('toast'); el.textContent = t; el.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('on'), 4000); }
  async function rpc(fn, args) {
    const res = await fetch(API + fn, {
      method: 'POST',
      // Name the schema on every call: the server's default schema is not 'public' (26 Nov 2026), so calls without it 404.
      headers: { 'Content-Type': 'application/json', apikey: CFG.SUPABASE_ANON_KEY, 'Content-Profile': 'public', 'Accept-Profile': 'public' },
      body: JSON.stringify(args || {}),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }
  function loadDev() { try { return JSON.parse(localStorage.getItem(STORE) || 'null'); } catch (e) { return null; } }
  function saveDev(d) { try { d ? localStorage.setItem(STORE, JSON.stringify(d)) : localStorage.removeItem(STORE); } catch (e) { /* ignore */ } }
  const metres = (a, b) => { const R = 6371000, r = Math.PI / 180, x = (b.lng - a.lng) * r * Math.cos((a.lat + b.lat) * r / 2), y = (b.lat - a.lat) * r; return Math.hypot(x, y) * R; };
  const kmSay = (km) => { const n = Number(km); return n < 1 ? `${Math.round(n * 1000)} మీటర్ల` : `${n.toFixed(1)} కిలోమీటర్ల`; };
  function placeOf(v) { return PLACES[v] || null; }
  function placeLabel(v) { const p = placeOf(v); return p ? `${p.te} · ${p.en}` : (v || '—'); }
  function placeSay(v) { const p = placeOf(v); return p ? p.te : (v || ''); }
  function matchPlace(text) {
    const t = (text || '').toLowerCase();
    for (const [k, p] of Object.entries(PLACES)) if (p.say.some((w) => t.includes(w.toLowerCase()))) return k;
    return null;
  }
  const hasWord = (text, words) => { const t = ' ' + (text || '').toLowerCase() + ' '; return words.some((w) => t.includes(w.toLowerCase())); };
  function openMap(lat, lng) {
    const a = document.createElement('a');
    a.href = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;
    a.target = '_blank'; a.rel = 'noopener'; document.body.append(a); a.click(); a.remove();
  }

  // ---------- sound and voice ----------
  let actx = null;
  function unlockAudio() { try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); actx.resume(); } catch (e) { /* no audio */ } }
  function beep() {
    if (!actx) return;
    try {
      [0, 0.22, 0.44].forEach((t, i) => { const o = actx.createOscillator(), g = actx.createGain(); o.type = 'square'; o.frequency.value = i === 1 ? 1320 : 880; g.gain.value = 0.25; o.connect(g); g.connect(actx.destination); o.start(actx.currentTime + t); o.stop(actx.currentTime + t + 0.18); });
      navigator.vibrate && navigator.vibrate([400, 150, 400]);
    } catch (e) { /* ignore */ }
  }
  let teVoice = null; // null = unknown, true/false after the first check
  async function speak(te, en) {
    try {
      if (TTS) {
        if (teVoice === null) teVoice = await TTS.isLanguageSupported({ lang: 'te-IN' }).then((r) => !!r.supported).catch(() => false);
        await TTS.speak({ text: teVoice ? te : (en || te), lang: teVoice ? 'te-IN' : 'en-IN', rate: 0.95 });
        return;
      }
      if (window.speechSynthesis) {
        await new Promise((res) => {
          const u = new SpeechSynthesisUtterance(te); u.lang = 'te-IN'; u.rate = 0.95;
          u.onend = res; u.onerror = res; window.speechSynthesis.cancel(); window.speechSynthesis.speak(u);
          setTimeout(res, 12000);
        });
      }
    } catch (e) { /* voice is a help, never a blocker */ }
  }
  function stopSpeaking() { try { TTS ? TTS.stop() : window.speechSynthesis && window.speechSynthesis.cancel(); } catch (e) { /* ignore */ } }
  let micOk = null;
  async function micReady() {
    if (micOk !== null) return micOk;
    try {
      if (SR) {
        const a = await SR.available(); if (!a.available) return (micOk = false);
        let st = await SR.checkPermissions().catch(() => ({}));
        if (st.speechRecognition !== 'granted') st = await SR.requestPermissions();
        return (micOk = st.speechRecognition === 'granted');
      }
      return (micOk = !!(window.SpeechRecognition || window.webkitSpeechRecognition));
    } catch (e) { return (micOk = false); }
  }
  // Listen once; resolves with all the phrases heard ('' if nothing).
  async function listen(prompt) {
    if (!(await micReady())) return null;
    try {
      if (SR) {
        const r = await SR.start({ language: 'te-IN', maxResults: 5, prompt, partialResults: false, popup: false });
        return ((r && r.matches) || []).join(' | ');
      }
      const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
      return await new Promise((res) => {
        const rec = new Rec(); rec.lang = 'te-IN'; rec.maxAlternatives = 5;
        let got = '';
        rec.onresult = (e) => { got = Array.from(e.results[0]).map((a) => a.transcript).join(' | '); };
        rec.onend = () => res(got); rec.onerror = () => res(got);
        rec.start(); setTimeout(() => { try { rec.stop(); } catch (e) { /* */ } }, 7000);
      });
    } catch (e) { return ''; }
  }
  function stopListening() { try { SR && SR.stop(); } catch (e) { /* ignore */ } }

  // ---------- start ----------
  async function init() {
    if (!CFG.SUPABASE_URL || /YOUR-/.test(CFG.SUPABASE_URL + CFG.SUPABASE_ANON_KEY)) return show('setup');
    dev = loadDev();
    if (!dev || !dev.key) return show('role');
    show('loading');
    try {
      if (dev.role === 'driver') await Driver.start(); else await Passenger.start();
      $('menuBtn').hidden = false;
    } catch (e) {
      $('errText').textContent = (e && e.message) || 'Could not connect.';
      show('error');
    }
  }
  function signOut() { Driver.stop(); Passenger.stop(); saveDev(null); dev = null; $('menuBtn').hidden = true; $('hName').textContent = 'Fingertip ఆటో'; $('hSub').textContent = 'Fingertip Auto'; show('role'); }
  $('retry').addEventListener('click', init);
  $('menuBtn').addEventListener('click', () => {
    if (dev && dev.role === 'driver' && Driver.busy()) { toast(T.finishFirst); return; }
    if (confirm('ఈ ఫోన్ నుండి బయటకు వెళ్ళాలా? కొత్త కోడ్ అవసరం.\nSign out of this phone? You will need a new code.')) signOut();
  });

  // ---------- role + pairing ----------
  document.querySelectorAll('[data-role]').forEach((b) => b.addEventListener('click', () => {
    unlockAudio();
    pendingRole = b.dataset.role;
    $('pRole').textContent = pendingRole === 'driver' ? '🛺 ఆటో డ్రైవర్ · Auto driver' : '🧍 ప్రయాణికుడు · Passenger';
    $('pErr').textContent = '';
    $('pWa').hidden = pendingRole !== 'passenger';
    show('pair');
  }));
  $('pBack').addEventListener('click', () => show('role'));
  $('pairForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('pErr').textContent = ''; $('pBtn').disabled = true;
    try {
      const r = await rpc('auto_pair', { p_role: pendingRole, p_phone: $('pPhone').value.trim(), p_code: $('pCode').value.trim() });
      if (!r || !r.ok) { $('pErr').textContent = PAIR_ERR[r && r.reason] || T.net; return; }
      dev = { key: r.key, role: r.role, name: r.name }; saveDev(dev);
      $('pCode').value = '';
      await init();
    } catch (err) { $('pErr').textContent = T.net; }
    finally { $('pBtn').disabled = false; }
  });

  // =====================================================================
  // DRIVER
  // =====================================================================
  const Driver = (() => {
    let me = null, onDuty = false, ride = null, alertP = null, accepting = false, voiceLoop = 0;
    let watcherId = null, geoWatch = null, lastFix = null, lastSentAt = 0, lastSentFix = null;
    let hbTimer = null, pollTimer = null, alertTimer = null;
    const skipped = new Set();
    // Quick messages with the passenger during a ride (ride_messages; WhatsApp passengers get them on WhatsApp).
    let msgs = [], msgRide = null;
    const QUICK = [
      ['✅ వచ్చేశాను', "I've arrived"], ['⏱ 2 నిమిషాల్లో వస్తాను', 'Coming in 2 minutes'],
      ['🚦 ట్రాఫిక్‌లో ఉన్నాను', "I'm in traffic"], ['📍 మీ లొకేషన్ పంపండి', 'Please send your location'],
      ['📞 కాల్ చేస్తాను', "I'll call you"],
    ];

    async function start() {
      const r = await rpc('auto_driver_me', { p_key: dev.key });
      if (!r || !r.ok) { signOut(); toast('మళ్ళీ చేరండి · Please join again'); return; }
      me = r;
      $('hName').textContent = `${me.name_te || me.name} · ${me.name}`;
      $('hSub').textContent = '🛺 ' + me.auto_number;
      onDuty = me.status !== 'OFFLINE';
      if (LN) LN.createChannel({ id: 'rides', name: 'Ride alerts', description: 'New ride requests', importance: 5, visibility: 1, vibration: true }).catch(() => {});
      show('main');
      await poll();
      render();
      clearInterval(pollTimer); pollTimer = setInterval(poll, POLL_MS);
      if (onDuty) startGps();
    }
    function stop() {
      clearInterval(pollTimer); pollTimer = null; stopGps(); closeAlert(); me = null; ride = null;
    }

    function render() {
      const d = $('duty');
      d.className = 'duty ' + (onDuty ? 'on' : 'off');
      d.setAttribute('aria-pressed', String(onDuty));
      d.innerHTML = onDuty
        ? '🟢 డ్యూటీలో ఉన్నాను<small>ON DUTY · ఆఫ్ చేయడానికి నొక్కండి</small>'
        : '⚪ ఆఫ్ డ్యూటీ<small>OFF DUTY · డ్యూటీ ప్రారంభించడానికి నొక్కండి</small>';
      $('stTitle').textContent = !onDuty ? '😴 డ్యూటీ ఆఫ్' : ride ? '🛺 రైడ్‌లో ఉన్నారు' : '⏳ రైడ్‌ల కోసం వేచి ఉన్నాం';
      $('stText').textContent = !onDuty ? 'డ్యూటీ ఆన్ చేస్తేనే రైడ్‌లు వస్తాయి. Turn on duty to get rides.'
        : 'ఫోన్ జేబులో ఉన్నా 6 కి.మీ. లోపల రైడ్ వస్తే అలర్ట్ వస్తుంది. You get an alert for rides within 6 km, even with the phone in your pocket.';
      const box = $('rideBox');
      box.textContent = '';
      if (!ride) return;
      const el = document.createElement('div'); el.className = 'ride';
      el.innerHTML = `<h2>🧍 ప్రయాణికుడిని పికప్ చేయండి · Pick up</h2>
        <div class="big" id="rPhone"></div><div id="rDest"></div>
        <div class="row" style="margin-top:10px"><a class="btn solid" id="rCall">📞 కాల్ · Call</a><button class="btn" id="rRoute">🗺️ దారి · Route</button></div>
        <button class="btn" id="rSay" style="margin-top:10px">🔊 మళ్ళీ వినండి · Hear again</button>
        <div class="msgs" id="rMsgs" aria-live="polite"></div>
        <div class="quick" id="rQuick"></div>
        ${ride.started ? `<div class="big" style="margin-top:10px">${T.started}</div>
        <button class="btn solid" id="rDone" style="margin-top:10px">✅ ట్రిప్ పూర్తి · Trip done</button>`
        : `<label style="display:block;margin-top:12px">🔐 ప్రయాణికుడి PIN · Passenger's PIN
          <input id="rCodeIn" inputmode="numeric" autocomplete="off" maxlength="4" placeholder="••••" style="width:100%;text-align:center;letter-spacing:.4em"></label>
        <div class="row" style="margin-top:10px"><button class="btn" id="rCodeMic">🎤 కోడ్ చెప్పండి · Say code</button><button class="btn solid" id="rStart">▶️ ట్రిప్ ప్రారంభం · Start trip</button></div>`}`;
      box.append(el);
      $('rPhone').textContent = '+' + ride.passenger_phone;
      $('rDest').textContent = '➡️ ' + placeLabel(ride.destination_name);
      $('rCall').href = 'tel:+' + ride.passenger_phone;
      $('rRoute').onclick = () => openMap(ride.pickup_lat, ride.pickup_lng);
      $('rSay').onclick = () => sayPickup(null);
      const q = $('rQuick');
      q.innerHTML = '<div class="muted">💬 ప్రయాణికుడికి చెప్పండి · Tell the passenger</div>';
      QUICK.forEach(([te, en]) => {
        const b = document.createElement('button'); b.className = 'btn qbtn'; b.textContent = `${te} · ${en}`;
        b.onclick = () => sendQuick(`${te} · ${en}`); q.append(b);
      });
      renderMsgs();
      if (!ride.started) {
        const inp = $('rCodeIn');
        inp.oninput = () => { inp.value = inp.value.replace(/\D/g, '').slice(0, 4); };
        $('rStart').onclick = () => startTrip(inp.value);
        $('rCodeMic').onclick = async () => {
          unlockAudio();
          await speak('ప్రయాణికుడి కోడ్ చెప్పండి.', 'Say the passenger\'s code.');
          const heard = await listen('కోడ్ చెప్పండి · Say the code');
          if (heard === null) { toast(T.noMic); return; }
          const c = codeFromSpeech(heard);
          if (!c) { toast(T.notHeard); return; }
          inp.value = c; startTrip(c);
        };
        return;
      }
      $('rDone').onclick = async () => {
        try {
          const r = await rpc('auto_driver_done', { p_key: dev.key, p_ride_id: ride.ride_id });
          if (r.ok) { ride = null; KA && KA.allowSleep().catch(() => {}); toast(T.done); speak('ట్రిప్ పూర్తయింది. కొత్త రైడ్‌ల కోసం వేచి ఉన్నాం.', 'Trip done. Waiting for new rides.'); render(); }
          else toast(T[r.reason] || T.net);
        } catch (e) { toast(T.net); }
      };
    }
    // Pickup: the passenger tells the code shown on their phone; the driver types or says it.
    async function startTrip(code) {
      if (!ride || !/^\d{4}$/.test(code || '')) { toast(T.needCode); return; }
      try {
        const r = await rpc('auto_driver_start', { p_key: dev.key, p_ride_id: ride.ride_id, p_code: code });
        if (r.ok) { ride.started = true; toast(T.started); speak('కోడ్ సరైనది. ట్రిప్ ప్రారంభమైంది.', 'Code correct. Trip started.'); render(); }
        else if (r.reason === 'wrong') { toast(`${T.wrongCode}: ${r.left}`); speak('కోడ్ తప్పు. మళ్ళీ అడగండి.', 'Wrong code. Ask again.'); }
        else if (r.reason === 'locked') toast(T.codeLocked);
        else toast(T.net);
      } catch (e) { toast(T.net); }
    }
    async function sendQuick(body) {
      if (!ride) return;
      try {
        const r = await rpc('auto_driver_say', { p_key: dev.key, p_body: body });
        if (r.ok) { msgs.push({ id: 'me' + Date.now(), from: 'driver', body }); renderMsgs(); toast('✅ పంపాం · Sent'); }
        else toast(r.reason === 'too_many' ? 'చాలా మెసేజ్‌లు. కాల్ చేయండి · Too many messages, please call' : T.net);
      } catch (e) { toast(T.net); }
    }
    function renderMsgs() {
      const box = $('rMsgs'); if (!box) return;
      box.textContent = '';
      msgs.slice(-6).forEach((m) => {
        const el = document.createElement('div'); el.className = 'msg ' + (m.from === 'driver' ? 'me' : 'them');
        el.textContent = (m.from === 'driver' ? '🛺 మీరు · You: ' : '🧍 ప్రయాణికుడు · Passenger: ') + m.body;
        box.append(el);
      });
    }
    // Every poll while a ride is on: new passenger messages are shown, beeped and read aloud.
    async function pollMsgs() {
      if (!ride) { msgs = []; msgRide = null; return; }
      if (msgRide !== ride.ride_id) { msgs = []; msgRide = ride.ride_id; }
      try {
        const r = await rpc('auto_driver_messages', { p_key: dev.key });
        if (!r || !r.ok || !Array.isArray(r.messages)) return;
        const known = new Set(msgs.filter((m) => typeof m.id === 'number').map((m) => m.id));
        const fresh = r.messages.filter((m) => !known.has(m.id));
        msgs = r.messages.slice();
        renderMsgs();
        const news = fresh.filter((m) => m.from === 'passenger');
        if (news.length) {
          beep();
          const last = news[news.length - 1].body;
          toast('💬 ' + last);
          speak(`ప్రయాణికుడి మెసేజ్: ${last.split(' · ')[0]}`, `Message from the passenger: ${last}`);
        }
      } catch (e) { /* offline: try next tick */ }
    }
    function sayPickup(km) {
      if (!ride) return Promise.resolve();
      const dist = km != null ? `ప్రయాణికుడు ${kmSay(km)} దూరంలో ఉన్నారు. ` : '';
      return speak(`రైడ్ మీది. ${dist}${placeSay(ride.destination_name)} కి వెళ్ళాలి. దారి చూపిస్తున్నాం.`,
        `The ride is yours. ${km != null ? 'Passenger is ' + Number(km).toFixed(1) + ' kilometres away. ' : ''}Opening the route.`);
    }

    $('duty').addEventListener('click', async () => {
      unlockAudio();
      if (!me) return;
      if (onDuty && ride) { toast(T.finishFirst); return; }
      const want = !onDuty;
      try {
        if (want) {
          if (LN) await LN.requestPermissions().catch(() => {});
          await micReady();
          await startGps();
        } else stopGps();
        const r = await rpc('auto_driver_duty', { p_key: dev.key, p_on: want });
        if (!r.ok) throw new Error(r.reason);
        onDuty = r.status !== 'OFFLINE';
        if (!onDuty) closeAlert();
        render();
        speak(onDuty ? 'డ్యూటీ ప్రారంభమైంది. రైడ్ వస్తే చెబుతాను.' : 'డ్యూటీ ఆఫ్ అయింది.', onDuty ? 'You are on duty.' : 'You are off duty.');
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
      if (!lastFix || !me) return;
      const fix = lastFix; lastSentAt = Date.now();
      try {
        const r = await rpc('auto_driver_beat', { p_key: dev.key, p_lat: fix.lat, p_lng: fix.lng });
        if (!r.ok) throw new Error(r.reason);
        lastSentFix = fix;
        $('gpsText').textContent = `✅ ${new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })} · ${fix.lat.toFixed(4)}, ${fix.lng.toFixed(4)}`;
      } catch (e) { lastSentAt = 0; $('gpsText').textContent = '⚠️ ' + T.net; }
    }

    // ---------- alerts: checked every 3 seconds ----------
    async function poll() {
      if (!me || accepting) return;
      try {
        const r = await rpc('auto_driver_poll', { p_key: dev.key });
        if (!r.ok) { if (r.reason === 'not_paired') { signOut(); toast('మళ్ళీ చేరండి · Please join again'); } return; }
        const hadRide = !!ride, wasStarted = !!(ride && ride.started);
        ride = r.ride || null;
        if (hadRide && !ride) { toast(T.cancelled); speak('ప్రయాణికుడు రైడ్ రద్దు చేశారు.', 'The passenger cancelled the ride.'); KA && KA.allowSleep().catch(() => {}); render(); }
        else if (ride && (!hadRide || ride.started !== wasStarted)) render();
        if (ride) pollMsgs(); else if (msgs.length) { msgs = []; msgRide = null; }
        const p = r.alert;
        if (onDuty && !ride && p && !alertP && !skipped.has(p.ride_id)) openAlert(p);
        else if (alertP && (!p || p.ride_id !== alertP.ride_id)) closeAlert(T.closed);
      } catch (e) { /* offline: try next tick */ }
    }

    function openAlert(p) {
      if (alertP || ride || skipped.has(p.ride_id) || new Date(p.expires_at).getTime() <= Date.now()) return;
      alertP = p;
      $('aKm').textContent = Number(p.distance_km).toFixed(1) + ' కి.మీ.';
      $('aDest').textContent = '➡️ ' + placeLabel(p.destination_name).replace(' · ', '\n');
      $('aVoice').textContent = '';
      $('alert').classList.add('on');
      KA && KA.keepAwake().catch(() => {});
      if (document.hidden && LN) {
        LN.schedule({ notifications: [{ id: Math.floor(Date.now() % 2e9), channelId: 'rides', title: '🔔 కొత్త రైడ్! · New ride',
          body: `${Number(p.distance_km).toFixed(1)} కి.మీ. → ${placeLabel(p.destination_name)}`, autoCancel: true }] }).catch(() => {});
      }
      const tick = () => {
        const left = Math.max(0, Math.ceil((new Date(p.expires_at).getTime() - Date.now()) / 1000));
        $('aBar').style.width = Math.min(100, left / 30 * 100) + '%';
        $('aSec').textContent = left + ' సెకన్లు · seconds';
        if (left <= 0) closeAlert(T.expired);
      };
      clearInterval(alertTimer); tick(); alertTimer = setInterval(tick, 1000);
      runVoice(p);
    }
    // Beep, read the ride aloud, then listen for సరే / వద్దు — repeat until answered or time is up.
    async function runVoice(p) {
      const loop = ++voiceLoop;
      const live = () => loop === voiceLoop && alertP === p;
      beep();
      let first = true;
      while (live()) {
        await speak(first
          ? `కొత్త రైడ్. ${kmSay(p.distance_km)} దూరం. ${placeSay(p.destination_name)} కి. తీసుకోవాలంటే సరే అనండి. వద్దంటే వద్దు అనండి.`
          : 'సరే లేదా వద్దు?',
          first ? `New ride, ${Number(p.distance_km).toFixed(1)} kilometres away. Say OK to accept or no to skip.` : 'OK or no?');
        first = false;
        if (!live()) return;
        $('aVoice').textContent = '🎤 వింటున్నాం… సరే / వద్దు · Listening… OK / no';
        const heard = await listen('సరే / వద్దు');
        if (!live()) return;
        if (heard === null) { $('aVoice').textContent = ''; while (live()) { beep(); await new Promise((r) => setTimeout(r, 1500)); } return; }
        if (hasWord(heard, NO)) { $('aVoice').textContent = '🗣️ వద్దు'; return skip(); }
        if (hasWord(heard, YES)) { $('aVoice').textContent = '🗣️ సరే'; return accept(); }
        $('aVoice').textContent = heard ? '❓ ' + heard.split(' | ')[0] : '';
        beep();
      }
    }
    function closeAlert(msg) {
      voiceLoop++;
      if (!alertP) return;
      alertP = null; clearInterval(alertTimer);
      stopListening(); stopSpeaking();
      $('alert').classList.remove('on');
      if (!ride) KA && KA.allowSleep().catch(() => {});
      if (msg) toast(msg);
    }
    async function accept() {
      const p = alertP; if (!p || accepting) return;
      accepting = true; $('aAcc').disabled = true;
      try {
        const r = await rpc('auto_driver_accept', { p_key: dev.key, p_ride_id: p.ride_id });
        closeAlert();
        if (r.ok) {
          ride = { ride_id: r.ride_id, started: false, passenger_phone: r.passenger_phone,
            pickup_lat: r.pickup_lat, pickup_lng: r.pickup_lng, destination_name: r.destination_name };
          KA && KA.keepAwake().catch(() => {});
          toast(T.yours); render();
          await sayPickup(p.distance_km);
          if (ride) openMap(ride.pickup_lat, ride.pickup_lng);
        } else { toast(T[r.reason] || T.net); speak(r.reason === 'taken' ? 'ఈ రైడ్ వేరే డ్రైవర్ తీసుకున్నారు.' : 'ఈ రైడ్ ముగిసింది.', 'This ride is no longer available.'); }
      } catch (e) { toast(T.net); }
      finally { accepting = false; $('aAcc').disabled = false; }
    }
    async function skip() {
      const p = alertP; if (!p) return;
      skipped.add(p.ride_id); closeAlert();
      await rpc('auto_driver_skip', { p_key: dev.key, p_ride_id: p.ride_id }).catch(() => {});
    }
    $('aAcc').addEventListener('click', accept);
    $('aSkip').addEventListener('click', skip);

    return { start, stop, busy: () => !!ride };
  })();

  // =====================================================================
  // PASSENGER
  // =====================================================================
  const Passenger = (() => {
    let me = null, said = '', place = null, timer = null, lastState = '', current = null, booking = false;

    async function start() {
      const r = await rpc('auto_passenger_me', { p_key: dev.key });
      if (!r || !r.ok) { signOut(); toast('మళ్ళీ చేరండి · Please join again'); return; }
      me = r;
      $('hName').textContent = me.name;
      $('hSub').textContent = me.pin ? `🔐 మీ PIN · Your PIN ${me.pin}` : '🧍 ప్రయాణికుడు · Passenger';
      const box = $('pPlaces'); box.textContent = '';
      for (const [k, p] of Object.entries(PLACES)) {
        const b = document.createElement('button');
        b.innerHTML = `${p.te}<br><small>${p.en}</small>`;
        b.onclick = () => { unlockAudio(); setChoice(p.te, k); };
        box.append(b);
      }
      show('pass');
      await poll();
      clearInterval(timer); timer = setInterval(poll, POLL_MS);
    }
    function stop() { clearInterval(timer); timer = null; me = null; current = null; lastState = ''; }

    function setChoice(text, key) {
      said = text; place = key;
      $('pSaid').textContent = key ? placeLabel(key) : text;
      $('pSaidBox').hidden = false;
      speak(`${key ? placeSay(key) : text} కి ఆటో బుక్ చేయాలా? బుక్ నొక్కండి.`, `Book an auto to ${key ? PLACES[key].en : text}? Tap Book.`);
    }
    $('pMic').addEventListener('click', async () => {
      unlockAudio();
      const mic = $('pMic');
      if (mic.classList.contains('listening')) return;
      await speak('ఎక్కడికి వెళ్ళాలి?', 'Where do you want to go?');
      mic.classList.add('listening');
      mic.innerHTML = '🎤 వింటున్నాం…<small>LISTENING · ఇప్పుడు చెప్పండి · speak now</small>';
      const heard = await listen('ఎక్కడికి వెళ్ళాలి?');
      mic.classList.remove('listening');
      mic.innerHTML = '🎤 ఎక్కడికి వెళ్ళాలి?<small>WHERE TO? · నొక్కి చెప్పండి · tap and speak</small>';
      if (heard === null) { toast(T.noMic); return; }
      if (!heard) { toast(T.notHeard); speak('వినిపించలేదు. మళ్ళీ చెప్పండి.', 'Sorry, please say it again.'); return; }
      const key = matchPlace(heard);
      setChoice(heard.split(' | ')[0], key);
    });
    $('pAgain').addEventListener('click', () => $('pMic').click());
    $('pGo').addEventListener('click', book);

    function getFix() {
      return new Promise((res) => {
        if (!navigator.geolocation) return res(null);
        navigator.geolocation.getCurrentPosition((p) => res({ lat: p.coords.latitude, lng: p.coords.longitude }),
          () => res(null), { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
      });
    }
    async function book() {
      if (booking) return;
      booking = true; $('pGo').disabled = true;
      try {
        toast('📍 మీ లొకేషన్ తీసుకుంటున్నాం… · Getting your location…');
        const fix = await getFix();
        if (!fix) { toast(T.noGps); speak('మీ లొకేషన్ దొరకలేదు. GPS ఆన్ చేయండి.', 'Could not get your location. Please turn on GPS.'); return; }
        const r = await rpc('auto_book', { p_key: dev.key, p_lat: fix.lat, p_lng: fix.lng, p_said: said, p_place: place || '' });
        if (!r.ok) { toast(T[r.reason] || T.net); return; }
        $('pSaidBox').hidden = true;
        await poll();
      } catch (e) { toast(T.net); }
      finally { booking = false; $('pGo').disabled = false; }
    }

    async function poll() {
      if (!me) return;
      try {
        const r = await rpc('auto_passenger_poll', { p_key: dev.key });
        if (!r.ok) { if (r.reason === 'not_paired') { signOut(); toast('మళ్ళీ చేరండి · Please join again'); } return; }
        current = r.ride; render();
      } catch (e) { /* offline */ }
    }

    function render() {
      const r = current;
      const open = r && ['SEARCHING', 'CONFIRMED', 'AWAITING_LOCATION'].includes(r.status);
      const recent = r && !open && r.closed_at && (Date.now() - new Date(r.closed_at).getTime() < 90000) && lastState !== '';
      $('pBook').hidden = !!open;
      const box = $('pRide');
      box.hidden = !(open || recent);
      const state = r ? r.ride_id + ':' + r.status + (r.started ? ':s' : '') : '';
      if (!(open || recent)) { lastState = state; return; }
      let h = '';
      if (r.status === 'SEARCHING' || r.status === 'AWAITING_LOCATION') {
        const left = r.expires_at ? Math.max(0, Math.ceil((new Date(r.expires_at).getTime() - Date.now()) / 1000)) : 30;
        h = `<div class="state"><h2>🔎 ఆటో వెతుకుతున్నాం… · Finding an auto</h2>
          <div class="said">➡️ ${esc(placeLabel(r.destination_name))}</div>
          <div class="muted">${r.drivers_alerted} డ్రైవర్లకు పంపాం · sent to ${r.drivers_alerted} driver(s) · ${left} s</div></div>
          <button class="btn" id="pCancel">❌ రద్దు · Cancel</button>`;
      } else if (r.status === 'CONFIRMED') {
        const d = r.driver || {};
        h = `<div class="state" style="background:#dcfce7;color:#14532d"><h2>✅ ఆటో వస్తోంది! · Auto is coming</h2>
          <div class="said">${esc(d.name_te || d.name || '')}<br>🛺 ${esc(d.auto_number || '')}</div>
          <div>📍 ${d.distance_km != null ? Number(d.distance_km).toFixed(1) + ' కి.మీ. దూరం · km away' : ''}</div>
          <div class="muted">➡️ ${esc(placeLabel(r.destination_name))}</div></div>
          ${r.started ? `<div class="state"><h2>▶️ ట్రిప్ ప్రారంభమైంది · Trip started</h2></div>`
          : `<div class="state" id="pCodeBox" style="text-align:center"><div>🔐 మీ PIN · Your PIN</div>
          <div id="pCode4" style="font-size:52px;font-weight:900;letter-spacing:.3em">${esc(r.ride_code)}</div>
          <div class="muted">ఆటో ఎక్కినప్పుడు ఈ PIN డ్రైవర్‌కి చెప్పండి. · Tell this PIN to the driver when you get in.</div></div>`}
          <div class="row"><a class="btn solid" href="tel:+${esc(d.phone || '')}">📞 కాల్ · Call</a><button class="btn" id="pSee">🗺️ ఆటో ఎక్కడ · Where</button></div>
          <button class="btn" id="pCancel">❌ రద్దు · Cancel</button>`;
      } else if (r.status === 'NO_AUTO') {
        h = `<div class="state"><h2>😔 ఆటో దొరకలేదు · No auto found</h2><div class="muted">దగ్గరలో ఖాళీ ఆటో లేదు. కొంచెం సేపటి తర్వాత మళ్ళీ ప్రయత్నించండి. No free auto nearby — try again in a little while.</div></div>
          <button class="btn solid" id="pOk">🔁 మళ్ళీ బుక్ · Book again</button>`;
      } else if (r.status === 'COMPLETED') {
        h = `<div class="state" style="background:#dcfce7;color:#14532d"><h2>🙏 ప్రయాణం పూర్తయింది · Trip done</h2></div><button class="btn solid" id="pOk">👍 సరే · OK</button>`;
      } else if (r.status === 'CANCELLED') {
        h = `<div class="state"><h2>❌ రైడ్ రద్దయింది · Ride cancelled</h2></div><button class="btn solid" id="pOk">👍 సరే · OK</button>`;
      }
      box.innerHTML = h;
      const c = $('pCancel'); if (c) c.onclick = cancel;
      const s = $('pSee'); if (s) s.onclick = () => { const d = r.driver; if (d && d.lat) openMap(d.lat, d.lng); };
      const o = $('pOk'); if (o) o.onclick = () => { lastState = ''; current = null; $('pRide').hidden = true; $('pBook').hidden = false; };
      if (state !== lastState) { announce(r); lastState = state; }
    }
    function announce(r) {
      const d = r.driver || {};
      if (r.status === 'SEARCHING') speak(`${placeSay(r.destination_name)} కి ఆటో వెతుకుతున్నాం. కొంచెం ఆగండి.`, 'Finding an auto for you. Please wait.');
      else if (r.status === 'CONFIRMED' && r.started) speak('ట్రిప్ ప్రారంభమైంది. సురక్షిత ప్రయాణం.', 'Trip started. Have a safe ride.');
      else if (r.status === 'CONFIRMED') speak(`ఆటో దొరికింది. ${d.name_te || d.name || ''}, ఆటో నంబర్ ${String(d.auto_number || '').split('').join(' ')}. ${d.distance_km != null ? kmSay(d.distance_km) + ' దూరంలో ఉన్నారు.' : ''} మీ PIN ${String(r.ride_code || '').split('').join(' ')}. ఆటో ఎక్కినప్పుడు డ్రైవర్‌కి చెప్పండి.`,
        `Auto found. ${d.name || ''}, auto number ${d.auto_number || ''}. Your PIN is ${String(r.ride_code || '').split('').join(' ')}.`);
      else if (r.status === 'NO_AUTO') speak('క్షమించండి, దగ్గరలో ఆటో దొరకలేదు. కొంచెం సేపటి తర్వాత మళ్ళీ ప్రయత్నించండి.', 'Sorry, no auto nearby. Please try again soon.');
      else if (r.status === 'COMPLETED') speak('ప్రయాణం పూర్తయింది. ధన్యవాదాలు.', 'Trip done. Thank you.');
    }
    async function cancel() {
      if (!confirm('రైడ్ రద్దు చేయాలా? · Cancel this ride?')) return;
      try { const r = await rpc('auto_passenger_cancel', { p_key: dev.key }); if (r.ok) { toast('❌ రద్దయింది · Cancelled'); } await poll(); }
      catch (e) { toast(T.net); }
    }
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    return { start, stop };
  })();

  init();
})();
