import {Router} from "express";
import authRouter from "./auth";
import showRouter from "./show";
import movieRouter from "./movie";
import userRouter from "./user";
import { protectedRoute } from "../../middlewares/protectedRoute";

const router = Router();

router.use("/auth", authRouter);
router.get("/version", (_req, res) => {
  res.json({ version: process.env.SOURCE_COMMIT || process.env.APP_VERSION || null });
});
router.use("/show", protectedRoute, showRouter);
router.use("/movie", protectedRoute, movieRouter);
router.use("/user", userRouter);

export default router;
