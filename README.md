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

Set up the backend environment from `backend/example.env`, including a PostgreSQL `DATABASE_URL` and `JWT_SECRET`. A TMDB API read access token in `API_AUTHORIZATION` (`Bearer …`) is optional for TV tracking: without it, show search and episode guides use TVMaze. Set up the frontend environment from `frontend/example.env`:

```bash
VITE_API_PATH=http://localhost:$PORT
```

> note that the $PORT parameter references the backend port.

Before starting the backend, apply pending additive migrations with `cd backend && npx prisma migrate deploy`. Back up existing PostgreSQL data before applying migrations. Docker Compose applies migrations automatically.

The current implementation and remaining work are tracked in [the improvement plan](docs/improvement-plan.md).

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
