# Home featured-show stability

The jump came from Home's optimistic update clearing nextEpisode before saving.
canContinueWatching requires nextEpisode, so homeDashboard immediately removed the
current show from the playable list and promoted another. The successful tracking
refetch made the original eligible again. This was a selection change, not a
component key/remount problem. Unsequenced dashboard reads could also overwrite
newer progress, and the shared tracking cache could reuse a read started during a
write.

Home now retains confirmed tracking while saving, disables repeat actions, and
applies fresh server progress and the next episode together. It retains the current
featured ID across ranking changes only while that show remains playable. A
generation guard ignores older reads and invalidates work on unmount. Reads during
writes are skipped; the post-write read bypasses the shared tracking cache.
Failed writes leave confirmed data unchanged. Failed post-save reads retain the card
and block repeat marking until Refresh dashboard succeeds.

No episodes, counts, statuses, or next episode numbers are guessed locally.
The existing episode write endpoint, server status reconciliation, and Web Push
remain authoritative.

Regression coverage in frontend/tests/home-dashboard.test.mjs includes delayed
writes/refreshes, stale reads, duplicate taps, save/refresh failures, unmounting,
ranking changes, and genuine loss of eligibility. A local 390px browser check
with two fixture shows and a delayed write observed the same featured DOM node
through S01E06/50% -> Updating -> S01E07/60%, with no intervening alternate card.
