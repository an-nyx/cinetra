import type { TrackingSummary } from "../services/show.service";
import type { ShowType } from "../types/index";

/** Serialize Home writes and reject reads started before a mutation or a newer read. */
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
  const load = async () => {
    if (writing) return;
    const request = ++version;
    let result: [ShowType[], TrackingSummary[]];
    try { result = await read(); }
    catch (error) { if (request === version) throw error; return; }
    const [library, tracking] = result;
    if (request !== version) return;
    publish(library, tracking);
    awaitingRefresh = false;
    pending(null);
  };
  return {
    load,
    invalidate() { ++version; },
    async mark(item: TrackingSummary) {
      if (writing || awaitingRefresh || !item.nextEpisode) return;
      const mutation = ++version;
      writing = true;
      pending(item.showId);
      // Keep confirmed nextEpisode and eligibility intact while the write is pending.
      try { await save(item); }
      catch (error) { writing = false; if (mutation !== version) return; pending(null); throw error; }
      if (mutation !== version) { writing = false; return; }
      writing = false;
      awaitingRefresh = true;
      // A refresh failure must not undo the save or enable marking the stale episode again.
      try { await load(); }
      catch { throw new Error("Episode saved. Refresh the dashboard to load the next episode."); }
    },
  };
}
