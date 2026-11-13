import {Router} from "express";
import authRouter from "./auth";
import showRouter from "./show";
import movieRouter from "./movie";
import userRouter from "./user";
import notificationsRouter from "./notifications";
import { protectedRoute } from "../../middlewares/protectedRoute";
import { getHealth } from "../../services/episode-guide.service";
import { notificationSchedulerStatus } from "../../services/notifications/notification-scheduler";

const router = Router();

router.use("/auth", authRouter);
router.get("/version", (_req, res) => {
  res.json({ version: process.env.SOURCE_COMMIT || process.env.APP_VERSION || null });
});
// Public and non-sensitive: TMDB authentication status, cache warmth and the notification scheduler's state
// (timestamps and counts only: no user data, no secrets).
router.get("/health", async (_req, res) => {
  res.json({ version: process.env.SOURCE_COMMIT || process.env.APP_VERSION || null, ...(await getHealth()), notifications: notificationSchedulerStatus() });
});
router.use("/show", protectedRoute, showRouter);
router.use("/movie", protectedRoute, movieRouter);
router.use("/user", userRouter);
router.use("/notifications", protectedRoute, notificationsRouter);

export default router;
