// Exotel fallback call — used ONLY when the passenger hasn't read the
// WhatsApp outcome message within read_fallback_seconds.
// The call connects the passenger to an Exotel flow (built in the Exotel
// dashboard) that plays the matching pre-recorded Telugu clip.
export function createExotel(cfg, fetchImpl = fetch, log = console) {
  const enabled = cfg.sid && cfg.apiKey && cfg.apiToken && cfg.callerId;
  return {
    enabled: Boolean(enabled),
    async call(passengerPhone, outcome /* 'CONFIRMED' | 'NO_AUTO' */) {
      const flowUrl = outcome === 'CONFIRMED' ? cfg.flowUrlConfirmed : cfg.flowUrlNoAuto;
      if (!enabled || !flowUrl) {
        log.info?.(`[exotel disabled] would call ${passengerPhone.slice(0, 4)}…${passengerPhone.slice(-2)} (${outcome})`);
        return false;
      }
      const auth = Buffer.from(`${cfg.apiKey}:${cfg.apiToken}`).toString('base64');
      const res = await fetchImpl(`https://${cfg.subdomain}/v1/Accounts/${cfg.sid}/Calls/connect.json`, {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ From: `0${passengerPhone.slice(2)}`, CallerId: cfg.callerId, Url: flowUrl, TimeLimit: '60' }),
      });
      if (!res.ok) throw new Error(`Exotel call failed ${res.status}: ${await res.text()}`);
      return true;
    },
  };
}
