import type { TrackingSummary } from "../services/show.service";
import type { ShowType } from "../types/index";
import { createConfirmedSummaries, trackingTick, type ConfirmedSummary } from "./tracking-sync.ts";

/**
 * Serialize Home writes and reject reads started before a mutation or a newer read. Confirmed summaries (from Home's
 * own saves or the Watch Room) patch one show in place; a library read that started earlier cannot undo them.
 */
export function createHomeTracking({
  read, save, publish, pending,
}: {
  read: () => Promise<[ShowType[], TrackingSummary[]]>;
  save: (item: TrackingSummary) => Promise<unknown>;
  publish: (library: ShowType[], tracking: TrackingSummary[]) => void;
  pending: (value: string | null) => void;
}) {
  let version = 0;
  let writing = false;
  let awaitingRefresh = false;
  let shown: { library: ShowType[]; tracking: TrackingSummary[] } | null = null;
  const confirmed = createConfirmedSummaries();
  const show = (library: ShowType[], tracking: TrackingSummary[]) => { shown = { library, tracking }; publish(library, tracking); };
  const load = async () => {
    if (writing) return;
    const request = ++version;
    const started = trackingTick();
    let result: [ShowType[], TrackingSummary[]];
    try { result = await read(); }
    catch (error) { if (request === version) throw error; return; }
    const [library, tracking] = result;
    if (request !== version) return;
    show(library, confirmed.merge(tracking, started));
    awaitingRefresh = false;
    pending(null);
  };
  /** Apply a confirmed summary. False when a newer save for that show was already applied. */
  const apply = (update: ConfirmedSummary) => {
    if (!confirmed.accept(update)) return false;
    if (shown) show(shown.library, confirmed.merge(shown.tracking));
    return true;
  };
  return {
    load,
    apply,
    invalidate() { ++version; },
    async mark(item: TrackingSummary) {
      if (writing || awaitingRefresh || !item.nextEpisode) return;
      const mutation = ++version;
      const started = trackingTick();
      writing = true;
      pending(item.showId);
      // Keep confirmed nextEpisode and eligibility intact while the write is pending.
      let result: unknown;
      try { result = await save(item); }
      catch (error) { writing = false; if (mutation !== version) return; pending(null); throw error; }
      if (mutation !== version) { writing = false; return; }
      writing = false;
      // The save answers with the committed progress: show it without reloading the library.
      const summary = (result as { summary?: TrackingSummary | null } | null)?.summary;
      if (summary && summary.showId === item.showId) {
        apply({ summary, started, confirmed: trackingTick() });
        pending(null);
        return;
      }
      awaitingRefresh = true;
      // A refresh failure must not undo the save or enable marking the stale episode again.
      try { await load(); }
      catch { throw new Error("Episode saved. Refresh the dashboard to load the next episode."); }
    },
  };
}
