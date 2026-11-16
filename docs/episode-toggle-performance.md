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
