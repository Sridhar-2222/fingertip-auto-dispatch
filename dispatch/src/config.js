// All settings come from environment variables (see .env.example).
// Never commit real values.
const env = process.env;

function required(name) {
  const v = env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

export function loadConfig() {
  return {
    port: Number(env.PORT || 3000),
    publicBaseUrl: env.PUBLIC_BASE_URL || 'https://fingertip.in',

    databaseUrl: required('DATABASE_URL'),

    // Supabase project URL + anon key, only used to verify driver app logins
    supabaseUrl: env.SUPABASE_URL || '',
    supabaseAnonKey: env.SUPABASE_ANON_KEY || '',

    whatsapp: {
      token: required('WA_ACCESS_TOKEN'),
      phoneNumberId: required('WA_PHONE_NUMBER_ID'),
      appSecret: required('WA_APP_SECRET'),
      verifyToken: required('WA_VERIFY_TOKEN'),
      graphVersion: env.WA_GRAPH_VERSION || 'v23.0',
    },

    sarvam: {
      apiKey: required('SARVAM_API_KEY'),
      model: env.SARVAM_MODEL || 'saaras:v4',
    },

    // Optional pre-recorded Telugu voice notes (public https .ogg/.mp3 links)
    audio: {
      askLocation: env.AUDIO_ASK_LOCATION_URL || '',
      confirmed: env.AUDIO_CONFIRMED_URL || '',
      noAuto: env.AUDIO_NO_AUTO_URL || '',
    },

    // Optional: FCM HTTP v1 to wake the driver app. JSON of a service account.
    fcmServiceAccountJson: env.FCM_SERVICE_ACCOUNT_JSON || '',

    // Optional: Exotel call only when the WhatsApp outcome wasn't read in time
    exotel: {
      sid: env.EXOTEL_SID || '',
      apiKey: env.EXOTEL_API_KEY || '',
      apiToken: env.EXOTEL_API_TOKEN || '',
      subdomain: env.EXOTEL_SUBDOMAIN || 'api.exotel.com',
      callerId: env.EXOTEL_CALLER_ID || '',
      flowUrlConfirmed: env.EXOTEL_FLOW_URL_CONFIRMED || '',
      flowUrlNoAuto: env.EXOTEL_FLOW_URL_NO_AUTO || '',
    },
  };
}
