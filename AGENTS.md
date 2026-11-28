# Fingertip Auto Dispatch — rules for every helper

- Owner: Sridhar. Pilot: Karimnagar–Kothirampur. Start with SETUP.md.
- Passengers book on WhatsApp +91 78424 49808. That number already runs the Rx Fingertip bot
  (repo Sridhar-2222/rx-at-your-fingertips, whatsapp/smooth-responder-vN). Owner decision 25 Nov 2026:
  auto booking is ADDED to that bot as a module (same number). The stand-alone Edge Function in
  supabase/functions/dispatch must therefore NOT be connected to that number's webhook; its driver
  routes (/driver/accept|decline|complete) and /notify can still be used.
- No fares anywhere (owner decision): passenger and driver settle the fare themselves.
- Nothing medicine-related on WhatsApp (Rx Fingertip hard rule 00). Rides only.
- Telugu first, then English. Big taps, voice. Every action in 1–2 taps or one spoken sentence.
- Never deploy, publish, run migrations on the live Supabase, or delete anything without the owner's written OK.
- No secrets in code or chats. The driver app uses only the publishable/anon key.
- Tests: supabase/tests (local Postgres only), supabase/functions/dispatch/dispatch_test.ts (Deno),
  android-driver/test (browser). Never run test files against the live project.
- Drivers in WhatsApp (28 Nov 2026, owner: "they finish completing ride through chat bot"): migration 20261128060000_whatsapp_drivers adds the auto_wa_driver_* functions (service role only) used by bot smooth-responder v25 (Rx Fingertip repo, drivers.ts). A driver is a `drivers` row whose phone is the WhatsApp number; online = `wa_online_until` (dispatch_settings.wa_online_hours, default 4), WhatsApp offers wait wa_accept_seconds (default 90). The driver never receives the passenger PIN. Not applied to the live project until the owner says so. Local test: supabase/tests/03_whatsapp_drivers.sql.
