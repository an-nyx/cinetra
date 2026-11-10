# Cinetra

Have you ever started a TV show and then made a long pause to come back to it but don't remember at which season or episode you stopped watching?

Have you ever had a long watchlist, and you forget which movie you wanted to watch?

Cinetra is here to provide a set of solutions for the management of your watch progress.

## Getting Started

### Prerequisites

To be able to run cinetra, you need :

* Node.js (>= 20.7.0)
* npm (>= 10.1.0)
* PostgreSQL (the included Docker Compose file uses PostgreSQL 18)

### Installation

Clone the repository :

```bash
git clone https://github.com/Yan-ni/cinetra.git
```

Change the working directory to the project directory:

```bash
cd cinetra
```

Install backend dependencies :

```bash
cd backend
npm install
```

Install frontend dependencies :

```bash
cd frontend
npm install
```

## Usage

### Configuration

Set up the backend environment from `backend/example.env`, including a PostgreSQL `DATABASE_URL` and `JWT_SECRET`. For TMDB, set either `TMDB_READ_ACCESS_TOKEN` (the API Read Access Token from TMDB; the backend adds `Bearer` when needed) or `TMDB_API_KEY` (a TMDB v3 API key). The old `API_AUTHORIZATION` Bearer-token variable remains supported for existing deployments. Keep these credentials only in the backend/Coolify runtime environment; never use a frontend `VITE_*` variable. TMDB remains Cinetra's canonical provider for show identity, search, episode tracking, progress, and statuses. TVMaze (public API, no key needed) is the only source of Upcoming release dates: each show is matched to TVMaze through the TheTVDB/IMDb IDs TMDB lists (with a strict title, premiere and synopsis fallback), unverifiable matches are listed for review, and nothing from TVMaze is persisted or used for tracking. Set up the frontend environment from `frontend/example.env`:

```bash
VITE_API_PATH=http://localhost:$PORT
```

> note that the $PORT parameter references the backend port.

Before starting the backend, apply pending additive migrations with `cd backend && npx prisma migrate deploy`. Back up existing PostgreSQL data before applying migrations. Docker Compose applies migrations automatically.

The current implementation and remaining work are tracked in [the improvement plan](docs/improvement-plan.md).

New-episode push notifications (Web Push, including iPhone Home Screen apps) are described, with their production configuration, in [docs/push-notifications.md](docs/push-notifications.md). They stay off until VAPID keys are set and `NOTIFICATIONS_SCHEDULER=enabled`.

### Running the Application

To run the application you need to run the following :

Run the backend :

```bash
cd backend
npm run dev
```

Run the frontend :

```bash
cd frontend
npm run dev
```
