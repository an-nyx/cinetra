import { useCallback, useEffect, useState } from "react";
import { NotificationService, type NotificationPreferences } from "@/services/notification.service";
import { registerServiceWorker, SUBSCRIPTION_CHANGED_EVENT } from "@/lib/service-worker";
import { applicationServerKey, detectEnvironment, pushSupport, sameKey, type DeviceState, type Permission, type Support } from "@/lib/push-support";

const browserEnvironment = () => detectEnvironment(window as never, navigator as never);
const message = (error: unknown, fallback: string) => {
  const data = (error as { response?: { data?: { message?: unknown } } })?.response?.data;
  return typeof data?.message === "string" ? data.message : fallback;
};

/**
 * This device's Web Push state and actions. Permission is only requested from `enable`, i.e. after the user taps
 * Enable notifications; loading the page never prompts.
 */
export function usePushNotifications() {
  const [support, setSupport] = useState<Support>(() => pushSupport(browserEnvironment()));
  const [permission, setPermission] = useState<Permission>(() => browserEnvironment().permission);
  const [device, setDevice] = useState<DeviceState>("unknown");
  const [serverKey, setServerKey] = useState<string | null>(null);
  const [serverConfigured, setServerConfigured] = useState<boolean | null>(null);
  const [preferences, setPreferences] = useState<NotificationPreferences | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "enable" | "disable" | "test" | "preview" | "preference">(null);

  const currentSubscription = useCallback(async () => {
    const registration = await registerServiceWorker();
    return registration ? registration.pushManager.getSubscription() : null;
  }, []);

  const refresh = useCallback(async () => {
    const env = browserEnvironment();
    const nextSupport = pushSupport(env);
    setSupport(nextSupport); setPermission(env.permission);
    try {
      const [config, prefs] = await Promise.all([NotificationService.getConfig(), NotificationService.getPreferences()]);
      setServerConfigured(config.configured); setServerKey(config.vapidPublicKey); setPreferences(prefs.preferences);
    } catch { setServerConfigured(null); }
    if (nextSupport !== "supported") { setDevice("inactive"); return; }
    try {
      const subscription = await currentSubscription();
      if (!subscription || env.permission !== "granted") { setDevice("inactive"); return; }
      const status = await NotificationService.deviceStatus(subscription.endpoint);
      setDevice(status.registered ? "active" : "inactive");
    } catch { setDevice("inactive"); }
  }, [currentSubscription]);

  useEffect(() => {
    void refresh();
    const onChange = () => { void refresh(); };
    window.addEventListener(SUBSCRIPTION_CHANGED_EVENT, onChange);
    document.addEventListener("visibilitychange", onChange);
    return () => { window.removeEventListener(SUBSCRIPTION_CHANGED_EVENT, onChange); document.removeEventListener("visibilitychange", onChange); };
  }, [refresh]);

  const enable = useCallback(async () => {
    if (support !== "supported" || busy) return;
    setBusy("enable"); setError(null);
    try {
      // First awaited call in the tap handler, so Safari treats the prompt as user-initiated.
      const granted = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
      setPermission(granted === "granted" || granted === "denied" ? granted : "default");
      if (granted !== "granted") return;
      const key = serverKey ?? (await NotificationService.getConfig()).vapidPublicKey;
      if (!key) { setServerConfigured(false); return; }
      const registration = await registerServiceWorker();
      if (!registration) throw new Error("Service worker unavailable");
      await navigator.serviceWorker.ready;
      const expected = applicationServerKey(key);
      let subscription = await registration.pushManager.getSubscription();
      // A subscription made with an older server key cannot receive pushes signed with the new one.
      if (subscription && !sameKey(subscription.options.applicationServerKey, expected)) { await subscription.unsubscribe(); subscription = null; }
      subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: expected as BufferSource });
      await NotificationService.saveSubscription(subscription.toJSON());
      setDevice("active");
    } catch (failure) {
      setDevice("failed");
      setError(message(failure, "The subscription could not be saved. Check your connection and try again."));
    } finally { setBusy(null); }
  }, [support, busy, serverKey]);

  const disable = useCallback(async () => {
    if (busy) return;
    setBusy("disable"); setError(null);
    try {
      const subscription = await currentSubscription();
      if (subscription) {
        // Remove it on the server first (needs the endpoint), then in the browser even if the server call failed.
        await NotificationService.removeSubscription(subscription.endpoint).catch(() => undefined);
        await subscription.unsubscribe().catch(() => undefined);
      }
      setDevice("inactive");
    } finally { setBusy(null); }
  }, [busy, currentSubscription]);

  /** The plain test, or (preview) a labelled example of an episode alert for one of your shows. This device only. */
  const sendTest = useCallback(async (preview = false) => {
    if (busy) return { ok: false, message: "Busy" };
    setBusy(preview ? "preview" : "test");
    try {
      const subscription = await currentSubscription();
      if (!subscription) { setDevice("inactive"); return { ok: false, message: "This device is not subscribed." }; }
      const result = await NotificationService.sendTest(subscription.endpoint, preview);
      if (preview && result.preview) return { ok: true, message: `Preview sent: “${result.preview.title}”${result.preview.image ? " (with the show’s poster where this device supports images)" : ""}.` };
      return { ok: true, message: "Test notification sent." };
    } catch (failure) {
      const status = (failure as { response?: { status?: number } })?.response?.status;
      if (status === 410 || status === 404) setDevice("inactive");
      return { ok: false, message: message(failure, "The test notification could not be sent.") };
    } finally { setBusy(null); }
  }, [busy, currentSubscription]);

  const setNewEpisodes = useCallback(async (value: boolean) => {
    setBusy("preference");
    try { setPreferences(await NotificationService.setNewEpisodes(value)); }
    catch (failure) { setError(message(failure, "Could not save this setting.")); }
    finally { setBusy(null); }
  }, []);

  return { support, permission, device, serverConfigured, preferences, error, busy, enable, disable, sendTest, setNewEpisodes, refresh };
}
