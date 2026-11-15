# Automatic TV status reconciliation: review before activation

Automatic status writes are disabled unless the backend environment contains exactly
`TV_STATUS_RECONCILIATION_ENABLED=true`. Leave it absent or `false` during review.
This gate covers actions, manual edits and the background status monitor. It does
not affect Web Push or its scheduler. No migration or history rewrite is needed.

The read-only endpoint is `GET /api/v1/show/status-preview`. Existing authentication
middleware supplies the user ID; clients cannot request another user's library.
The response is `Cache-Control: no-store`. Evaluation uses database reads and cached
provider lookups only; it never saves provider identities or changes library data.

In the preview-only production deployment (with the flag explicitly false),
sign into Cinetra, open Account, and choose **Automatic TV statuses → Review**.
Review both proposed directions, unchanged shows, and unverifiable shows. Each
proposal includes current/proposed status, verified released regular episode count,
effective watched count, all relevant unwatched episode identifiers and the reason.
Unknown counts are explicitly unknown, never zero. Refresh obtains a new evaluation.
There is no activation button or write endpoint in this review.

Specifically inspect The Gentlemen, The Devil’s Hour, The Rings of Power,
Tulsa King, and Mayor of Kingstown in that authenticated review. Their production
watch records and verified provider evidence are required; percentages cannot
establish their correct statuses. No production evaluation was performed as part
of local implementation. Provider outages, missing identities, season numbering
conflicts, incomplete canonical lists and checkpoint conflicts require review or
a later retry, with current status preserved.

Only after the user approves the preview may a separate authorized operation set
the flag to `true`. Then all historical Watching and Completed rows (including the
legacy completed flag) are eligible regardless of their completion/watch dates.
Proposals are reevaluated with current provider evidence and watch coverage at
execution time; a preview is not a frozen write plan. Turning the flag off stops
subsequent automatic writes. It does not reverse already approved corrections.

Local integration verification uses a disposable PostgreSQL container, never the
application database:

```sh
docker run --detach --rm --name cinetra-status-disposable \
  -e POSTGRES_PASSWORD=status-test -e POSTGRES_DB=cinetra_status_test \
  -p 127.0.0.1:55439:5432 postgres:18
cd backend
DATABASE_URL='postgresql://postgres:status-test@127.0.0.1:55439/cinetra_status_test' npx prisma db push
DATABASE_URL='postgresql://postgres:status-test@127.0.0.1:55439/cinetra_status_test' npx ts-node tests/episode-toggle.integration.test.ts
docker stop cinetra-status-disposable
```

The integration test rejects every URL except that exact disposable local target.
It stubs TMDB and TVMaze, exercising real tracking, HTTP authentication, database
transactions, historical gaps, legacy-only completion, EpisodeUnwatch exceptions,
manual edits, concurrent changes, disabled writes and read-only preview behavior.

The release workflow sets and verifies the runtime flag as `false` before deployment.
The live health response exposes `showStatus.automaticWritesEnabled: false` and
`showStatus.running: false`; disabled episode reconciliation returns immediately,
and the writer independently refuses writes. Web Push uses its existing scheduler.
