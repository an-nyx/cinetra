Episode toggle investigation (2026-11-16)

The old HTTP path loaded the catalog and watch records, performed the locked write,
computed a tracking summary, awaited fresh status evaluation (TMDB show + seasons,
identity and TVMaze evidence), and computed another summary. The modal then fetched
tracking, episodes and the show before displaying the changed watch state. Thus a
provider delay blocked both the acknowledgement and the visible change. No production
query trace was taken; database latency cannot be ruled out in production.

The new single-episode path validates against the server's cached catalog, commits the
same locked/idempotent transaction, and acknowledges without provider calls or summary
queries. A missing catalog returns 409 with a reload instruction; it never silently
accepts an unvalidated identity or waits for TMDB. A concurrent rematch is rejected.
The cache is populated by guide/tracking reads and existing background warmup.

Reconciliation coalesces work by user/show and repeats when actions arrive during a
pass. Existing transaction locks, evidence comparison and status compare-and-set are
retained. The periodic library monitor recovers status work after a process restart.
Watch data is committed before acknowledgement. No viewing-history, checkpoint,
notification ledger, or Web Push behavior is changed.

The modal updates the episode immediately, acquires a synchronous pending guard, and
rolls back on save failure. Provider-based refreshes run separately and cannot roll
back a successful save. Version and show guards reject obsolete refreshes. Automatic
status is polled separately; cached library summaries are invalidated after completion.
Home/library next-episode actions also update optimistically and report save failures.

Reproducible local measurements (disposable PostgreSQL, provider stubs):
- Injected 11,000ms TMDB delay: previous reconciliation gate 11,066.1ms.
- New committed HTTP episode save under that delay: 31.4ms.
- Optimistic state update with an unresolved save promise: 0.050ms.
These are controlled regression measurements, not production timings or browser paint measurements.

Run backend tests with the isolated database required by the test guard:
DATABASE_URL=postgresql://postgres:status-test@127.0.0.1:55439/cinetra_status_test npm run test:episode-toggle
Run frontend regression: npm run test:episode-toggle.

No deployment performed.

Watch Room next-episode delay (2026-11-19)

Root cause: the episode save was already fast, but the Watch Room cleared "Watch next" and only showed the new next
episode and progress after polling status reconciliation every 1.5 s until it finished, then refetching the summary
and guide. Reconciliation always reads TMDB and TVMaze fresh (show, every season, identity, schedule), and TVMaze calls
share one process-wide throttle (18 per 10 s) with Upcoming builds and the status monitor. Each tap also fired
`tracking-updated` twice, so Home reloaded the full library twice and Upcoming refetched twice.

Fix: the save response now includes the confirmed summary and that season's guide, built from the committed rows and
the catalog the save was validated against (no provider call). The Watch Room shows the following episode and
progress immediately when the loaded season makes it certain (otherwise "Updating next episode…"), replaces it with the
confirmed summary, and rolls back on failure. Confirmed summaries patch Home, Continue watching and the show cards in
place through one event. A monotonic per-tab clock prevents an older save or an earlier library read from overwriting
newer progress. Reconciliation is still polled, off the critical path, and reloads only when the status changed.

Local measurements (40-show library, TMDB 250 ms and TVMaze 300 ms per request, Chromium with iPhone 14 emulation):
- Watch Room next episode + progress visible: 3,160-3,170 ms before, 14-16 ms after (first frame after the tap).
- With a cold Upcoming build competing for TVMaze, reconciliation took 19.9 s; before, "Watch next" stayed empty for
  the whole 15 s sample window; after, the UI was unaffected (14 ms).
- Home behind the Watch Room: ~80 ms before (full library reload) and ~60-80 ms after (patched from the save response).
- Requests per Watch Room tap: 12 before, 4 after (1 save + 3 lightweight reconciliation polls).
- Home "Mark next watched": 3 requests before (save, /show, /show/tracking), 1 after.
