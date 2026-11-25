import crypto from 'node:crypto';

// Meta WhatsApp Cloud API client (only what dispatch needs).
export function createWhatsApp({ token, phoneNumberId, appSecret, graphVersion }, fetchImpl = fetch) {
  const base = `https://graph.facebook.com/${graphVersion}`;

  async function send(to, payload) {
    const res = await fetchImpl(`${base}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, ...payload }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`WhatsApp send failed ${res.status}: ${JSON.stringify(body.error || body)}`);
    return body.messages?.[0]?.id || null;   // wamid
  }

  return {
    // X-Hub-Signature-256 check on the raw request body
    verifySignature(rawBody, header) {
      if (!header || !header.startsWith('sha256=')) return false;
      const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
      const got = header.slice(7);
      return got.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(expected, 'hex'));
    },

    sendText: (to, text) => send(to, { type: 'text', text: { body: text, preview_url: true } }),

    // Opens the phone's own "send location" picker in one tap
    sendLocationRequest: (to, text) => send(to, {
      type: 'interactive',
      interactive: { type: 'location_request_message', body: { text }, action: { name: 'send_location' } },
    }),

    // rows: [{ id, title (≤24 chars), description (≤72) }]
    sendList: (to, body, button, rows) => send(to, {
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: body },
        action: { button, sections: [{ title: 'Destinations', rows }] },
      },
    }),

    sendAudio: (to, link) => send(to, { type: 'audio', audio: { link } }),

    sendContact: (to, { name, phone }) => send(to, {
      type: 'contacts',
      contacts: [{
        name: { formatted_name: name, first_name: name },
        phones: [{ phone: `+${phone}`, type: 'CELL', wa_id: phone }],
      }],
    }),

    async downloadMedia(mediaId) {
      const meta = await fetchImpl(`${base}/${mediaId}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!meta.ok) throw new Error(`Media lookup failed ${meta.status}`);
      const { url, mime_type } = await meta.json();
      const file = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!file.ok) throw new Error(`Media download failed ${file.status}`);
      return { buffer: Buffer.from(await file.arrayBuffer()), mimeType: mime_type || 'audio/ogg' };
    },
  };
}
