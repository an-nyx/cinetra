import { Palette } from "lucide-react";
import { T } from "@/i18n";
import { setProgressPosterPreference, useProgressPosterPreference } from "@/lib/progress-poster-preference";
import { setCelebrationPreference, useCelebrationPreference } from "@/lib/celebration-preference";

/** Display preferences stored on this device. Changes apply immediately; there is no Save step. */
export default function AppearanceSettings() {
  const progressPoster = useProgressPosterPreference();
  const celebrations = useCelebrationPreference();
  return (
    <section aria-labelledby="appearance-settings-title" className="space-y-1 rounded-2xl border bg-card/60 p-4">
      <div className="flex items-center gap-2">
        <Palette className="size-4 text-primary" aria-hidden="true" />
        <h3 id="appearance-settings-title" className="text-sm font-semibold"><T>Appearance</T></h3>
      </div>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p id="progress-poster-label" className="text-sm font-medium"><T>Progress Poster</T></p>
          <p id="progress-poster-detail" className="text-xs text-muted-foreground"><T>Display your watching progress directly on TV show posters.</T></p>
        </div>
        {/* Same switch as Notifications, inside a 44px hit area for touch. */}
        <button type="button" role="switch" aria-checked={progressPoster} aria-labelledby="progress-poster-label" aria-describedby="progress-poster-detail"
          onClick={() => setProgressPosterPreference(!progressPoster)}
          className="group -me-2 inline-flex size-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-none">
          <span aria-hidden="true" className={`relative inline-flex h-6 w-10 items-center rounded-full border transition-colors group-focus-visible:ring-2 group-focus-visible:ring-ring motion-reduce:transition-none ${progressPoster ? "border-primary bg-primary" : "border-foreground/45 bg-foreground/20 dark:border-border dark:bg-muted"}`}>
            <span className={`inline-block size-4 rounded-full bg-background shadow transition-transform motion-reduce:transition-none ${progressPoster ? "translate-x-5 rtl:-translate-x-5" : "translate-x-1 rtl:-translate-x-1"}`} />
          </span>
        </button>
      </div>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p id="celebrations-label" className="text-sm font-medium"><T>Celebration Animations</T></p>
          <p id="celebrations-detail" className="text-xs text-muted-foreground"><T>Celebrate episode, season and series milestones with cinematic animations.</T></p>
        </div>
        <button type="button" role="switch" aria-checked={celebrations} aria-labelledby="celebrations-label" aria-describedby="celebrations-detail"
          onClick={() => setCelebrationPreference(!celebrations)}
          className="group -me-2 inline-flex size-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-none">
          <span aria-hidden="true" className={`relative inline-flex h-6 w-10 items-center rounded-full border transition-colors group-focus-visible:ring-2 group-focus-visible:ring-ring motion-reduce:transition-none ${celebrations ? "border-primary bg-primary" : "border-foreground/45 bg-foreground/20 dark:border-border dark:bg-muted"}`}>
            <span className={`inline-block size-4 rounded-full bg-background shadow transition-transform motion-reduce:transition-none ${celebrations ? "translate-x-5 rtl:-translate-x-5" : "translate-x-1 rtl:-translate-x-1"}`} />
          </span>
        </button>
      </div>
    </section>
  );
}
