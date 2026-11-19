import { Router, Request, Response } from "express";
import { rateLimit } from "../../middlewares/rate-limit";
import { prisma } from "../../database/prisma";
import { parseAddRequest, parseMovieRequest } from "../../services/radarr/radarr-model";
import { RadarrRequestError, createRadarrService, defaultRadarrClient, type RadarrDeps } from "../../services/radarr/radarr.service";

/**
 * Mounted behind protectedRoute. Fixed operations on the user's own library movies: read Radarr's connection state,
 * root folders and quality profiles, read the Radarr state of a movie, add a verified movie, and monitor (optionally
 * search) a movie already in Radarr. Not a proxy: no client-supplied URL, path or Radarr resource is ever forwarded.
 * Nothing here reads or writes Cinetra viewing data.
 */
type RadarrService = ReturnType<typeof createRadarrService>;

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createRadarrRouter(service: RadarrService) {
  const router = Router();
  const reads = rateLimit({ name: "radarr-read", windowMs: 60_000, max: 60 });
  const writes = rateLimit({ name: "radarr-write", windowMs: 10 * 60_000, max: 10 });

  router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });

  const fail = (res: Response, error: unknown) => {
    if (error instanceof RadarrRequestError) { res.status(error.status).json({ code: error.code, message: error.message, ...(error.detail || {}) }); return; }
    // Error type only: never the request, Radarr's response or configuration.
    console.error(`Radarr request failed: ${error instanceof Error ? error.name : "unknown error"}`);
    res.status(500).json({ code: "internal", message: "Radarr integration is unavailable right now." });
  };
  const notFound = (res: Response) => res.status(404).json({ code: "movie_not_found", message: "Movie not found." });
  const notJson = (req: Request, res: Response) => {
    // JSON only: rejects form posts from other sites (no simple cross-site request can set this content type).
    if (req.is("application/json")) return false;
    res.status(415).json({ code: "unsupported", message: "Send JSON." });
    return true;
  };

  router.get("/status", reads, async (req: Request, res: Response) => {
    try { res.json(await service.connection(req.user.id)); } catch (error) { fail(res, error); }
  });

  router.get("/options", reads, async (req: Request, res: Response) => {
    try { res.json(await service.getOptions(req.user.id)); } catch (error) { fail(res, error); }
  });

  router.get("/movies/:id", reads, async (req: Request<{ id: string }>, res: Response) => {
    if (!ID.test(req.params.id)) { notFound(res); return; }
    try { res.json(await service.status(req.params.id, req.user.id)); } catch (error) { fail(res, error); }
  });

  router.post("/movies/:id", writes, async (req: Request<{ id: string }>, res: Response) => {
    if (!ID.test(req.params.id)) { notFound(res); return; }
    if (notJson(req, res)) return;
    const parsed = parseAddRequest(req.body);
    if (!parsed.ok) { res.status(400).json({ code: "invalid_request", message: parsed.message }); return; }
    try { res.status(201).json(await service.add(req.params.id, req.user.id, parsed.value)); } catch (error) { fail(res, error); }
  });

  router.get("/movies/:id/request", reads, async (req: Request<{ id: string }>, res: Response) => {
    if (!ID.test(req.params.id)) { notFound(res); return; }
    try { res.json(await service.detail(req.params.id, req.user.id)); } catch (error) { fail(res, error); }
  });

  router.post("/movies/:id/request", writes, async (req: Request<{ id: string }>, res: Response) => {
    if (!ID.test(req.params.id)) { notFound(res); return; }
    if (notJson(req, res)) return;
    const parsed = parseMovieRequest(req.body);
    if (!parsed.ok) { res.status(400).json({ code: "invalid_request", message: parsed.message }); return; }
    try { res.json(await service.requestMovie(req.params.id, req.user.id, parsed.value)); } catch (error) { fail(res, error); }
  });

  return router;
}

/* Production dependencies. */

let ownerCache: { id: string | null; expires: number } | null = null;

/**
 * Who may use Radarr: the accounts listed in RADARR_ALLOWED_USER_IDS, or, when unset, only the instance owner (the first
 * account created), exactly like Sonarr. Radarr downloads belong to the server owner; other sign-ups never see it.
 */
export async function isRadarrUser(userId: string) {
  const allowList = (process.env.RADARR_ALLOWED_USER_IDS || "").split(",").map(item => item.trim()).filter(Boolean);
  if (allowList.length) return allowList.includes(userId);
  if (!ownerCache || ownerCache.expires < Date.now()) {
    const owner = await prisma.user.findFirst({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true } });
    ownerCache = { id: owner?.id ?? null, expires: Date.now() + 5 * 60_000 };
  }
  return ownerCache.id === userId;
}

export const productionDeps: RadarrDeps = {
  client: defaultRadarrClient,
  // Read-only lookup of the user's own movie: identity fields only, never viewing data.
  findMovie: (movieId, userId) => prisma.movie.findFirst({ where: { id: movieId, userId }, select: { id: true, name: true, tmdbId: true, posterURL: true } }),
  isAllowed: isRadarrUser,
};

export default createRadarrRouter(createRadarrService(productionDeps));
