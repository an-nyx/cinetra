import express, {Request, Response} from "express";
import cors from "cors";
import "dotenv/config";
import path from "path";
import morgan from "morgan";
import apiRoutes from "./api/v1";
import { warmCaches } from "./services/episode-guide.service";
import { startNotificationScheduler } from "./services/notifications/notification-scheduler";

const app = express();

// middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan("combined"));

// api routes
app.use("/api/v1", apiRoutes);

if (process.env.NODE_ENV === "production") {
  // Hashed build assets never change: cache them for a year. index.html is always revalidated so a deploy shows at once.
  app.use(express.static(path.join(__dirname, "..", "ui"), {
    setHeaders: (res, file) => res.setHeader("Cache-Control", /[\\/]assets[\\/]/.test(file) ? "public, max-age=31536000, immutable" : "no-cache"),
  }));

  app.get("/{*any}", (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(__dirname, "..", "ui", "index.html"));
  });
}

// setup server
const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`server up and running on ${port}`);
  // Prepare TMDB catalogs and Upcoming in the background so the first visit after a deploy is fast.
  // Then refresh them hourly, so they never go cold while the server runs (e.g. overnight).
  if (process.env.NODE_ENV === "production" || process.env.WARM_CACHES === "true") {
    setTimeout(() => { warmCaches().catch(() => {}); }, 2000);
    setInterval(() => { warmCaches().catch(() => {}); }, 60 * 60_000).unref();
  }
  // New-episode push notifications: off unless NOTIFICATIONS_SCHEDULER=enabled and VAPID keys are set.
  startNotificationScheduler();
});
