import { Router, Request, Response } from "express";
import { getCinemaStats } from '../../services/cinema-stats.service';

const router = Router();

/** Read-only: the signed-in user's My Cinema Stats. `tz` (IANA zone) only decides which year/month a record falls in. */
router.get('/', async (req: Request, res: Response) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await getCinemaStats(req.user.id, req.query.tz));
  } catch (error) {
    console.error('Cinema stats failed:', error instanceof Error ? error.name : 'unknown error');
    res.status(500).json({ message: 'Statistics unavailable' });
  }
});

export default router;
