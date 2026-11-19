import {Router} from "express";
import authRouter from "./auth";
import showRouter from "./show";
import movieRouter from "./movie";
import userRouter from "./user";
import notificationsRouter from "./notifications";
import sonarrRouter from "./sonarr";
import radarrRouter from "./radarr";
import statsRouter from "./stats";
import { protectedRoute } from "../../middlewares/protectedRoute";
import { getHealth } from "../../services/episode-guide.service";
import { notificationSchedulerStatus } from "../../services/notifications/notification-scheduler";
import { showStatusMonitorStatus } from "../../services/show-status.service";
import { sonarrHealth } from "../../services/sonarr/sonarr.service";
import { radarrHealth } from "../../services/radarr/radarr.service";

const router = Router();

router.use("/auth", authRouter);
router.get("/version", (_req, res) => {
  res.json({ version: process.env.SOURCE_COMMIT || process.env.APP_VERSION || null });
});
// Public and non-sensitive: TMDB authentication status, cache warmth and the notification scheduler's state
// (timestamps and counts only: no user data, no secrets). Sonarr/Radarr: configured/connected and option counts only.
router.get("/health", async (_req, res) => {
  res.json({ version: process.env.SOURCE_COMMIT || process.env.APP_VERSION || null, ...(await getHealth()), notifications: notificationSchedulerStatus(), showStatus: showStatusMonitorStatus(), sonarr: sonarrHealth(), radarr: radarrHealth() });
});
router.use("/show", protectedRoute, showRouter);
router.use("/movie", protectedRoute, movieRouter);
router.use("/user", userRouter);
router.use("/notifications", protectedRoute, notificationsRouter);
router.use("/sonarr", protectedRoute, sonarrRouter);
router.use("/radarr", protectedRoute, radarrRouter);
router.use("/stats", protectedRoute, statsRouter);

export default router;
