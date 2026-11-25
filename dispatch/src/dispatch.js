import { LANDMARKS, matchDestination } from './landmarks.js';
import { msg } from './messages.js';

// Core flow. All side effects are injected so tests can run it against a
// real database with fake WhatsApp / Sarvam / push / Exotel.
export function createDispatcher({ db, wa, stt, push, exotel, audio = {}, publicBaseUrl, log = console }) {
  const rideLink = (token) => `${publicBaseUrl}/r/${token}`;

  const destinationRows = () => Object.entries(LANDMARKS).map(([key, l]) => ({
    id: `dest:${key}`, title: l.te.slice(0, 24), description: l.en,
  }));

  async function askDestination(to, body = msg.askDestinationBody) {
    await wa.sendList(to, body, msg.askDestinationButton, destinationRows());
  }

  async function askLocation(to, ride) {
    await wa.sendLocationRequest(to, msg.askLocation(ride.destination_name));
    if (audio.askLocation) await wa.sendAudio(to, audio.askLocation).catch((e) => log.warn?.(e.message));
  }

  // Voice note or typed text → destination → ask for location
  async function handleSpokenOrTyped(from, transcript) {
    const match = matchDestination(transcript);
    if (!match) {
      if (transcript) await db.createRide(from, transcript, null);   // keep transcript for tuning aliases
      await askDestination(from, transcript ? msg.askDestinationBody : msg.notHeard);
      return;
    }
    const ride = await db.createRide(from, transcript, match.key);
    await askLocation(from, ride);
  }

  async function handleDestinationPick(from, key) {
    if (!LANDMARKS[key]) return askDestination(from);
    const waiting = await db.awaitingRide(from);
    const ride = waiting ? await db.setDestination(waiting.id, key) : await db.createRide(from, null, key);
    await askLocation(from, ride);
  }

  async function handleLocation(from, { latitude, longitude }) {
    let ride = await db.awaitingRide(from);
    if (!ride) {
      const open = await db.openRide(from);
      if (open?.status === 'SEARCHING') return wa.sendText(from, msg.stillSearching);
      if (open?.status === 'CONFIRMED') return wa.sendText(from, msg.alreadyConfirmed(rideLink(open.access_token)));
      ride = await db.createRide(from, null, null);   // pin without a voice note is fine
    }
    const drivers = await db.startSearch(ride.id, latitude, longitude);
    if (!drivers.length) {
      // start_search_svc already set NO_AUTO — but only if the ride was still waiting
      await notifyNoAuto(ride.id, from);
      return;
    }
    await wa.sendText(from, msg.searching(drivers.length));
    await push.send(drivers.map((d) => d.push_token).filter(Boolean), {
      kind: 'RIDE_ALERT',
      ride_id: ride.id,
      destination: ride.destination_name || '',
    });
  }

  async function notifyNoAuto(rideId, passengerPhone) {
    const wamid = await wa.sendText(passengerPhone, msg.noAuto);
    if (audio.noAuto) await wa.sendAudio(passengerPhone, audio.noAuto).catch((e) => log.warn?.(e.message));
    if (wamid) await db.setNotifyWamid(rideId, wamid);
  }

  async function notifyConfirmed(result) {
    const to = result.passenger_phone;
    const wamid = await wa.sendText(to, msg.confirmed(result, rideLink(result.access_token)));
    if (wamid) await db.setNotifyWamid(result.ride_id, wamid);
    await wa.sendContact(to, { name: `${result.driver.name} (Auto ${result.driver.auto_number})`, phone: result.driver.phone })
      .catch((e) => log.warn?.(e.message));
    if (audio.confirmed) await wa.sendAudio(to, audio.confirmed).catch((e) => log.warn?.(e.message));
  }

  // ---- Inbound webhook -------------------------------------------------
  async function handleWebhook(payload) {
    for (const entry of payload.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        for (const s of value.statuses || []) {
          if (s.status === 'read') await db.markNotifyRead(s.id);
        }
        for (const m of value.messages || []) {
          try {
            await handleMessage(m);
          } catch (e) {
            log.error?.(`message ${m.id} failed: ${e.message}`);
          }
        }
      }
    }
  }

  async function handleMessage(m) {
    if (!(await db.claimMessage(m.id))) return;   // Meta retry — already handled
    const from = m.from;
    switch (m.type) {
      case 'audio': {
        let transcript = '';
        try {
          const { buffer, mimeType } = await wa.downloadMedia(m.audio.id);
          transcript = await stt.transcribe(buffer, mimeType);
        } catch (e) {
          log.warn?.(`STT failed: ${e.message}`);
        }
        return handleSpokenOrTyped(from, transcript);
      }
      case 'text':
        return handleSpokenOrTyped(from, m.text?.body || '');
      case 'location':
        return handleLocation(from, m.location);
      case 'interactive': {
        const id = m.interactive?.list_reply?.id || m.interactive?.button_reply?.id || '';
        if (id.startsWith('dest:')) return handleDestinationPick(from, id.slice(5));
        return askDestination(from);
      }
      default:
        // images, documents, stickers… This number is for autos only.
        return wa.sendText(from, msg.ridesOnly);
    }
  }

  // ---- Driver actions (from the driver app) -----------------------------
  async function driverAccept(rideId, driver) {
    const result = await db.acceptRide(rideId, driver.id);
    if (!result?.ok) return { ok: false, reason: result?.reason, message: msg.driver[result?.reason] || '' };

    await notifyConfirmed(result);
    const others = await db.pushTokens(result.other_driver_ids);
    await push.send(others.map((o) => o.push_token), { kind: 'RIDE_TAKEN', ride_id: rideId });

    return {
      ok: true,
      ride_id: result.ride_id,
      ride_code: result.ride_code,
      passenger_phone: result.passenger_phone,
      pickup: { lat: result.pickup_lat, lng: result.pickup_lng },
      destination_name: result.destination_name,
    };
  }

  async function driverDecline(rideId, driver) {
    const r = await db.declineRide(rideId, driver.id);
    if (r?.all_declined) await notifyNoAuto(r.ride_id, r.passenger_phone);
    return { ok: true };
  }

  async function driverComplete(rideId, driver) {
    return { ok: Boolean(await db.completeRide(rideId, driver.id)) };
  }

  async function passengerCancel(token) {
    const r = await db.cancelByToken(token);
    if (!r?.ok) return { ok: false };
    if (r.driver_id) {
      const t = await db.pushTokens([r.driver_id]);
      await push.send(t.map((x) => x.push_token), { kind: 'RIDE_CANCELLED', ride_id: r.ride_id });
    }
    return { ok: true };
  }

  // ---- Background workers ------------------------------------------------
  async function expireTick() {
    const due = await db.expireDue();
    for (const r of due) {
      try {
        await notifyNoAuto(r.ride_id, r.passenger_phone);
        const t = await db.pushTokens(r.timed_out_driver_ids);
        await push.send(t.map((x) => x.push_token), { kind: 'RIDE_EXPIRED', ride_id: r.ride_id });
      } catch (e) {
        log.error?.(`expire notify ${r.ride_id}: ${e.message}`);
      }
    }
    return due.length;
  }

  async function fallbackTick() {
    if (!exotel.enabled) return 0;
    const due = await db.claimFallbackCalls();
    for (const r of due) {
      await exotel.call(r.passenger_phone, r.status).catch((e) => log.error?.(e.message));
    }
    return due.length;
  }

  return { handleWebhook, handleMessage, driverAccept, driverDecline, driverComplete, passengerCancel, expireTick, fallbackTick };
}
