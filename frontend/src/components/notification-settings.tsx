import { Bell, BellOff, Loader2, Send, Share, SquarePlus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { usePushNotifications } from "@/hooks/use-push-notifications";
import { deviceLabel, explain, permissionLabel, type Explanation } from "@/lib/push-support";

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

/** New-episode push settings for this device. Permission is requested only when Enable notifications is tapped. */
export default function NotificationSettings() {
  const push = usePushNotifications();
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const status = explain({ support: push.support, permission: push.permission, device: push.device, serverConfigured: push.serverConfigured, error: push.error });
  const canSubscribe = push.support === "supported" && push.serverConfigured !== false && push.permission !== "denied";
  const active = push.device === "active" && push.permission === "granted";
  const newEpisodes = push.preferences?.newEpisodes ?? true;

  const test = async () => {
    setTestResult(null);
    setTestResult(await push.sendTest());
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
      </div>

      {testResult && <p role="status" className={`text-xs ${testResult.ok ? "text-primary" : "text-destructive"}`}>{testResult.message}</p>}

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
