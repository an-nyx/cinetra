# Cinetra improvement plan

## Current architecture and behavior

- React 19, Vite, Tailwind and Radix UI render the existing homepage, show and movie libraries, detail dialogs, search dialogs, account dialog and responsive sidebar.
- Express 5 provides authenticated routes. Prisma 6 stores users, shows and movies in PostgreSQL. TMDB search is proxied through the backend.
- Before this work, show progress was only `seasonsWatched`, `episodesWatched` and `completed`; there were no episode records or TMDB IDs. Movies had favorites but no status, rating, notes or watch history.
- Existing frontend files already had uncommitted design changes. Those changes were preserved. New controls were added inside the existing dialogs using their colors, typography and components.

## Completed: data integrity and detailed tracking

- Add optional TMDB IDs to new titles, with per-user uniqueness. Older titles remain unlinked until explicitly connected.
- Add individual episode watch records with viewing dates and uniqueness by show, season and episode. Keep legacy counters unchanged. Allow episode toggling and marking aired episodes in a season as watched.
- Add optional show status, movie status, movie rating, movie notes and movie watch events. Movie watch events support rewatches.
- Add authenticated JSON export of the user's account metadata, titles and viewing history. Password hashes are excluded.
- Validate updates and reject ownership field changes, negative progress, invalid ratings and duplicate titles.
- Cache TMDB requests for five minutes and avoid logging request objects containing the API credential.
- Share one Prisma client across repositories and services to avoid unnecessary connection pools.

## Next priorities

1. Persist episode metadata and schedule background provider refreshes. Add a notification table with unique show/episode/user keys, per-show preferences, and an in-app notification center. Use a production scheduler before claiming automatic release detection.
2. Build the separate episode calendar with recently released episodes, unwatched episodes, date groups, and monthly navigation. The new Upcoming timeline handles future releases only.
4. Add movie runtime and release metadata, then calculate watch time and calendar statistics from logged events. Add charts and activity history only when all values can be derived from real data.
5. Add status and genre filters, original and translated title search, recommendations and upcoming releases with TMDB rate limiting and caching.
6. Add PWA manifest, offline shell and push subscription delivery with clear opt-in and cross-device behavior.
7. Fix the existing broad lint baseline and generated `dist` scanning; add browser regression coverage and before/after screenshots for further UI work.

## Verification and constraints

- All migrations are additive and were applied to the local PostgreSQL database after verified `pg_dump` backups. Existing user/show/movie counts stayed at 1/5/5.
- Backend build, frontend type check and production build pass. Isolated schema tests passed for episode toggling, duplicate prevention, future episode restriction, season marking, ownership, movie rewatches, rating, status, notes and export.
- The Hobi-style Phase 1 flow now derives whole-show progress from individual episode records, supports next-episode and season actions, and includes an explicit legacy-counter import. TVMaze provides real episode guides and show search when the TMDB credential is absent. The dashboard and library show next episodes, progress, and quick watched actions.
- The real-provider search, individual watched/unwatched controls, next-episode advancement, season marking, progress changes, dashboard updates, and refresh persistence were exercised in a browser with an isolated QA account that was removed afterward.
- The dedicated calendar, background release checks, in-app notifications, browser push, and metadata persistence are still outstanding. The dashboard uses live provider data on load and manual refresh; it does not claim background release detection.
- The Upcoming page now lists future episodes from the user's library on a green timeline. It displays provider air times in the browser's local time zone, date-only releases without a made-up time, dynamic countdowns, five client-side filters, premiere labels, and links into the existing show dialog. It refreshes every 16 minutes while open and on tab return. Provider catalog responses are cached for 15 minutes, and the endpoint limits provider work to four shows at once.
