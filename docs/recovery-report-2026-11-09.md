# Cinetra progress recovery investigation — 2026-11-09

## Read-only comparison

The 2026-10-31 SQL file was parsed as text. It was never executed or imported. The backup has 158 `Show` rows, all for one user. The live database has 159 shows. All 158 backup `Show.id` values match live rows, and every matched `seasonsWatched` and `episodesWatched` value is identical. The extra live show is retained. No title matching or provider ID matching is required; the historical dump predates those IDs. There are 127 backup shows with a nonzero saved counter and 31 with both counters zero. The live database has the same 127 nonzero positions, 18 `EpisodeWatch` rows across 4 shows, and 158 null statuses plus one `completed` status. No live `planned`, `paused`, or `dropped` statuses were found. 158 live shows lack both provider IDs.

| Recovery measure | Count |
| --- | ---: |
| Backup shows | 158 |
| Live shows | 159 |
| Recoverable saved positions already present | 127 |
| Backup shows with no saved position | 31 |
| Changed or conflicting saved counters | 0 |
| Ambiguous identifier matches | 0 |
| Proposed production row changes | 0 |

Examples: `The Last Ship` is `5` full seasons plus `10` episodes in the next season in both the dump and live database. `The Witcher` is `5` plus `0` in both. These are saved counters, not a verified episode-by-episode watch log.

## Schema and semantics

The backup's `public."Show"` columns are `id`, `name`, `overview`, `posterURL`, `seasonsWatched`, `episodesWatched`, `completed`, `favorite`, `userId`, `createdAt`, `updatedAt`. The current schema retains all of these and adds `tmdbId`, `tvmazeId`, and `status`. The newer `public."EpisodeWatch"` stores `showId`, `season`, `episode`, and `watchedAt`. The 2026-11-08 migrations added episode watches and provider IDs without dropping the old counters.

The old UI explicitly labelled the controls “Seasons Watched” and “Episodes Watched” and stored independent numeric counters. The new import implementation interprets them as complete seasons plus episodes of the next season, but the old UI did not validate episode metadata or encode a definitive “last watched episode” or “next to watch” choice. Thus the counters preserve a viewing position but do not prove that each earlier episode was watched. The application must not generate `EpisodeWatch` records from them. `completed` and `favorite` are independent legacy fields. `status` did not exist in the dump.

## Application diagnosis and repair

The new tracking summary derived percentage and next episode only from `EpisodeWatch` and provider catalogs, ignoring saved counters. Missing TVMaze matches or provider errors caused the entire summary request to fail, hiding progress controls. `Upcoming` fetched show guides in serial batches of four. The frontend also waited for a separate library request before rendering releases. The repair preserves counters visibly, provides a manual position editor, reports unavailable percentages when the watch history is insufficient, keeps a progress section when guide metadata fails, disables the unsafe counter-to-watch import, and increases provider batch concurrency with shorter timeouts and longer catalog caching. The status selector exposes Watching and Completed while preserving any legacy status until deliberately changed.

## Production safety checkpoint

A fresh custom-format `pg_dump` is stored outside the repository at `/Users/anix/Developer/cinetra-recovery/current-2026-11-09.dump` with mode 0600. SHA-256: `a7d4603faa87a063d5960dc77fc1d6bc7287eb5a9fbb3a33a2d20caa3aa6557b`. The archive was restored into a disposable PostgreSQL 18 container and row counts verified: 159 shows, 18 episode watches, 1 user, 15 movies, 0 movie watches.

The recovery dry run compares backup and live rows on `(userId, Show.id)`, checks both counters, and reports **zero changes**. No production migration is needed or approved. If a future comparison finds differences, preserve current rows and watches, report each conflict, and only update a counter where no newer progress exists after explicit approval. Make any such operation transactional and idempotent. Rollback would restore only counters changed by that transaction from its before-image; the full database dump is a disaster recovery fallback, never an automatic import.

## Verification limits

The authenticated deployed API and real mobile device were not available to this repair session. The local frontend was exercised against a mock API at 320, 375, 390 and 1280 px. Live production data was read and backed up only. A controlled cold comparison of the Upcoming service against eight shows in a disposable restored database took 917 ms with the previous code and 792 ms with the repaired code (zero failed guides in both). This is a small, local sample with sequential measurements and possible provider connection warming; it does not establish the speed of the full 159-show production request. Deployed mobile performance remains to be validated.

## Follow up provider and legacy position audit

A later read-only provider review queried all 159 live show titles against TMDB and TVMaze. Coverage is 158 without TMDB IDs, 159 without TVMaze IDs, and 158 without either ID. The backup predates both provider ID columns. Git history and the original add flow show that Cinetra used TMDB search for new entries; stored poster URLs use TMDB's `/image/t/p/w500/` image host. Poster paths are image identifiers and cannot recover a TMDB show ID on their own.

Candidate comparison yielded 49 single exact-title candidates with strong overview overlap, 92 ambiguous candidates, and 18 with no exact match or a provider error. The show schema has no release-year field, and no saved poster path matched a TMDB search result strongly enough to serve as an independent ID confirmation. No candidate IDs were saved. A further episode-guide check of the 49 stronger candidates found 15 whose counters equal the provider's listed final-season episode count and whose current provider status is Ended. These are candidates for human review only: provider status and title/overview similarity do not establish that the series has no announced continuation or that the provider match is exact.

The counter convention is: `S02E08` means eight episodes reached in Season 2; if that equals the season's regular-episode count, normalize the position to the following season's episode 1. `S03E00` normalizes to the same current position. Normalization never edits source counters or creates episode-watch records. When metadata is absent, the raw saved season and episode remain visible and percentages stay unavailable.

Current implementation preserves provider IDs and personal statuses unless a user explicitly links a provider result from the details view. The existing details view has a provider search fallback; a dedicated review queue with year and poster comparison for every unmatched show remains outstanding. Automatic personal-status completion is intentionally not implemented.

## Provider review queue implementation

A protected `/review-matches` page is available from the desktop sidebar and mobile navigation. It prioritizes shows with saved counters, searches TMDB for each selected library title, and presents the existing record beside up to eight TMDB results with poster, year, overview, and match guidance. Search Again supports a different query. Skip and Confirm Match create durable browser-local drafts. Confirm shows the library title and exact TMDB ID/name/year, then stages the decision in local storage; it does not call a production write endpoint. Existing shows and all progress/status/favorite fields remain untouched. The queue can clear its local drafts. No database migration is required.

The queue is now implemented. A production ID write operation is intentionally not included; it requires explicit approval of a specific mapping set and a transactional before-image/rollback plan. TVMaze cross-provider mapping is also not inferred. A browser session must be authenticated to use the review route.
