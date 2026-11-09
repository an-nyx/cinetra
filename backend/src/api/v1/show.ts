import { Router, Request, Response } from "express";
import { showModule } from '../../modules/show';
import { CreateShowDto, UpdateShowDto } from '../../modules/show/model/show.entity';
import { getEpisodeGuide, getTrackingSummary, getLibraryTracking, getUpcomingReleases, setEpisodeWatched, setSeasonWatched, importLegacyProgress, EpisodeGuideError, invalidateUpcoming, previewRematch, applyRematch, RematchConflictError } from '../../services/episode-guide.service';

const router = Router();

// Adding, editing or removing a show can change the schedule: refresh Upcoming (in the background) after success.
router.use((req, res, next) => {
  if ((req.method === 'POST' && req.path === '/') || ((req.method === 'PUT' || req.method === 'DELETE') && /^\/[^/]+(\/tmdb-match)?$/.test(req.path))) {
    res.on('finish', () => { if (res.statusCode < 400) invalidateUpcoming(req.user.id); });
  }
  next();
});

function guideError(res: Response, error: unknown) {
  if (error instanceof EpisodeGuideError) res.status(error.status).json({ message: error.message });
  else { console.error('Episode provider unavailable'); res.status(502).json({ message: 'Episode provider unavailable.' }); }
}

router.get("/search", async (req: Request, res: Response) => {
  const query = req.query.q as string;
  
  try {
    const results = await showModule.Queries.SearchQuery.execute(query);
    res.json(results);
  } catch (error) {
    res.status(502).json({ message: "TMDB search unavailable. Check the API credential." });
  }
});

router.get("/tracking", async (req: Request, res: Response) => {
  try { res.json(await getLibraryTracking(req.user.id)); }
  catch (error) { guideError(res, error); }
});


router.get("/upcoming", async (req: Request, res: Response) => {
  try { res.json(await getUpcomingReleases(req.user.id)); }
  catch (error) { guideError(res, error); }
});

// Edit show: compare the current TMDB match with a chosen series (read-only), then re-link after confirmation.
router.get("/:id/tmdb-match", async (req: Request<{id: string}>, res: Response) => {
  try { res.json(await previewRematch(req.params.id, req.user.id, Number(req.query.tmdbId))); }
  catch (error) { guideError(res, error); }
});
router.put("/:id/tmdb-match", async (req: Request<{id: string}, {}, { tmdbId?: unknown; expectedCurrentTmdbId?: unknown; acknowledgeProgress?: unknown }>, res: Response) => {
  const { tmdbId, expectedCurrentTmdbId, acknowledgeProgress } = req.body || {};
  if (!Number.isInteger(tmdbId) || (expectedCurrentTmdbId !== null && !Number.isInteger(expectedCurrentTmdbId)) || (acknowledgeProgress !== undefined && typeof acknowledgeProgress !== 'boolean')) {
    res.status(400).json({ message: 'Invalid change' }); return;
  }
  try { res.json(await applyRematch(req.params.id, req.user.id, tmdbId as number, expectedCurrentTmdbId as number | null, acknowledgeProgress === true)); }
  catch (error) {
    if (error instanceof RematchConflictError) res.status(409).json({ message: error.message, preview: error.preview });
    else guideError(res, error);
  }
});

router.get("/:id/tracking", async (req: Request<{id: string}>, res: Response) => {
  try { res.json(await getTrackingSummary(req.params.id, req.user.id)); }
  catch (error) { guideError(res, error); }
});

router.post("/:id/import-legacy-progress", async (req: Request<{id: string}>, res: Response) => {
  try { res.json(await importLegacyProgress(req.params.id, req.user.id)); }
  catch (error) { guideError(res, error); }
});

router.get("/:id/episodes", async (req: Request<{id: string}>, res: Response) => {
  try { res.json(await getEpisodeGuide(req.params.id, req.user.id, Number(req.query.season ?? 1))); }
  catch (error) { guideError(res, error); }
});

router.put("/:id/episodes/:season/:episode", async (req: Request<{id: string; season: string; episode: string}>, res: Response) => {
  try { res.json(await setEpisodeWatched(req.params.id, req.user.id, Number(req.params.season), Number(req.params.episode), req.body.watched)); }
  catch (error) { guideError(res, error); }
});

router.post("/:id/seasons/:season/watched", async (req: Request<{id: string; season: string}>, res: Response) => {
  try { res.json(await setSeasonWatched(req.params.id, req.user.id, Number(req.params.season))); }
  catch (error) { guideError(res, error); }
});

router.get("/", async (req: Request, res: Response) => {
  const shows = await showModule.Queries.GetAllQuery.execute(req.user.id);
  res.json(shows);
});

router.get("/:id", async (req: Request<{id: string}>, res: Response) => {
  const showId = req.params.id;

  if (showId) {
    const show = await showModule.Queries.GetByIdQuery.execute(showId, req.user.id);
    if (!show) res.status(404).json({ message: 'Show not found' });
    else res.json(show);
    return;
  }

});

router.post("/", async (req: Request<{}, {}, CreateShowDto>, res: Response) => {
  const showData = req.body;
  if (!showData?.name?.trim() || (showData.tmdbId !== undefined && (!Number.isInteger(showData.tmdbId) || showData.tmdbId <= 0))) {
    res.status(400).json({ message: 'Invalid show' });
    return;
  }
  try {
    res.status(201).json(await showModule.Commands.CreateCommand.execute({
      name: showData.name.trim(), overview: showData.overview, posterURL: showData.posterURL,
      tmdbId: showData.tmdbId,
    }, req.user.id));
  } catch (error) {
    if (error instanceof Error && (error.message === 'Show already exists' || 'code' in error && error.code === 'P2002')) {
      res.status(409).json({ message: 'Show already exists' });
    } else { console.error(error); res.status(500).json({ message: 'Internal server error' }); }
  }
});

router.put("/:id", async (req: Request<{id: string}, {}, UpdateShowDto>, res: Response) => {
  const showId = req.params.id;
  const showData = req.body;
  if (!showData || ['seasonsWatched', 'episodesWatched'].some(key => {
    const value = showData[key as 'seasonsWatched' | 'episodesWatched'];
    return value !== undefined && (!Number.isInteger(value) || value < 0);
  }) || showData.tmdbId !== undefined && (!Number.isInteger(showData.tmdbId) || showData.tmdbId <= 0) ||
    showData.status !== undefined && showData.status !== null && !['watching', 'completed', 'planned', 'paused', 'dropped'].includes(showData.status)) {
    res.status(400).json({ message: 'Invalid show update' }); return;
  }
  const allowed: UpdateShowDto = {
    ...(typeof showData.name === 'string' ? { name: showData.name.trim() } : {}),
    ...(typeof showData.overview === 'string' ? { overview: showData.overview } : {}),
    ...(typeof showData.posterURL === 'string' ? { posterURL: showData.posterURL } : {}),
    ...(showData.seasonsWatched !== undefined ? { seasonsWatched: showData.seasonsWatched } : {}),
    ...(showData.episodesWatched !== undefined ? { episodesWatched: showData.episodesWatched } : {}),
    ...(typeof showData.completed === 'boolean' ? { completed: showData.completed } : {}),
    ...(typeof showData.favorite === 'boolean' ? { favorite: showData.favorite } : {}),
    ...(showData.tmdbId !== undefined ? { tmdbId: showData.tmdbId } : {}),
    ...(showData.status !== undefined ? { status: showData.status } : {}),
  };
  if (allowed.name === '' || !Object.keys(allowed).length) { res.status(400).json({ message: 'Invalid show update' }); return; }
  try {
  const result = await showModule.Commands.UpdateCommand.execute(showId, allowed, req.user.id);
  
  if (!result) {
    res.status(404).json({ message: "Show not found or you don't have permission to update it" });
  } else {
    res.status(200).json(result);
  }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'P2002') res.status(409).json({ message: 'Show already exists' });
    else { console.error(error); res.status(500).json({ message: 'Internal server error' }); }
  }
});

router.delete("/:id", async (req: Request<{id: string}>, res: Response) => {
  const showId = req.params.id;
  const result = await showModule.Commands.DeleteCommand.execute(showId, req.user.id);
  
  if (result.count === 0) {
    res.status(404).json({ message: "Show not found or you don't have permission to delete it" });
  } else {
    res.status(200).json({ message: "Show deleted successfully", result });
  }
});

export default router;
