# Fingertip Auto Dispatch — setup on your own accounts

Passengers book on **WhatsApp (+91 78424 49808)**. Drivers use the **Fingertip Driver Android app**.
Everything runs on **your Supabase** (free plan is enough for the pilot). There's no paid server, and Claude isn't needed to run it.

```
Passenger ── WhatsApp ──► Supabase Edge Function "dispatch" ──► Supabase database (rules, 3 km search)
                                    ▲                                    │  ▲
           accept / skip / done     │                     ride alerts   │  │ duty, GPS every minute
                                    └──────── Fingertip Driver app ◄─────┘  │
                                                    └───────────────────────┘
Supabase Cron (every 5 s): closes rides nobody accepted → Edge Function tells the passenger
```

No fares anywhere: passenger and driver settle the fare themselves. Nothing medicine-related is handled on WhatsApp. Images and documents get a "this number is only for autos" reply.

> **Never paste keys, tokens or passwords into a chat.** Put them only in the Supabase dashboard, Meta dashboard or GitHub secrets as described below.

---

## 1. Supabase database (about 10 minutes)

1. Read both migration files first. They only **create** new tables and functions; nothing existing is changed or dropped. Check that `drivers`, `ride_requests` and `driver_pings` don't already exist in your project.
2. **SQL Editor → New query**: paste and run `supabase/migrations/20261125120000_auto_dispatch.sql`.
3. New query: paste and run `supabase/migrations/20261125150000_standalone_app.sql`.
   - If you see a notice "pg_cron not available", go to **Database → Extensions**, enable **pg_cron** and **pg_net**, then run the last `do $$ … $$` block of that file again.
4. **Authentication → Sign In / Providers**: turn on **Allow anonymous sign-ins**. Drivers' phones log in this way, then pair with their code (no SMS cost).

## 2. WhatsApp bot (Edge Function)

1. **Edge Functions → Deploy a new function → Via editor**. Name it exactly `dispatch`. Replace the sample code with the whole of `supabase/functions/dispatch/index.ts`, then deploy.
2. Open the function's **Details / Settings** and turn **OFF** "Enforce JWT verification". Meta can't send a Supabase login; the function checks every request itself.
3. **Edge Functions → Secrets**: add these:

   | Name | Where it comes from |
   |---|---|
   | `WA_ACCESS_TOKEN` | Meta → WhatsApp → API setup (a permanent System User token) |
   | `WA_PHONE_NUMBER_ID` | Meta → WhatsApp → API setup, for +91 78424 49808 |
   | `WA_APP_SECRET` | Meta → App settings → Basic → App secret |
   | `WA_VERIFY_TOKEN` | any long random text you make up |
   | `SARVAM_API_KEY` | Sarvam dashboard |
   | `CRON_SECRET` | another long random text you make up |

4. **SQL Editor**: store the function address and the same `CRON_SECRET` in Vault, so the 5-second timer can tell passengers "no autos". Type your own values on your screen:

   ```sql
   select vault.create_secret('https://YOUR-PROJECT-REF.supabase.co/functions/v1/dispatch', 'fingertip_function_url');
   select vault.create_secret('THE-SAME-CRON-SECRET-AS-ABOVE', 'fingertip_cron_secret');
   ```

5. **Meta → WhatsApp → Configuration → Webhook**:
   - Callback URL: `https://YOUR-PROJECT-REF.supabase.co/functions/v1/dispatch/whatsapp`
   - Verify token: your `WA_VERIFY_TOKEN`
   - Subscribe to **messages**.

Test: send "kaman" to the WhatsApp number. You should get the "send location" button.

**Costs:** voice notes longer than about 20 seconds are not sent to Sarvam (the passenger gets the tap list instead). WhatsApp replies inside the 24-hour window: the first 1,000 a month are free, then about ₹0.145 each. The timer only calls the function when a ride actually closes, so the free plan's 500,000 function calls a month is plenty.

## 3. Add drivers

**Table Editor → drivers → Insert row**:
- `name`, `name_te` (Telugu name), `auto_number`
- `phone` as `91` + 10 digits, e.g. `919812345678`

Leave everything else empty. A 6-digit **pair_code** is created automatically. Give that code to the driver in person.

- **Driver changed phone, or typed a wrong code 5 times:** set `pair_fails` to `0` and type a new 6-digit `pair_code`.
- **Remove a driver from the pilot:** set `active` to false.

## 4. Build the driver app (APK) on GitHub, free

1. Create a GitHub repository (it can be private) and upload this whole folder. Or link GitHub to Claude and ask me to push it.
2. In the repository: **Settings → Secrets and variables → Actions → New repository secret**:
   - `SUPABASE_URL` = `https://YOUR-PROJECT-REF.supabase.co`
   - `SUPABASE_ANON_KEY` = the **publishable / anon** key (Project Settings → API). **Never the service_role key.**
3. **Actions → Build driver APK → Run workflow**. After about 10 minutes, open the finished run, then **Artifacts → fingertip-driver-apk**, and download it.
4. Unzip it to get `fingertip-driver.apk`. Send it to drivers, for example on WhatsApp.

## 5. On each driver's phone (one time, at the stand)

1. Open `fingertip-driver.apk` and allow "Install unknown apps" when Android asks.
2. Open **Fingertip Driver**, then enter the phone number and 6-digit code.
3. Tap **ON DUTY**. Allow **Location** and **Notifications**.
4. **Battery:** Settings → Apps → Fingertip Driver → Battery → **Unrestricted** (on Xiaomi/Redmi, Realme, Oppo and Vivo, also turn on **Autostart**). Without this, some phones stop alerts in the pocket.
5. Test with a WhatsApp booking near the stand: the phone should beep and show ACCEPT / SKIP.

While ON DUTY, the app shows a small "Fingertip — డ్యూటీలో ఉన్నారు" notification. That's what keeps GPS and alerts working with the screen off.

---

## What's tested, and what isn't yet

Tested here against a real Postgres + PostGIS database:
- **Database rules:** 10 checks, plus 9 for the app and timer functions.
- **WhatsApp function:** 11 tests (voice, location, two drivers accepting at once, cancel by reply, all skip, timer message, long voice note cost cap, duplicates, webhook security).
- **Driver app screens:** 36 checks in Chrome, from pairing through duty, GPS, alert, accept, Call/Route, trip done, skip, "taken by another driver", passenger cancel and off duty.

**Not tested yet:**
- **APK build:** it hasn't been compiled. The workspace I built it in can't download Google's Android tools. The GitHub build is the first real compile; if it fails, send me the error from the Actions log.
- **Real phones:** it hasn't run on a physical Android phone. Try 2–3 drivers' phones before the stand rollout, especially with the screen off.
- **Live services:** the real WhatsApp, Sarvam and Supabase connections. Those can only be tried with your accounts.
