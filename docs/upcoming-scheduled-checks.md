# Scheduled release checks for Cinetra

## Current state

The Upcoming page refreshes while a browser tab is open. Its backend reads live TMDB or TVMaze data and keeps an in-memory catalog cache for 15 minutes. There is no persisted episode release snapshot, release-check worker, Coolify scheduled task, or notification delivery path. Closing the browser stops the page's refresh timer. A later page load still fetches current provider data.

Production runs the frontend and Express backend in one Coolify application container (`terraform/main.tf`, `dockerfile`). The local Docker Compose setup also runs the app as a container. Neither deployment declares a recurring release-check command.

## Supported deployment path

Coolify Scheduled Tasks can run a command inside a running application container on a cron schedule. For this project, a task such as `node dist/src/jobs/check-releases.js` could run every six hours while the app container is running. Coolify records execution history and supports a manual **Execute now** run. The task would use the app's existing database and provider environment variables.

The command must first be implemented to:

1. Read tracked shows from PostgreSQL in small batches, using their stored TMDB or TVMaze IDs.
2. Fetch current episode schedules with rate limits and retry handling.
3. Upsert episode metadata keyed by show, season, and episode; retain prior air dates to detect new, delayed, and rescheduled releases.
4. Record a per-show check time. Treat the first check as a baseline so older episodes do not generate false new-release alerts.
5. Insert deduplicated notification records only for newly released, unwatched episodes after the baseline.
6. Expose those records to authenticated users and add browser push delivery only after push subscriptions and delivery are implemented.

The job should be idempotent and use a database lease or lock if multiple app instances or overlapping schedules are possible. A scheduled command that only calls the current Upcoming endpoint would not persist release changes or notify users.

Before enabling a production schedule, run the command inside the deployed container, inspect its database changes, use Coolify **Execute now**, and verify scheduled execution history. No background notifications are implemented or verified in the current application.

References: [Coolify application scheduled tasks](https://coolify.io/docs/applications/operations/scheduled-tasks), [Coolify scheduled task setup](https://coolify.io/docs/core/automation/scheduled-tasks/create-a-task).
