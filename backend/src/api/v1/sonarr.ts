import { Router, Request, Response } from "express";
import { rateLimit } from "../../middlewares/rate-limit";
import { prisma } from "../../database/prisma";
import { TMDBApiService } from "../../services/tmdb/tmdb-api.service";
import { parseAddRequest } from "../../services/sonarr/sonarr-match.model";
import { SonarrRequestError, createSonarrService, defaultSonarrClient, type SonarrDeps } from "../../services/sonarr/sonarr.service";

/**
 * Mounted behind protectedRoute. Three fixed operations on the user's own library shows: read the Sonarr state of a
 * show, read Sonarr's root folders and quality profiles, and add a verified series. Not a proxy: no client-supplied URL,
 * path or Sonarr resource is ever forwarded.
 */
type SonarrService = ReturnType<typeof createSonarrService>;

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createSonarrRouter(service: SonarrService) {
  const router = Router();
  const reads = rateLimit({ name: "sonarr-read", windowMs: 60_000, max: 60 });
  const writes = rateLimit({ name: "sonarr-add", windowMs: 10 * 60_000, max: 10 });

  router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });

  const fail = (res: Response, error: unknown) => {
    if (error instanceof SonarrRequestError) { res.status(error.status).json({ code: error.code, message: error.message, ...(error.detail || {}) }); return; }
    // Error type only: never the request, Sonarr's response or configuration.
    console.error(`Sonarr request failed: ${error instanceof Error ? error.name : "unknown error"}`);
    res.status(500).json({ code: "internal", message: "Sonarr integration is unavailable right now." });
  };

  router.get("/options", reads, async (req: Request, res: Response) => {
    try { res.json(await service.getOptions(req.user.id)); } catch (error) { fail(res, error); }
  });

  router.get("/shows/:id", reads, async (req: Request<{ id: string }>, res: Response) => {
    if (!ID.test(req.params.id)) { res.status(404).json({ code: "show_not_found", message: "Show not found." }); return; }
    try { res.json(await service.status(req.params.id, req.user.id)); } catch (error) { fail(res, error); }
  });

  router.post("/shows/:id", writes, async (req: Request<{ id: string }>, res: Response) => {
    if (!ID.test(req.params.id)) { res.status(404).json({ code: "show_not_found", message: "Show not found." }); return; }
    // JSON only: rejects form posts from other sites (no simple cross-site request can set this content type).
    if (!req.is("application/json")) { res.status(415).json({ code: "unsupported", message: "Send JSON." }); return; }
    const parsed = parseAddRequest(req.body);
    if (!parsed.ok) { res.status(400).json({ code: "invalid_request", message: parsed.message }); return; }
    try { res.status(201).json(await service.add(req.params.id, req.user.id, parsed.value)); } catch (error) { fail(res, error); }
  });

  return router;
}

/* Production dependencies. */

const tmdb = new TMDBApiService();
let ownerCache: { id: string | null; expires: number } | null = null;

/**
 * Who may use Sonarr: the accounts listed in SONARR_ALLOWED_USER_IDS, or, when unset, only the instance owner (the
 * first account created). Sonarr downloads belong to the server owner; other sign-ups never see the integration.
 */
export async function isSonarrUser(userId: string) {
  const allowList = (process.env.SONARR_ALLOWED_USER_IDS || "").split(",").map(item => item.trim()).filter(Boolean);
  if (allowList.length) return allowList.includes(userId);
  if (!ownerCache || ownerCache.expires < Date.now()) {
    const owner = await prisma.user.findFirst({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true } });
    ownerCache = { id: owner?.id ?? null, expires: Date.now() + 5 * 60_000 };
  }
  return ownerCache.id === userId;
}

export const productionDeps: SonarrDeps = {
  client: defaultSonarrClient,
  externalIds: tmdbId => tmdb.getExternalIds(tmdbId),
  findShow: (showId, userId) => prisma.show.findFirst({ where: { id: showId, userId }, select: { id: true, name: true, tmdbId: true, posterURL: true } }),
  isAllowed: isSonarrUser,
};

export default createSonarrRouter(createSonarrService(productionDeps));
