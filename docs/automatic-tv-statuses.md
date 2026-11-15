# Full-library TV status reconciliation — approved production activation

Current statuses: Watching, Completed and Dropped. Only Watching and Completed are
managed. Dropped never changes automatically. Old six-show scope and activation
operations are retired; the historical batch endpoint returns 410.

Watching becomes Completed when all verified released regular episodes are effectively
watched and the latest released season has finished airing. Completed reopens for
verified premiered regular episode gaps in recorded coverage. Old checkpoints,
explicit watches and unwatch exceptions count; specials/season zero do not.
Future announced seasons never trigger a change or block completion. Missing or
contradictory metadata preserves status. No recent-watch restriction applies.

Unrecorded legacy manual completions are protected. The new protection marker survives
the first watch action. Its migration backfills metadata only, without changing
statuses, checkpoints, viewing records or row revision dates. No completion baseline
or watched records are invented. Manual edits and season/episode actions preserve it.

Read-only review is in Account → Automatic TV statuses → Review and authenticated
GET /api/v1/show/status-preview. Optional POST preview baseline confirmations remain
ephemeral. All eligible library shows are evaluated, without a six-show allowlist.

Writes require BOTH TV_STATUS_RECONCILIATION_MODE=full-library and
TV_STATUS_RECONCILIATION_ENABLED=true. Image defaults: review/false. Existing six-show
settings cannot activate the new mode. The approved deployment workflow runs status and Web Push integration checks in isolated
databases, deploys the tested revision, then updates only these two runtime settings
using the existing Coolify GitHub secrets and redeploys. It checks deployment completion,
the production revision, a completed status monitor pass and a fresh Web Push scheduler
pass. Any failed check fails the workflow; credentials are never printed or regenerated.

Future writes retain fresh metadata and transactional revision/coverage guards.
Web Push configuration, subscriptions, ledger and scheduler are untouched.
