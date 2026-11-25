// Sarvam AI speech-to-text — the only AI step in the pipeline.
// Docs: https://docs.sarvam.ai/api-reference-docs/speech-to-text/transcribe
export function createSarvam({ apiKey, model }, fetchImpl = fetch) {
  return {
    async transcribe(buffer, mimeType = 'audio/ogg') {
      const form = new FormData();
      const ext = mimeType.includes('mpeg') ? 'mp3' : mimeType.includes('mp4') ? 'm4a' : 'ogg';
      form.append('file', new Blob([buffer], { type: mimeType.split(';')[0] }), `voice.${ext}`);
      form.append('model', model);
      form.append('language_code', 'te-IN');

      const res = await fetchImpl('https://api.sarvam.ai/speech-to-text', {
        method: 'POST',
        headers: { 'api-subscription-key': apiKey },
        body: form,
        signal: AbortSignal.timeout(15000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Sarvam STT failed ${res.status}: ${JSON.stringify(body)}`);
      return (body.transcript || '').trim();
    },
  };
}
