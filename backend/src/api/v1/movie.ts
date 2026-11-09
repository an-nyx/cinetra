import { Router, Request, Response } from "express";
import { movieModule } from '../../modules/movie';
import { CreateMovieDto, UpdateMovieDto } from '../../modules/movie/model/movie.entity';
import { discoverMovies } from '../../services/movie-discovery.service';
import { getMovieWatches, addMovieWatch } from '../../services/movie-watch.service';

const router = Router();

router.get('/:id/watches', async (req: Request<{id: string}>, res: Response) => {
  try {
    const watches = await getMovieWatches(req.params.id, req.user.id);
    if (!watches) res.status(404).json({ message: 'Movie not found' });
    else res.json(watches);
  } catch (error) { console.error(error); res.status(500).json({ message: 'Internal server error' }); }
});

router.post('/:id/watches', async (req: Request<{id: string}>, res: Response) => {
  const watchedAt = req.body?.watchedAt ? new Date(req.body.watchedAt) : new Date();
  if (Number.isNaN(watchedAt.getTime()) || watchedAt.getTime() > Date.now()) {
    res.status(400).json({ message: 'Invalid viewing date' }); return;
  }
  try {
    const watch = await addMovieWatch(req.params.id, req.user.id, watchedAt);
    if (!watch) res.status(404).json({ message: 'Movie not found' });
    else res.status(201).json(watch);
  } catch (error) { console.error(error); res.status(500).json({ message: 'Internal server error' }); }
});

router.get("/search", async (req: Request, res: Response) => {
  const query = req.query.q as string;
  
  try {
    const results = await movieModule.Queries.SearchQuery.execute(query);
    res.json(results);
  } catch (error) {
    res.status(502).json({ message: "TMDB search unavailable. Check the API credential." });
  }
});

// Read-only, keyed by this user's saved IDs. Builds outside the request so Home never waits for TMDB.
const discovery = new Map<string, { signature: string; until: number; result?: Awaited<ReturnType<typeof discoverMovies>>; running?: Promise<void> }>();
router.get('/upcoming', async (req: Request, res: Response) => {
  try {
    const movies = await movieModule.Queries.GetAllQuery.execute(req.user.id);
    const ids = movies.map(m => m.tmdbId);
    const region = typeof req.query.region === 'string' && /^[A-Z]{2}$/.test(req.query.region) ? req.query.region : undefined;
    const signature = JSON.stringify([ids.slice().sort(), region]);
    let entry = discovery.get(req.user.id);
    if (!entry || entry.signature !== signature || entry.until < Date.now()) {
      entry = { signature, until: Date.now() + 12 * 60 * 60_000 };
      const current = entry;
      current.running = discoverMovies(ids, new Date().toISOString().slice(0, 10), region).then(result => { current.result = result; if (result.unresolved) current.until = Date.now() + 5 * 60_000; }).catch(() => { current.until = 0; }).finally(() => { current.running = undefined; });
      if (discovery.size >= 500) discovery.delete(discovery.keys().next().value!);
      discovery.set(req.user.id, entry);
    }
    res.json(entry.result || { status: 'building' });
  } catch { res.status(503).json({ message: 'Movie discovery unavailable' }); }
});

router.get("/:id", async (req: Request<{id: string}>, res: Response) => {
  const movieId = req.params.id;

  if (movieId) {
    const movie = await movieModule.Queries.GetByIdQuery.execute(movieId, req.user.id);
    
    if (!movie) {
      res.status(404).json({ message: "Movie not found" });
      return;
    }
    
    res.json(movie);
    return;
  }

  const movies = await movieModule.Queries.GetAllQuery.execute(req.user.id);
  res.json(movies);
});

router.get("/", async (req: Request, res: Response) => {
  const movies = await movieModule.Queries.GetAllQuery.execute(req.user.id);
  res.json(movies);
});

router.post("/", async (req: Request<{}, {}, CreateMovieDto>, res: Response) => {
  const movieData = req.body;
  if (!movieData?.name?.trim() || movieData.tmdbId !== undefined && (!Number.isInteger(movieData.tmdbId) || movieData.tmdbId <= 0)) { res.status(400).json({ message: 'Invalid movie' }); return; }
  
  try {
    const movie = await movieModule.Commands.CreateCommand.execute({
      name: movieData.name.trim(), overview: movieData.overview, posterURL: movieData.posterURL, tmdbId: movieData.tmdbId,
    }, req.user.id);
    res.status(201).json(movie);
  } catch (error) {
    if (error instanceof Error && (error.message === 'Movie already exists' || 'code' in error && error.code === 'P2002')) {
      res.status(409).json({ message: "Movie already exists" });
    } else {
      console.error(error);
      res.status(500).json({ message: "Internal server error" });
    }
  }
});

router.put("/:id", async (req: Request<{id: string}, {}, UpdateMovieDto>, res: Response) => {
  const movieId = req.params.id;
  const movieData = req.body;
  
  if (!movieId || !movieData) {
    res.status(400).json({ message: "Bad request" });
    return;
  }
  if (movieData.tmdbId !== undefined && (!Number.isInteger(movieData.tmdbId) || movieData.tmdbId <= 0) ||
    movieData.status !== undefined && movieData.status !== null && !['watchlist', 'watched'].includes(movieData.status) ||
    movieData.rating !== undefined && movieData.rating !== null && (!Number.isInteger(movieData.rating) || movieData.rating < 1 || movieData.rating > 10)) {
    res.status(400).json({ message: 'Invalid movie update' }); return;
  }
  
  const allowed: UpdateMovieDto = {
    ...(typeof movieData.name === 'string' ? { name: movieData.name.trim() } : {}),
    ...(typeof movieData.overview === 'string' ? { overview: movieData.overview } : {}),
    ...(typeof movieData.posterURL === 'string' ? { posterURL: movieData.posterURL } : {}),
    ...(typeof movieData.favorite === 'boolean' ? { favorite: movieData.favorite } : {}),
    ...(movieData.tmdbId !== undefined ? { tmdbId: movieData.tmdbId } : {}),
    ...(movieData.status !== undefined ? { status: movieData.status } : {}),
    ...(movieData.rating !== undefined ? { rating: movieData.rating } : {}),
    ...(movieData.notes !== undefined && (movieData.notes === null || typeof movieData.notes === 'string') ? { notes: movieData.notes } : {}),
  };
  if (allowed.name === '' || !Object.keys(allowed).length) { res.status(400).json({ message: 'Invalid movie update' }); return; }
  let result;
  try { result = await movieModule.Commands.UpdateCommand.execute(movieId, allowed, req.user.id); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'P2002') res.status(409).json({ message: 'Movie already exists' });
    else { console.error(error); res.status(500).json({ message: 'Internal server error' }); }
    return;
  }
  
  if (!result) {
    res.status(404).json({ message: "Movie not found or you don't have permission to update it" });
  } else {
    res.status(200).json(result);
  }
});

router.delete("/:id", async (req: Request<{id: string}>, res: Response) => {
  const movieId = req.params.id;
  
  if (!movieId) {
    res.status(400).json({ message: "Bad request" });
    return;
  }
  
  const result = await movieModule.Commands.DeleteCommand.execute(movieId, req.user.id);
  
  if (result.count === 0) {
    res.status(404).json({ message: "Movie not found or you don't have permission to delete it" });
  } else {
    res.status(200).json({ message: "Movie deleted successfully", result });
  }
});

export default router;
