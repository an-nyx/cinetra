# New-episode push notifications

Cinetra sends a Web Push notification when a regular episode of a show in your library premieres. It works in
Chrome, Edge and Firefox, and on iPhone/iPad in a Home Screen web app (iOS 16.4 or later). Nothing is sent for
movies, specials, reruns, shows marked Dropped, or episodes your saved position already covers.

## Server configuration

| Variable | Purpose |
| --- | --- |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web Push identity. Generate a pair once with `npm run vapid:generate` in `backend`. The subject is a `mailto:` address or an `https:` URL. Keep the private key server-side only; rotating it invalidates every existing subscription, so devices must enable notifications again. |
| `NOTIFICATIONS_SCHEDULER` | `enabled` runs the notifier inside the backend process. Anything else keeps it off. |
| `NOTIFICATIONS_INTERVAL_MINUTES` | How often the notifier runs (default 15, minimum 5). |

All three VAPID values must be set together; a partial or malformed set is reported in the logs at start-up and on
`/api/v1/health` (`notifications.configError`), and the app behaves as if push were not configured. In the
Terraform deployment they come from `vapid_public_key`, `vapid_private_key`, `vapid_subject`,
`notifications_scheduler` and `notifications_interval_minutes` (see `terraform/terraform.tfvars.example`).

## How a notification happens

1. **Detection.** Every pass, the notifier takes each subscribed account's shows that are linked to TMDB and not
   Dropped, verifies their TVMaze identity exactly as the Upcoming page does (TheTVDB/IMDb IDs first), and reads each
   show's TVMaze episode list (cached for 12 hours and refreshed early when TVMaze reports a change).
2. **Premiere instant.** An episode counts as premiered at its TVMaze `airstamp` when TVMaze lists an air time. When
   TVMaze gives a date only (common for streaming releases), no time is invented: the episode counts as premiered
   once that day has ended in the channel's time zone, or everywhere on Earth when TVMaze lists no zone. So a
   streaming drop can be announced up to a day late, but never early.
3. **Window.** Only premieres from the last 48 hours are considered, and never anything that premiered before the
   device subscribed (enabling notifications sends no backlog).
4. **Ledger.** One `NotificationDelivery` row per device and TVMaze episode; the database unique key makes every
   alert deliverable at most once, across restarts and concurrent workers. Right before sending, the show, episode
   and preference are re-read: watched, Dropped, removed or switched off means the row is marked `skipped`.
5. **Delivery.** 2xx from the push service is `sent`; 404/410 removes the subscription; 429/503 is retried up to
   three times; other 4xx is `failed`; no answer or another 5xx is `uncertain` and never re-sent (a missed alert is
   preferred over a duplicate). Queued alerts older than 72 hours expire.

## Wording and show posters

Alerts use short, deterministic templates chosen by the kind of release: a season or series premiere (episode 1 by
TVMaze's own numbering), a season or midseason finale (only when TMDB's cached catalog labels the same episode a
finale and its air date agrees with TVMaze's; otherwise it reads as a regular episode), or a regular episode. Show
titles are never altered; titles too long for a one-line Lock Screen title stand alone, with the event in the body.
Alerts never contain plot details or claims about where an episode can be watched.

When the saved show has a poster on TMDB (`image.tmdb.org`) or TVMaze (`static.tvmaze.com`), the alert carries it
as the notification `image`. Browsers that support large notification images (Chrome and Edge on Android, Windows,
ChromeOS and Linux) show it; Safari on iPhone, iPad and Mac, and Firefox, ignore it and show the text with the
Cinetra icon. Tapping any alert opens the show's details, poster included. Posters with query strings, other hosts
or non-HTTPS URLs are never sent.

**Preview episode alert** in the notification settings sends a clearly labelled example ("Preview · …") for one of
your own shows to this device only. Previews never touch the delivery ledger or your tracking.

## Is it working? Operational diagnostics

- `GET /api/v1/health` (public, counts and timestamps only) now has a `notifications` section: whether the
  scheduler is enabled, configured and running in this process, the interval, how many passes have run, when the
  last one ran and how long it took, when the next is due, the counts from the last pass (shows checked, verified,
  premieres in window, already watched, before opt-in, queued, sent, retry, failed, uncertain, skipped) and the last
  error, if any.
- `GET /api/v1/notifications/diagnostics` (your session only) explains your account: the scheduler state above,
  every subscribed device (subscription time, last successful delivery, failures; never the endpoint or keys), each
  saved show with whether it can alert and if not why (Dropped, no TMDB link, TVMaze identity not verified, provider
  unavailable, shared TVMaze identity), its most recent premiere and whether that counts as watched, its next listed
  episode, and the last 100 ledger rows with their status, attempts and error text.
- In the app, **Account › Notifications › Check status** shows the same information.
- The server log prints one line per pass with the same counts, and a line at start-up saying whether the scheduler
  started and why not.

If `deliveries` stays empty while `shows.recentPremieres` is zero, nothing has premiered for your eligible shows
since you subscribed; that is the expected state, not a failure. A `failed` row with `HTTP 403` or `HTTP 401` means
the push service rejected the VAPID signature (usually a key changed on the server after the device subscribed:
disable and enable notifications again on the device). A `gone` outcome removes the device record: enable
notifications on that device again.

## Verifying on an iPhone

1. Open Cinetra in Safari, tap Share, then **Add to Home Screen**. Notifications only work in the Home Screen app.
2. Open Cinetra from the Home Screen, go to Account › Notifications and tap **Enable notifications**, then allow
   the prompt. The card should read "Notifications are on for this device".
3. Tap **Send test notification**. A notification should appear within seconds, including with the app closed. If
   it does not, check Settings › Notifications › Cinetra on the phone (Allow Notifications, and the Lock Screen /
   Notification Center / Banners alert styles), and Settings › Focus for a Focus mode that silences web apps.
4. Tap **Check status**: the device should be listed with "subscribed" time, and the scheduler line should say it
   runs every 15 minutes. "Next up" shows when the next episode of your library is expected to be announced.

Real episode alerts arrive on the first scheduler pass after the premiere instant described above, so within about
15 minutes for broadcast episodes with a listed air time, and after the release day ends for date-only listings.

## Local development

- `npm run notify:run-local` in `backend` runs one pass against the local database with a mock sender (dry run) and
  prints the payloads it would send; `--send` uses real Web Push for local subscriptions. It refuses to run with
  `NODE_ENV=production` or a non-local database.
- `npm run test:notifications` in `backend` (with `DATABASE_URL` pointing at a disposable database whose name
  contains `cinetra_push_test_20261110`) exercises the rules, the ledger, concurrency, retries, a real encrypted
  push against a fake push service, the API and the diagnostics. `npm run test:notifications` in `frontend` covers
  the support detection and the settings states.
