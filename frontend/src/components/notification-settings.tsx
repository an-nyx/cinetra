import { Activity, Bell, BellOff, Clapperboard, Loader2, Send, Share, SquarePlus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { usePushNotifications } from "@/hooks/use-push-notifications";
import { deviceLabel, explain, permissionLabel, type Explanation } from "@/lib/push-support";
import { NotificationService, type NotificationDiagnostics, type ShowDiagnostic } from "@/services/notification.service";

const toneClass: Record<Explanation["tone"], string> = {
  ok: "border-primary/40 bg-primary/10",
  info: "border-border bg-muted/40",
  warn: "border-amber-500/40 bg-amber-500/10",
  error: "border-destructive/50 bg-destructive/10",
};

function Switch({ checked, disabled, onChange, label }: { checked: boolean; disabled?: boolean; onChange?: (value: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
      onClick={() => onChange?.(!checked)}
      className={`relative inline-flex h-6 w-10 shrink-0 items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 ${checked ? "border-primary bg-primary" : "border-border bg-muted"}`}>
      <span className={`inline-block size-4 rounded-full bg-background shadow transition-transform ${checked ? "translate-x-5 rtl:-translate-x-5" : "translate-x-1 rtl:-translate-x-1"}`} />
    </button>
  );
}

function Row({ title, detail, children }: { title: string; detail?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <div className="min-w-0"><p className="text-sm font-medium">{title}</p>{detail && <p className="text-xs text-muted-foreground">{detail}</p>}</div>
      {children}
    </div>
  );
}

const Pill = ({ ok, children }: { ok: boolean; children: React.ReactNode }) => (
  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${ok ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"}`}>{children}</span>
);

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "never");
const ago = (iso: string | null | undefined) => {
  if (!iso) return "never";
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} h ago` : `${Math.round(minutes / 1440)} d ago`;
};
const reasonLabel: Record<NonNullable<ShowDiagnostic["reason"]>, string> = {
  dropped: "Dropped", no_tmdb_link: "No TMDB link", unverified: "TVMaze identity not verified", unavailable: "Provider unavailable", shared_tvmaze_identity: "Shares a TVMaze identity",
};
const deliveryLabel: Record<string, string> = { pending: "Queued", sending: "Sending", retry: "Retrying", sent: "Sent", failed: "Failed", expired: "Expired", uncertain: "Uncertain", skipped: "Skipped" };

/** What the server is doing with notifications: scheduler, this account's devices, per-show eligibility, delivery ledger. */
function Diagnostics({ data }: { data: NotificationDiagnostics }) {
  const { scheduler, devices, shows, deliveries } = data;
  const schedulerLine = !scheduler.enabled ? { ok: false, text: "Server scheduler is off (NOTIFICATIONS_SCHEDULER is not \"enabled\")." }
    : !scheduler.configured ? { ok: false, text: `Server scheduler cannot start: ${scheduler.configError || "VAPID keys are not configured"}.` }
      : !scheduler.running ? { ok: false, text: "Server scheduler is enabled but not running in this process." }
        : { ok: true, text: `Server scheduler runs every ${scheduler.intervalMinutes} min · ${scheduler.ticks} pass${scheduler.ticks === 1 ? "" : "es"} since ${when(scheduler.startedAt)} · last ${ago(scheduler.lastTickFinishedAt)} · next ${when(scheduler.nextTickAt)}` };
  const run = scheduler.lastRun;
  const notEligible = shows.items.filter(s => !s.eligible);
  const recent = shows.items.filter(s => s.lastPremiere?.withinLookback);
  const upcoming = shows.items.filter(s => s.nextEpisode).sort((a, b) => (a.nextEpisode!.premieresAt || "").localeCompare(b.nextEpisode!.premieresAt || "")).slice(0, 5);
  return (
    <div className="space-y-3 text-xs">
      <p className={schedulerLine.ok ? "text-primary" : "text-destructive"}>{schedulerLine.text}</p>
      {scheduler.lastError && <p className="text-destructive">Last scheduler error ({ago(scheduler.lastError.at)}): {scheduler.lastError.message}</p>}
      {run && (
        <p className="text-muted-foreground">
          Last pass: {run.showsChecked} shows checked ({run.verifiedShows} verified, {run.unverifiedShows} unverified, {run.unavailableShows} unavailable) · {run.premiered} premieres in the last 48 h
          ({run.alreadyWatched} already watched, {run.beforeOptIn} before opt-in) · {run.ledgerCreated} queued · {run.delivered} sent · {run.retry} retrying · {run.failed} failed · {run.uncertain} uncertain · {run.skipped} skipped
        </p>
      )}
      <div>
        <p className="font-medium">Devices ({devices.length})</p>
        {devices.length === 0 && <p className="text-muted-foreground">No device is subscribed on this account.</p>}
        {devices.map(d => (
          <p key={d.id} className="text-muted-foreground">
            {d.userAgent ? d.userAgent.replace(/^Mozilla\/5\.0 \(/, "(").slice(0, 60) : "Unknown device"} · subscribed {when(d.notifyFrom)} · last delivery {ago(d.lastSuccessAt)}{d.failureCount ? ` · ${d.failureCount} failure${d.failureCount === 1 ? "" : "s"} (last ${ago(d.lastFailureAt)})` : ""}
          </p>
        ))}
      </div>
      <div>
        <p className="font-medium">Shows: {shows.eligible} of {shows.total} can alert</p>
        {notEligible.length > 0 && (
          <ul className="text-muted-foreground">
            {notEligible.map(s => <li key={s.showId}>{s.name}: {s.reason ? reasonLabel[s.reason] : "not eligible"}{s.detail ? ` — ${s.detail}` : ""}</li>)}
          </ul>
        )}
        <p className="mt-1 text-muted-foreground">Premiered in the last 48 h: {recent.length === 0 ? "nothing from your eligible shows" : recent.map(s => `${s.name} S${s.lastPremiere!.season}E${s.lastPremiere!.number}${s.lastPremiere!.watched ? " (watched)" : ""}`).join(", ")}</p>
        {upcoming.length > 0 && <p className="text-muted-foreground">Next up: {upcoming.map(s => `${s.name} S${s.nextEpisode!.season}E${s.nextEpisode!.number} (${when(s.nextEpisode!.premieresAt)})`).join(", ")}</p>}
      </div>
      <div>
        <p className="font-medium">Delivery history ({deliveries.length})</p>
        {deliveries.length === 0 && <p className="text-muted-foreground">No alert has been queued for this account yet. Alerts appear here as soon as an eligible episode premieres after a device subscribed.</p>}
        {deliveries.slice(0, 20).map(d => (
          <p key={d.id} className="text-muted-foreground">
            {d.showName || "Removed show"} S{d.season}E{d.episode} · premiered {when(d.premieredAt)} · {deliveryLabel[d.status] || d.status}{d.sentAt ? ` ${when(d.sentAt)}` : ""}{d.attempts ? ` · ${d.attempts} attempt${d.attempts === 1 ? "" : "s"}` : ""}{d.lastError ? ` · ${d.lastError}` : ""}
          </p>
        ))}
      </div>
      <p className="text-muted-foreground">Checked {when(data.generatedAt)}.</p>
    </div>
  );
}

/** New-episode push settings for this device. Permission is requested only when Enable notifications is tapped. */
export default function NotificationSettings() {
  const push = usePushNotifications();
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [diagnostics, setDiagnostics] = useState<{ loading: boolean; data: NotificationDiagnostics | null; error: string | null }>({ loading: false, data: null, error: null });
  const status = explain({ support: push.support, permission: push.permission, device: push.device, serverConfigured: push.serverConfigured, error: push.error });
  const canSubscribe = push.support === "supported" && push.serverConfigured !== false && push.permission !== "denied";
  const active = push.device === "active" && push.permission === "granted";
  const newEpisodes = push.preferences?.newEpisodes ?? true;

  const test = async (preview = false) => {
    setTestResult(null);
    setTestResult(await push.sendTest(preview));
  };
  const loadDiagnostics = async () => {
    setDiagnostics({ loading: true, data: null, error: null });
    try { setDiagnostics({ loading: false, data: await NotificationService.getDiagnostics(), error: null }); }
    catch { setDiagnostics({ loading: false, data: null, error: "Diagnostics are unavailable right now." }); }
  };

  return (
    <section aria-labelledby="notification-settings-title" className="space-y-3 rounded-2xl border bg-card/60 p-4">
      <div className="flex items-center gap-2">
        <Bell className="size-4 text-primary" aria-hidden="true" />
        <h3 id="notification-settings-title" className="text-sm font-semibold">Notifications</h3>
      </div>

      <div role="status" className={`rounded-xl border px-3 py-2.5 ${toneClass[status.tone]}`}>
        <p className="text-sm font-medium">{status.title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{status.detail}</p>
        {push.support === "ios_install_required" && (
          <ol className="mt-2 space-y-1 text-xs text-muted-foreground">
            <li className="flex items-center gap-2"><Share className="size-3.5 shrink-0 text-primary" aria-hidden="true" />1. Tap the Share button in Safari’s toolbar.</li>
            <li className="flex items-center gap-2"><SquarePlus className="size-3.5 shrink-0 text-primary" aria-hidden="true" />2. Choose Add to Home Screen, then Add.</li>
            <li className="flex items-center gap-2"><Bell className="size-3.5 shrink-0 text-primary" aria-hidden="true" />3. Open Cinetra from the Home Screen and enable notifications here.</li>
          </ol>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-lg bg-muted/40 px-3 py-2"><dt className="text-muted-foreground">Browser permission</dt><dd className="mt-1"><Pill ok={push.support === "supported" && push.permission === "granted"}>{push.support === "supported" ? permissionLabel[push.permission] : "Not available here"}</Pill></dd></div>
        <div className="rounded-lg bg-muted/40 px-3 py-2"><dt className="text-muted-foreground">This device</dt><dd className="mt-1"><Pill ok={active}>{active ? deviceLabel.active : push.device === "active" ? deviceLabel.inactive : deviceLabel[push.device]}</Pill></dd></div>
      </dl>

      <div className="flex flex-wrap gap-2">
        {active ? (
          <Button type="button" variant="outline" size="sm" disabled={!!push.busy} onClick={() => void push.disable()} className="gap-1.5">
            {push.busy === "disable" ? <Loader2 className="size-4 animate-spin" /> : <BellOff className="size-4" />}Disable notifications
          </Button>
        ) : (
          <Button type="button" size="sm" disabled={!canSubscribe || !!push.busy} onClick={() => void push.enable()} className="gap-1.5">
            {push.busy === "enable" ? <Loader2 className="size-4 animate-spin" /> : <Bell className="size-4" />}Enable notifications
          </Button>
        )}
        <Button type="button" variant="outline" size="sm" disabled={!active || !!push.busy} onClick={() => void test()} className="gap-1.5">
          {push.busy === "test" ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}Send test notification
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={!active || !!push.busy} onClick={() => void test(true)} className="gap-1.5">
          {push.busy === "preview" ? <Loader2 className="size-4 animate-spin" /> : <Clapperboard className="size-4" />}Preview episode alert
        </Button>
      </div>

      {testResult && <p role="status" className={`text-xs ${testResult.ok ? "text-primary" : "text-destructive"}`}>{testResult.message}</p>}

      <div className="rounded-xl border border-border bg-muted/30 p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">Is it actually working? Check the server scheduler, your devices and every alert queued for this account.</p>
          <Button type="button" variant="ghost" size="sm" disabled={diagnostics.loading} onClick={() => void loadDiagnostics()} className="shrink-0 gap-1.5">
            {diagnostics.loading ? <Loader2 className="size-4 animate-spin" /> : <Activity className="size-4" />}{diagnostics.data ? "Refresh" : "Check status"}
          </Button>
        </div>
        {diagnostics.error && <p role="status" className="mt-2 text-xs text-destructive">{diagnostics.error}</p>}
        {diagnostics.data && <div className="mt-3"><Diagnostics data={diagnostics.data} /></div>}
      </div>

      <div className="divide-y border-t">
        <Row title="New TV episodes" detail="When a new episode of a show in your library premieres">
          <Switch label="New TV episodes" checked={newEpisodes} disabled={push.busy === "preference" || !push.preferences} onChange={value => void push.setNewEpisodes(value)} />
        </Row>
        <Row title="Movie notifications" detail="Not available yet"><Switch label="Movie notifications" checked={false} disabled /></Row>
        <Row title="Daily digest" detail="Not available yet"><Switch label="Daily digest" checked={false} disabled /></Row>
        <Row title="Show scope" detail="Watching, Completed, Planned, Paused and shows without a status">
          <span className="text-xs font-medium text-primary">All except Dropped</span>
        </Row>
      </div>
    </section>
  );
}
