/**
 * Web Push support detection and the plain-language state shown in notification settings (pure; testable in Node).
 *
 * iPhone and iPad: Web Push works only in a Home Screen web app on iOS/iPadOS 16.4 or later. In a regular Safari (or
 * other browser) tab the Push API is not exposed, so the page explains how to add Cinetra to the Home Screen.
 */
export type Permission = "default" | "granted" | "denied" | "unsupported";
export type PushEnvironment = {
  serviceWorker: boolean; pushManager: boolean; notifications: boolean; secureContext: boolean;
  ios: boolean; iosVersion: [major: number, minor: number] | null; standalone: boolean; permission: Permission;
};

type NavigatorLike = { userAgent?: string; maxTouchPoints?: number; standalone?: boolean; serviceWorker?: unknown };
type WindowLike = {
  isSecureContext?: boolean; PushManager?: unknown; Notification?: { permission?: string };
  matchMedia?: (query: string) => { matches: boolean };
  ServiceWorkerRegistration?: { prototype?: object };
};

export function detectEnvironment(win: WindowLike, nav: NavigatorLike): PushEnvironment {
  const ua = nav.userAgent || "";
  // iPadOS reports a Mac user agent; touch support tells them apart.
  const iosDevice = /iPhone|iPad|iPod/.test(ua);
  const ios = iosDevice || (/Macintosh/.test(ua) && (nav.maxTouchPoints || 0) > 1);
  // iPhone: "CPU iPhone OS 17_4". iPadOS desktop mode says "Mac OS X 10_15_7", so use Safari's "Version/17.4" there.
  const match = !ios ? null : iosDevice ? /OS (\d+)(?:_(\d+))?/.exec(ua) : /Version\/(\d+)(?:\.(\d+))?/.exec(ua);
  const iosVersion: [number, number] | null = match ? [Number(match[1]), Number(match[2] || 0)] : null;
  let standalone = nav.standalone === true;
  try { standalone = standalone || !!win.matchMedia?.("(display-mode: standalone)").matches; } catch { /* ignore */ }
  const notifications = !!win.Notification;
  const raw = win.Notification?.permission;
  const permission: Permission = !notifications ? "unsupported" : raw === "granted" || raw === "denied" ? raw : "default";
  return {
    serviceWorker: !!nav.serviceWorker, pushManager: !!win.PushManager, notifications,
    secureContext: win.isSecureContext !== false, ios, iosVersion, standalone, permission,
  };
}

export type Support =
  | "supported"
  | "ios_install_required"   // iPhone/iPad Safari tab on 16.4+: add to Home Screen first
  | "ios_update_required"    // iOS/iPadOS older than 16.4
  | "insecure"               // HTTP (not localhost): browsers only allow push on HTTPS
  | "unsupported";           // browser without Service Worker / Push / Notifications

/** Web Push for Home Screen web apps arrived in iOS and iPadOS 16.4. */
export const IOS_MIN_VERSION: [number, number] = [16, 4];
const older = (v: [number, number], min: [number, number]) => v[0] < min[0] || (v[0] === min[0] && v[1] < min[1]);

export function pushSupport(env: PushEnvironment): Support {
  if (!env.secureContext) return "insecure";
  if (env.ios) {
    if (env.iosVersion !== null && older(env.iosVersion, IOS_MIN_VERSION)) return "ios_update_required";
    if (!env.standalone) return "ios_install_required";
  }
  if (!env.serviceWorker || !env.pushManager || !env.notifications) return env.ios ? "ios_install_required" : "unsupported";
  return "supported";
}

export type DeviceState = "unknown" | "active" | "inactive" | "failed";
export type Explanation = { tone: "ok" | "info" | "warn" | "error"; title: string; detail: string };

/** One sentence explaining where this device stands, for the settings card. */
export function explain(input: { support: Support; permission: Permission; device: DeviceState; serverConfigured: boolean | null; error?: string | null }): Explanation {
  const { support, permission, device, serverConfigured, error } = input;
  if (support === "insecure") return { tone: "warn", title: "Secure connection required", detail: "Notifications only work when Cinetra is opened over HTTPS." };
  if (support === "ios_update_required") return { tone: "warn", title: "Update iOS to get notifications", detail: "iPhone and iPad notifications from web apps need iOS or iPadOS 16.4 or later." };
  if (support === "ios_install_required") return { tone: "info", title: "Add Cinetra to your Home Screen", detail: "On iPhone, notifications work only in the Home Screen app. Tap Share, choose Add to Home Screen, then open Cinetra from your Home Screen and enable notifications there." };
  if (support === "unsupported") return { tone: "warn", title: "This browser can’t receive notifications", detail: "It does not support Web Push. Try Safari on iPhone (from the Home Screen), or Chrome, Edge or Firefox." };
  if (serverConfigured === false) return { tone: "warn", title: "Notifications aren’t set up on the server", detail: "This Cinetra server has no push keys configured yet." };
  if (permission === "denied") return { tone: "error", title: "Notifications are blocked", detail: "You blocked notifications for Cinetra. Allow them in your browser or system settings (on iPhone: Settings › Notifications › Cinetra), then come back and enable them." };
  if (device === "failed") return { tone: "error", title: "Couldn’t turn on notifications", detail: error || "The subscription could not be saved. Check your connection and try again." };
  if (device === "active" && permission === "granted") return { tone: "ok", title: "Notifications are on for this device", detail: "You’ll be notified when a new episode of a show in your library premieres, even when Cinetra is closed." };
  if (permission === "granted") return { tone: "info", title: "Allowed, but this device isn’t subscribed", detail: "Tap Enable notifications to subscribe this device." };
  return { tone: "info", title: "Notifications are off", detail: "Tap Enable notifications. Your browser will then ask for permission; nothing is requested before you tap." };
}

/** VAPID public key (URL-safe base64) to the byte array PushManager.subscribe expects. */
export function applicationServerKey(base64url: string): Uint8Array {
  const padded = (base64url + "=".repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Whether an existing browser subscription was made with the server's current VAPID key (keys can be rotated). */
export function sameKey(existing: ArrayBuffer | null | undefined, expected: Uint8Array): boolean {
  if (!existing) return false;
  const a = new Uint8Array(existing);
  return a.length === expected.length && a.every((value, index) => value === expected[index]);
}

export const permissionLabel: Record<Permission, string> = { default: "Not requested", granted: "Allowed", denied: "Blocked", unsupported: "Not supported" };
export const deviceLabel: Record<DeviceState, string> = { unknown: "Checking…", active: "Active", inactive: "Not subscribed", failed: "Failed" };
