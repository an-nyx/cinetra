# Effective viewing progress audit — local only

Home and Shows no longer present raw legacy checkpoints as current progress.
Home shows effective watched/released counts alongside its existing next episode
and percentage. Shows shows percentage and watched/released counts, with a
separate next unwatched episode or viewing-state label. Unverified progress is
not replaced by guessed counts or a raw checkpoint. Checkpoint-conflict messages
remain available for review without representing the checkpoint as current viewing.

The calculation audit traced tracking-summary.model.ts, legacy-progress.model.ts,
the library/detail/guide readers, and episode watch/unwatch writes. Effective
coverage is the union of explicit watch records and checkpoint coverage after
subtracting unwatch exceptions. Explicit records are counted once even where
they overlap checkpoints. Next episode is the first released unwatched regular
episode in season/episode order, not the last watch plus one. Future episodes and
specials are excluded from released progress. Unreliable metadata or unresolved
checkpoints withhold percentages/next-episode guesses. The write path maintains
watch and unwatch rows as mutually exclusive.

No calculation defect was found in supported states. New regression coverage
checks a mixed two-season example with overlap and a reopened gap, restoration
across a season boundary, unchanged input history/checkpoints, and 108 combinations
against an independent set specification. Existing tracking, automatic-status,
metadata, season-progress and audit suites passed.

A SELECT-only transaction with SET TRANSACTION READ ONLY inspected the configured
local database: 8 shows, 5 nonzero checkpoints, 115 individual watch records,
0 unwatch exceptions, and 0 simultaneous watch/unwatch conflicts. One genuine
checkpoint inconsistency was found: The Bear has seasonsWatched=0 and
episodesWatched=4, with one individual watch record. That checkpoint cannot map to
regular episodes (seasons start at 1). It was not corrected. This is a local
data finding, not a production-library audit, and does not establish a reliable
percentage for that show without complete episode metadata.

Local validation: frontend TypeScript, targeted lint, library tests and build;
backend test:tracking plus the extended legacy-progress test; 390px browser
fixture with effective 4/8 watched, next S01E01 despite checkpoint S01E03,
and a caught-up 8/8 card. No legacy label or horizontal page overflow appeared.

No backend runtime calculation, checkpoint, history, automatic-status rule, or
Web Push behavior changed. No deployment performed.
