# Manual premiere-time overrides

`backend/config/release-overrides.json` holds documented release times for episodes whose providers give only a
date (most streaming releases). Overrides decide **when** an episode counts as released in Cinetra (Home, Watch Room,
Shows, My Cinema Stats, Upcoming and new-episode notifications). They never change which episode it is (TMDB season
and number stay canonical), and they never touch watched records, unwatch exceptions, saved positions, ratings or
statuses. The file is read once at startup; changes go through review and a deploy. Removing an entry (or reverting
the file) and deploying is a complete rollback.

## Order of precedence (per TMDB episode)

1. A verified TVMaze premiere with an air time (`tvmaze_exact`). An override never replaces it; a disagreeing entry
   is reported as `conflict_tvmaze_exact` (an identical one as `redundant`).
2. A valid manual override (`manual_override`).
3. TVMaze date without a time: the day has ended in the channel's time zone, or everywhere on Earth.
4. TMDB date fallback: D+1 12:00 UTC (the day has ended everywhere on Earth).

## Never

- Never add an entry from a platform's *usual* schedule ("Apple releases at 9 pm ET", "Netflix at midnight PT").
- Never add an entry without a source that states the time for this episode, or an official season-wide schedule.
- When sources disagree, add nothing (the conservative fallback stays in force).

## Format (version 1)

```json
{
  "version": 1,
  "overrides": [
    {
      "id": "example-show-s02e05",
      "tmdbId": 12345, "show": "Example Show", "season": 2, "episode": 5,
      "releaseLocal": "2026-11-24T18:00", "timeZone": "America/Los_Angeles",
      "tmdbAirDate": "2026-11-25",
      "source": { "url": "https://…", "publisher": "Example Studio press site", "scope": "episode" },
      "verifiedAt": "2026-11-21"
    },
    {
      "id": "example-show-s03",
      "tmdbId": 12345, "show": "Example Show", "season": 3,
      "episodes": { "from": 1, "to": 8 },
      "localTime": "21:00", "timeZone": "America/New_York", "localDay": "tmdb_date",
      "tmdbAirDates": { "from": "2027-01-07", "to": "2027-02-25" },
      "source": { "url": "https://…", "publisher": "Example Network press release", "scope": "season" },
      "verifiedAt": "2026-12-01"
    }
  ]
}
```

| Field | Rule |
|---|---|
| `id` | Unique, 3–64 lowercase letters, digits or dashes. |
| `tmdbId`, `season`, `episode` / `episodes` | Canonical TMDB identity. Exactly one of `episode` (one episode) or `episodes` (range). |
| `releaseLocal` | Episode form: local `YYYY-MM-DDTHH:MM`, no offset. |
| `localTime`, `localDay` | Season form: `HH:MM` on the TMDB date (`tmdb_date`) or the day before (`day_before_tmdb_date`). |
| `timeZone` | IANA name (`America/New_York`, `Europe/Paris`, `UTC`). Abbreviations (EST, PST, ET) are refused. |
| `tmdbAirDate` | Episode form: the TMDB date the entry was checked against. If TMDB changes it, the entry is **stale** and ignored. |
| `tmdbAirDates` | Season form: the TMDB date range the source covers (at most one year). Episodes outside it are untouched. |
| `source` | `url` (https), `publisher`, `scope` (`episode` or `season`; season entries need `season`), optional `description`. |
| `verifiedAt` | When the source was checked; not in the future. |

Unknown fields, missing fields and invalid values reject the entry (never partially applied). Conflicts reject every
entry involved: duplicate ids, two entries for one episode, season entries with overlapping episode and date ranges.
An episode entry inside a season entry is allowed and wins for that episode.

## Time zones and daylight saving

Local times are converted with the IANA rules for that date. A local time that does not exist (spring-forward gap) or
happens twice (fall-back overlap) is rejected for that date rather than guessed; state such releases in UTC.

## The TMDB-date guard (why a "day before" release is safe)

A TMDB air date D is a calendar date in some unstated time zone. Real zones span UTC−12 to UTC+14, so D is the local
date somewhere on Earth exactly during [D−1 10:00Z, D+1 12:00Z). An override instant is accepted only if:

- its local date in its own time zone is D, or
- its local date is D−1 **and** the instant is already on D in UTC (e.g. "6 pm Los Angeles on Tuesday" for a TMDB
  Wednesday is Wednesday 02:00Z: accepted).

So every accepted instant is inside D's window: never later than the conservative fallback and never before D has
begun anywhere. "9 am Los Angeles the day before" (Tuesday 17:00Z for a TMDB Wednesday) is rejected; a release that
truly happens then must be written in a time zone whose local date is D. A wrong but plausible entry can still be
early within that window, which is why every entry needs a verifiable source and review.

Additional application-time checks: if TVMaze lists the same episode on a date more than one day away from TMDB's, the
schedule is uncertain and the override is not applied (`conflict_tvmaze_date`).

## Interactions

- **Home, Watch Room, Shows, My Cinema Stats, saved positions:** all read the same per-episode release instant.
- **Upcoming:** shows the override time when TVMaze's numbering for the series is verified against TMDB; a past-dated
  release stays listed until Cinetra releases it. Otherwise Upcoming shows TVMaze's date alone.
- **Notifications:** never sent before Cinetra's release instant (with verified numbering, exactly at it). Ledger,
  de-duplication, eligibility and preferences are unchanged.
- **Automatic Watching/Completed:** overrides never trigger a status change. Statuses still require TVMaze's own
  premiere verification *and* Cinetra's release instant, so a status can lag availability but never lead it.

## Monitoring

`GET /api/v1/health` → `releaseOverrides`: whether the file is present, valid/rejected entries with reasons, and how
cached catalogs applied entries (`applied`, `redundant`, `conflict_tvmaze_exact`, `conflict_tvmaze_date`,
`stale_tmdb_date`, `outside_tmdb_date`, `nonexistent_local_time`, `ambiguous_local_time`, `no_tmdb_date`,
`no_matching_episode`).
