/*
 * Cinetra service worker: Web Push only.
 *
 * There is deliberately no fetch handler. Pages, assets and API calls are never cached or intercepted here, so the
 * app keeps exactly its existing loading and caching behavior.
 */
const DEFAULT_URL = "/";
const ICON = "/icon-192.png?v=2";

/** Only same-origin paths may be opened from a notification ("/shows?show=…"); anything else falls back to "/". */
function safePath(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return DEFAULT_URL;
  try {
    const url = new URL(value, self.location.origin);
    return url.origin === self.location.origin ? url.pathname + url.search + url.hash : DEFAULT_URL;
  } catch { return DEFAULT_URL; }
}
const text = (value, fallback, max) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : fallback);

self.addEventListener("install", () => { self.skipWaiting(); });
self.addEventListener("activate", (event) => { event.waitUntil(self.clients.claim()); });

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  // Every push shows a notification (iOS revokes push for subscriptions that receive silent pushes).
  const title = text(data.title, "Cinetra", 160);
  const options = {
    body: text(data.body, "", 300),
    icon: safePath(data.icon) === DEFAULT_URL ? ICON : safePath(data.icon),
    badge: safePath(data.badge) === DEFAULT_URL ? ICON : safePath(data.badge),
    data: { url: safePath(data.url) },
  };
  // The same tag replaces an older notification for the same episode instead of stacking a duplicate.
  if (typeof data.tag === "string" && data.tag) options.tag = data.tag.slice(0, 100);
  event.waitUntil(self.registration.showNotification(title, options));
});

/** Focus an open Cinetra window and route it, or open one. Never opens a second window when one exists. */
async function openFromNotification(path) {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const ours = windows.filter((client) => { try { return new URL(client.url).origin === self.location.origin; } catch { return false; } });
  const target = ours.find((client) => client.focused) || ours.find((client) => client.visibilityState === "visible") || ours[0];
  if (target) {
    try {
      const focused = await target.focus();
      // The page routes in place (no reload); see src/lib/service-worker.ts.
      (focused || target).postMessage({ type: "cinetra:navigate", url: path });
      return;
    } catch {
      // focus() can be refused (e.g. no user activation); fall back to opening a window.
    }
  }
  if (self.clients.openWindow) await self.clients.openWindow(path);
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = safePath(event.notification.data && event.notification.data.url);
  event.waitUntil(openFromNotification(path));
});

// The browser replaced this device's subscription. The worker has no session, so it cannot re-register on its own;
// open pages are told so the settings screen can show that this device needs to be enabled again.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    for (const client of clients) client.postMessage({ type: "cinetra:push-subscription-changed" });
  }));
});
