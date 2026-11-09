# Automatic completion dry-run status

Completion detection is implemented as a read-only classification in the tracking summary. It separates TMDB broadcast state, viewing state (`fully_watched`, `caught_up`, `in_progress`, `not_started`, or `unknown`), and personal status. It never writes `status`, `completed`, legacy counters, or `EpisodeWatch` rows. TMDB `Ended` alone is insufficient: completion also requires no announced next episode, `in_production=false`, complete regular-season metadata and air dates, and saved legacy progress or confirmed episode records covering the final released regular episode. Season zero is excluded.

A full-library completion result cannot yet be established because the separately proposed 90 TMDB associations have not been approved or applied. Current production has 159 shows, only 1 with an existing TMDB ID, and 158 without one. Unmatched records remain `unknown`; they are not assigned TMDB candidates for this dry run. The current record with an existing TMDB ID has no usable saved legacy position for a completion determination. No existing personal statuses are proposed to change on current production evidence.

After the association plan is separately approved and applied, rerun the read-only completion classification. Status changes require a separate explicit approval and a fresh verified backup.

The current production dry run is saved in `completion-dry-run.json`: 159 shows checked, 1 existing TMDB ID, 158 without TMDB IDs, 0 fully-watched/ended cases eligible for a personal-status proposal, and 1 in-progress show with an existing provider ID. The 158 unmatched shows are unknown and were not classified. The 90 validated but unapproved association proposals were not substituted into production data for this report.
