/**
 * Registers Cinetra's push-only service worker (public/sw.js) and routes the page when a notification is clicked
 * while Cinetra is already open, so the existing window is reused instead of opening a duplicate tab.
 */
export const SUBSCRIPTION_CHANGED_EVENT = "cinetra:push-subscription-changed";

/** A same-origin path from a service-worker message, or null. Anything else is ignored. */
export function navigationTarget(message: unknown): string | null {
  const data = message as { type?: unknown; url?: unknown } | null;
  if (!data || data.type !== "cinetra:navigate" || typeof data.url !== "string") return null;
  const url = data.url;
  return url.startsWith("/") && !url.startsWith("//") && !url.includes("\\") ? url : null;
}

let registration: Promise<ServiceWorkerRegistration> | null = null;
export function registerServiceWorker(): Promise<ServiceWorkerRegistration> | null {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  registration ??= navigator.serviceWorker.register("/sw.js", { scope: "/" });
  return registration;
}

export function installServiceWorker() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  registerServiceWorker()?.catch(() => { registration = null; /* push is optional; the app works without it */ });
  navigator.serviceWorker.addEventListener("message", (event) => {
    if ((event.data as { type?: string } | null)?.type === "cinetra:push-subscription-changed") {
      window.dispatchEvent(new Event(SUBSCRIPTION_CHANGED_EVENT));
      return;
    }
    const target = navigationTarget(event.data);
    if (!target) return;
    // Client-side route change: React Router listens to popstate, so the page updates without a reload.
    if (window.location.pathname + window.location.search !== target) window.history.pushState({}, "", target);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
}
