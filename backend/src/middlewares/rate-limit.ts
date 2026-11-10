import { Request, Response, NextFunction } from "express";

/**
 * Small in-memory fixed-window rate limiter, keyed by the authenticated user (or IP before authentication).
 * Per process: enough for one Cinetra container; a multi-instance deployment would need a shared store.
 */
export function rateLimit(options: { name: string; windowMs: number; max: number }) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = `${options.name}:${req.user?.id || req.ip}`;
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) { entry = { count: 0, resetAt: now + options.windowMs }; hits.set(key, entry); }
    entry.count++;
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    if (entry.count > options.max) {
      res.setHeader("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
      res.status(429).json({ message: "Too many requests. Try again in a moment." });
      return;
    }
    next();
  };
}
