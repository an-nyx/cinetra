# Automatic TV status reconciliation: review before activation

Automatic status writes require both `TV_STATUS_RECONCILIATION_ENABLED=true` and
a valid approved account/show/provider scope. Leave the flag absent or `false` during review.
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

After explicit approval, use the staged six-show rollout described below. Only
enrolled identities are eligible for automatic transitions. Personal Completed shows
without regular tracking remain protected; all non-enrolled rows stay unchanged.
Every write reevaluates fresh provider evidence and effective viewing coverage.
Disabling the runtime flag stops subsequent writes without reversing prior corrections.

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

The image defaults to reconciliation disabled. Runtime configuration defines the
approved scope and mutually exclusive batch/automatic modes. The release workflow
verifies the live count, scope fingerprint, flag, monitor and Web Push settings.
The final status writer independently enforces scope and fresh verified evidence.

## Unrecorded legacy completion

A personal Completed assertion without a regular checkpoint, regular EpisodeWatch,
or regular EpisodeUnwatch is not evidence of zero viewing. Preserve that status;
show actual viewing as unrecorded and do not list historical episodes as unwatched.
Specials alone do not remove this protection. This includes the legacy completed
flag without a status. Existing createdAt, updatedAt and completedMonitorFrom are
not treated as user-confirmed viewing baselines.

The review requests a completion baseline for each protected show. Users may supply
the local date and time when they had finished every then-premiered regular episode.
This becomes an explicit UTC instant in a read-only POST to
`/api/v1/show/status-preview` with `confirmedCompletionBaselines: {showId: isoInstant}`.
It neither saves that baseline nor changes status, tracking, or any other library data.
It can be removed or adjusted independently for each show. Refreshes retain it only
within the currently open review; a fresh GET forgets all supplied baselines.

Only verified regular premieres strictly after that instant may be proposed for
reopening. Earlier unrecorded episodes are excluded from gap claims without creating
or inferring watched records. The actual watched count stays unknown even after a
baseline is supplied. Announced future episodes and later rerun records do not qualify.
Conservative date-only/timezone and provider verification rules still apply.

Automatic triggers do not accept these ephemeral preview baselines and continue
preserving untracked Completed shows. Persisting confirmed baselines for future
automation is a separate change requiring authorization. Partially tracked shows
retain their ordinary effective-coverage proposals for individual review.

## Approved six-show rollout (2026-11-15)

The runtime flag alone no longer enables any automatic writes. A valid
`TV_STATUS_RECONCILIATION_SCOPE` is also required, with the approved account ID,
show IDs, canonical TMDB IDs, resolved TVMaze IDs and explicit exclusions. Missing,
malformed, duplicated, conflicting or mismatched identities fail closed. Monitoring
queries only this scope; action reconciliation and the final writer check it too.
All other shows remain outside automation, even after a first tracking action.

For an inactive scope, the release workflow selects `prepare`: it installs the approved scope from the
encrypted GitHub secret, keeps automation false and opens the account-scoped batch
endpoint. `GET /api/v1/show/status-activation` performs a fresh read-only preflight.
`POST` with its `approvalSha256` rechecks all six, locks all rows, compares approved
revisions/checkpoints/history, and atomically updates status fields only. Any conflict
aborts the entire batch. A repeated completed batch writes nothing. No baseline is
saved, and there is no general-purpose status reconciliation write endpoint.

Routine pushes preserve an already active approved scope; they cannot replace it silently.
After the batch and history comparison succeed, dispatch the same release workflow
with `mode=active`. This closes the batch endpoint and enables prospective writes for
exactly the approved six-show scope. The Docker image defaults false; runtime activation
comes from Coolify configuration and cannot widen the deployment-held scope. Every
status-writing evaluation bypasses TMDB/TVMaze stale caches, checks the resolved identity
and expires after two minutes. Preview-only legacy baseline confirmations cannot authorize
an automatic write. Provider failures preserve status.

Health reports the scope count and SHA-256 fingerprint without exposing account or show
IDs. The authenticated Review panel states how many shows are approved for automation.
No Web Push configuration, subscription, preference or delivery-ledger behavior changes.
