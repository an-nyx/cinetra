# The Bear checkpoint review — read-only, local database

SELECT-only transaction with SET TRANSACTION READ ONLY, 2026-11-17:
- Checkpoint: seasonsWatched=0, episodesWatched=4.
- No TMDB match; personal status unset.
- One explicit watched record: S01E01, recorded 2026-11-08T20:49:46.695Z.
- No unwatch exceptions. All checkpoint-before/after fields on that watch are null.
- Show creation and last-update timestamps are both 2026-11-08T19:55:12.917Z.

The existing record supports S01E01 only. S00E04 does not establish that S01E01–04
were watched; neither the intended season nor the identity/episode catalog is
verified. This is a finding about the configured local database, not production.

Safest correction:
1. Leave the data unchanged until the intended series identity and viewing position
   are confirmed. Verify the TMDB match and episode catalog first.
2. If the user confirms “four episodes of season one”, propose a checkpoint-only
   change to S01E04. Otherwise propose the explicitly confirmed season/episode.
3. If the checkpoint was accidental, propose clearing just the checkpoint to 0/0,
   leaving S01E01's watch record and timestamp intact. That expresses explicit-only
   progress; it must not be presented as an inferred correction.
4. Before any approved correction, snapshot the show, watch and unwatch rows and
   compare the checkpoint against the reviewed value. Apply only the approved
   checkpoint fields, then verify history timestamps/records and exceptions are
   identical. Do not import a checkpoint into synthetic watch history, mark a
   season watched, or change status/notification settings to fix the label.

The ordinary checkpoint-edit endpoint currently also clears checkpoint-before/after
metadata on watch records. A strict history-preserving repair should avoid that
side effect and update only the Show checkpoint fields after explicit approval.
No repair, match change, status change, or notification action was performed.
