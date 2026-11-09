# TMDB association approval summary

Status: prepared only; no production updates have been executed.

- Library shows checked: 159.
- Existing TMDB associations: 1 (kept unchanged).
- Independently revalidated new matches ready to propose: 90.
- Uncertain or unmatched shows left alone: 68.
- Duplicate proposed TMDB IDs: 0.
- Conflicts with current TMDB IDs: 0.
- Proposed production rows to update: 90 existing rows.
- Fields changed: `Show.tmdbId` only.
- Legacy season/episode counters, `EpisodeWatch`, statuses, completion flags, favorites, and show IDs are not changed.

Validation re-fetches each TMDB record by ID and requires an exact title/original title, exact saved TMDB poster path, overview overlap of at least 0.55, and no duplicate/current-ID conflict. The saved library has no release year to compare; TMDB premiere years are recorded in the row-level validation report. All 90 passed this conservative gate.

Progress metadata exceptions among matched shows with nonzero legacy progress: 50 have provider episode metadata that supports the saved position; 20 do not include the saved season; 1 exceeds the current TMDB season episode count (`The Book of Boba Fett`, saved S1E8, TMDB lists 7). These cases do not reject the identity match. Their counters are preserved and the tracker must leave unresolved positions visible without fabricating watch records. Of 71 high-confidence progress rows in the original report, revalidation indicates 50 calculable, 20 metadata-missing, 1 inconsistent.

## Dry run and application gate

Run `backend/scripts/apply-tmdb-matches.ts docs/tmdb-match-revalidation.json` for a read-only preview. It checks that all rows still exist with the expected name and null TMDB ID and checks database unique-ID conflicts. Application requires both `--apply`, a fresh verified backup path in `TMDB_PREWRITE_BACKUP`, and `TMDB_MATCH_APPROVAL="APPROVE <SHA-256 of the exact revalidation report>"`. Any changed row or conflict aborts the full transaction.

Before approval, create and restore-test a fresh database dump, verify its SHA-256 and row counts, review the exact 90-row apply plan in `tmdb-match-apply-plan.json`, and approve its report hash. The revalidation report hash is `59cd2ce9c32ce46588a03c618a005c5604527e8b67a11a62f5ecf71cff672767`.

Rollback is transactional: set `Show.tmdbId` to null for each listed show only when it still equals the applied TMDB ID in the apply plan. Abort rollback if any row no longer matches. The full verified dump is disaster recovery only and should not be restored over a live database for routine rollback.
