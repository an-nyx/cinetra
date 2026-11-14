import { Router, Request, Response } from "express";
import { rateLimit } from "../../middlewares/rate-limit";
import { classifySend, defaultSender, parseSubscription, publicVapidKey } from "../../services/notifications/push-sender";
import { previewPayload, testPayload } from "../../services/notifications/episode-alerts.model";
import { notificationDiagnostics } from "../../services/notifications/notification-diagnostics.service";
import { countSubscriptions, deviceStatus, findOwnSubscription, getPreferences, previewShow, recordDeliverySuccess, removeSubscription, saveSubscription, updatePreferences } from "../../services/notifications/push-subscription.service";

/** Mounted behind protectedRoute: every handler acts only on req.user's own preferences and subscriptions. */
const router = Router();
const writes = rateLimit({ name: "push-write", windowMs: 10 * 60_000, max: 20 });
const tests = rateLimit({ name: "push-test", windowMs: 5 * 60_000, max: 3 });

const endpointOf = (body: unknown) => {
  const endpoint = (body as { endpoint?: unknown } | null)?.endpoint;
  return typeof endpoint === "string" && endpoint.length > 0 && endpoint.length <= 2048 ? endpoint : null;
};
const fail = (res: Response, error?: unknown) => {
  // Error type and Prisma code only: never the request body, endpoint or keys.
  const code = (error as { code?: unknown } | undefined)?.code;
  console.error(`Notification settings request failed: ${error instanceof Error ? error.name : "unknown error"}${typeof code === "string" ? ` (${code})` : ""}`);
  res.status(500).json({ message: "Notification settings are unavailable right now." });
};

router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });

// Public VAPID key only; the private key never leaves the server.
router.get("/config", (_req: Request, res: Response) => {
  const vapidPublicKey = publicVapidKey();
  res.json({ configured: !!vapidPublicKey, vapidPublicKey });
});

/** Why each saved show would or would not alert, this account's devices and its delivery ledger. Read-only. */
router.get("/diagnostics", async (req: Request, res: Response) => {
  try { res.json(await notificationDiagnostics(req.user.id)); }
  catch (error) { fail(res, error); }
});

router.get("/preferences", async (req: Request, res: Response) => {
  try { res.json({ preferences: await getPreferences(req.user.id), devices: await countSubscriptions(req.user.id) }); }
  catch (error) { fail(res, error); }
});

router.put("/preferences", writes, async (req: Request, res: Response) => {
  const { newEpisodes, movies, dailyDigest, showScope } = req.body || {};
  if (typeof newEpisodes !== "boolean" || (movies !== undefined && movies !== false) || (dailyDigest !== undefined && dailyDigest !== false) || (showScope !== undefined && showScope !== "all_except_dropped")) {
    res.status(400).json({ message: "Only new TV episode alerts can be changed. Movie alerts and the daily digest are not available." }); return;
  }
  try { res.json({ preferences: await updatePreferences(req.user.id, { newEpisodes }) }); }
  catch (error) { fail(res, error); }
});

router.post("/subscriptions", writes, async (req: Request, res: Response) => {
  if (!publicVapidKey()) { res.status(503).json({ message: "Push notifications are not configured on this server." }); return; }
  const subscription = parseSubscription(req.body?.subscription);
  if (!subscription) { res.status(400).json({ message: "Invalid push subscription." }); return; }
  try { res.status(201).json(await saveSubscription(req.user.id, subscription, req.get("User-Agent") || null)); }
  catch (error) { fail(res, error); }
});

// POST (not GET) so the endpoint, a capability URL, never appears in a URL or access log.
router.post("/subscriptions/status", async (req: Request, res: Response) => {
  const endpoint = endpointOf(req.body);
  if (!endpoint) { res.status(400).json({ message: "Missing endpoint." }); return; }
  try { res.json(await deviceStatus(req.user.id, endpoint)); }
  catch (error) { fail(res, error); }
});

router.delete("/subscriptions", writes, async (req: Request, res: Response) => {
  const endpoint = endpointOf(req.body);
  if (!endpoint) { res.status(400).json({ message: "Missing endpoint." }); return; }
  try { res.json({ removed: await removeSubscription(req.user.id, endpoint) }); }
  catch (error) { fail(res, error); }
});

// Explicit button press only; this device only. `preview: true` sends a labelled example of the episode-alert style
// for one of the user's own shows (with its poster where supported). Neither touches the delivery ledger.
router.post("/test", tests, async (req: Request, res: Response) => {
  const endpoint = endpointOf(req.body);
  if (!endpoint) { res.status(400).json({ message: "Missing endpoint." }); return; }
  const preview = req.body?.preview === true;
  try {
    const sender = defaultSender();
    if (!sender) { res.status(503).json({ message: "Push notifications are not configured on this server." }); return; }
    const subscription = await findOwnSubscription(req.user.id, endpoint);
    if (!subscription) { res.status(404).json({ message: "This device is not subscribed." }); return; }
    let payload = testPayload();
    if (preview) {
      const show = await previewShow(req.user.id);
      if (!show) { res.status(409).json({ message: "Add a show to your library to preview episode alerts." }); return; }
      payload = previewPayload(show);
    }
    const outcome = classifySend(await sender.send(subscription, payload, { ttlSeconds: 300, urgency: "high" }));
    if (outcome === "gone") { await removeSubscription(req.user.id, endpoint); res.status(410).json({ message: "This device's subscription has expired. Enable notifications again." }); return; }
    if (outcome !== "delivered") { res.status(502).json({ message: "The push service did not accept the test notification." }); return; }
    await recordDeliverySuccess(subscription.id);
    res.json({ sent: true, ...(preview ? { preview: { title: payload.title, body: payload.body, image: !!payload.image } } : {}) });
  } catch (error) { fail(res, error); }
});

export default router;
