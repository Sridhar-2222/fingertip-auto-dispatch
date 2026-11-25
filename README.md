# Fingertip Auto Dispatch

**Start with [SETUP.md](SETUP.md).** Passengers book on WhatsApp; drivers use the Android app; everything runs on your own Supabase.

```
supabase/
  migrations/20261125120000_auto_dispatch.sql   ← database + dispatch rules (run first)
  migrations/20261125150000_standalone_app.sql  ← driver pairing, app actions, 5-second timer (run second)
  functions/dispatch/index.ts                   ← WhatsApp bot + driver actions (Supabase Edge Function)
  functions/dispatch/dispatch_test.ts           ← tests (local only)
  tests/                                        ← local test files — never run these on Supabase
android-driver/                                 ← Fingertip Driver Android app (Capacitor)
  www/                                          ← the app's screens and logic
  android/                                      ← Android project (built by GitHub Actions)
  test/                                         ← browser test + local stand-in for Supabase
.github/workflows/build-driver-apk.yml          ← builds the APK on GitHub for free
dispatch/                                       ← older Node.js server version (only if you ever want a VPS instead of the Edge Function)
```

---

## Original Week 1 notes (Node.js server version)

# Fingertip Auto Dispatch — Week 1

WhatsApp **+91 78424 49808** → Telugu voice note → nearest free autos within 3 km → first driver to accept gets the ride → passenger gets driver details on WhatsApp.

Rides only. Nothing medicine-related goes through WhatsApp: if someone sends an image or document, the bot replies that this number is only for autos.

```
supabase/
  migrations/20261125120000_auto_dispatch.sql   ← review, then run on Supabase
  tests/00_local_supabase_stub.sql              ← local testing only, never run on Supabase
  tests/01_dispatch_rules.sql                   ← local testing only
dispatch/                                       ← Node webhook server for the VPS
  src/  test/  .env.example
```

## What's in here

**Database (all rules live in SQL, one transaction per action)**
- `drivers`, `ride_requests`, `driver_pings`, plus `dispatch_settings` (all timings in one row) and `processed_messages` (stops Meta's retries from being handled twice).
- Settings: 3 km radius, GPS counts only if it's under 3 minutes old, one 30-second window for beep, timeout and expiry, up to 5 drivers alerted, phone call if WhatsApp isn't read in 20 s.
- **First accept wins.** The ride row is locked while an accept is checked, and an accept fails if the driver is already BUSY. A unique index also blocks one driver holding two live rides. Tested 100 times with 5 drivers accepting at once: always exactly one winner.
- **Passenger link** uses a 36-character random token. The 4-digit ride code is only for reading aloud and gives no access.
- **Row level security:** nothing is readable by default. Drivers can read only their own row and their own alerts, which is what Supabase Realtime needs. Alerts include distance and destination, but not the passenger's phone or pin. Those go to the winning driver only.

**Webhook server (`dispatch/`)**
- Checks Meta's signature, replies 200 straight away, then does the work.
- Voice note → Sarvam `saaras:v4` (`te-IN`) → landmark matcher (fixed word list, no AI). If nothing matches, the passenger gets a tap list of the 6 places.
- WhatsApp's one-tap "send location" button. A pin sent without a voice note works too.
- Searching / confirmed / no-auto messages are **Telugu first**, then English. Confirmed also sends the driver as a contact card. Optional pre-recorded voice notes.
- Worker every 2 s closes rides nobody accepted. Every 5 s it places an Exotel call only for outcome messages that weren't read in 20 s. Both are off until configured.
- Driver API: `POST /driver/rides/:id/accept | decline | complete` (Bearer = driver's Supabase login).
- Passenger API: `GET /api/r/:token`, `POST /api/r/:token/cancel`.
- FCM wake-up for the driver app (`RIDE_ALERT`, `RIDE_TAKEN`, `RIDE_EXPIRED`, `RIDE_CANCELLED`). Off until configured.

## Before running anything on Supabase

1. Read the migration. It only **creates** new tables and functions. It doesn't change or drop anything that already exists. Check that the table names (`drivers`, `ride_requests`, `driver_pings`) don't clash with tables already in your Supabase project.
2. Run it in the Supabase SQL editor, or with `supabase db push`.

## Run on the VPS

```bash
cd dispatch
cp .env.example .env      # fill in on the server — don't paste secrets into chat
npm install --omit=dev
npm start                 # or run under pm2 / systemd
```
Meta webhook URL: `https://<your-domain>/webhook`, verify token = `WA_VERIFY_TOKEN`. Subscribe to `messages` (this covers delivery and read statuses too).

## Tests (local throwaway Postgres + PostGIS)

```bash
createdb fingertip_test
psql fingertip_test -f supabase/tests/00_local_supabase_stub.sql \
                    -f supabase/migrations/20261125120000_auto_dispatch.sql \
                    -f supabase/tests/01_dispatch_rules.sql      # 10 rule checks
cd dispatch && TEST_DATABASE_URL=postgresql://localhost/fingertip_test npm test   # 17 tests, wipes that DB
```

## Not built yet (Weeks 1–2)

- **Telugu place spellings.** `src/landmarks.js` is a first guess. In the first days, have people at the stands say each place into WhatsApp, read `raw_transcript` in `ride_requests`, and add what Sarvam actually writes.
- **Driver Android app.** Capacitor wrapper with a foreground location service (heartbeat every 60 s via `driver_heartbeat_self`), the ON/OFF DUTY toggle (`set_duty_self`), an FCM full-screen alert with a loud looping sound, and ACCEPT / SKIP calling the driver API above.
- **Passenger page** `fingertip.in/r/<token>`, reading `GET /api/r/:token`.
- **Voice clips** (ask location, confirmed, no auto) and the two Exotel flows for the fallback call.
- **Linking driver logins:** set `drivers.user_id` to each driver's Supabase auth user after they log in once.
