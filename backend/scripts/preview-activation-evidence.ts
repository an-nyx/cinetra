/** Fresh public schedule evidence only. No database, credentials, personal tracking, or writes. */
import fs from 'node:fs';
import axios from 'axios';
import type { TVMazeEpisode, TVMazeShow } from '../src/services/tvmaze/tvmaze-schedule.model';
import { premiereInstant, scheduleTimeZone } from '../src/services/notifications/episode-alerts.model';

const requested = [
  { title: 'Loki', tvmazeId: 41007 },
  { title: 'Mayor of Kingstown', tvmazeId: 45840 },
  { title: 'MobLand', tvmazeId: 75026 },
  { title: 'Reacher', tvmazeId: 43031 },
  { title: 'The Lord of the Rings: The Rings of Power', tvmazeId: 33352 },
  { title: 'Tulsa King', tvmazeId: 59344 },
];
async function main() {
  const now = new Date();
  const shows = [];
  for (const target of requested) {
    const schedule = (await axios.get<TVMazeShow & { _embedded: { episodes: TVMazeEpisode[] } }>(`https://api.tvmaze.com/shows/${target.tvmazeId}`, { params: { embed: 'episodes' }, timeout: 30000 })).data;
    if (schedule.id !== target.tvmazeId || schedule.name !== target.title) throw new Error(`Unexpected schedule identity for ${target.title}`);
    const timeZone = scheduleTimeZone(schedule);
    const regular = schedule._embedded.episodes.filter(e => (e.season ?? 0) > 0 && (e.number ?? 0) > 0 && (!e.type || e.type === 'regular'));
    const grouped = new Map<string, TVMazeEpisode[]>();
    for (const e of regular) { const key = `S${e.season}E${e.number}`; grouped.set(key, [...(grouped.get(key) ?? []), e]); }
    const episodes = [...grouped].map(([key, records]) => {
      const times = records.map(e => premiereInstant(e, timeZone)?.at.getTime() ?? null);
      const dated = times.filter((t): t is number => t !== null);
      const earliest = dated.length ? Math.min(...dated) : null;
      const unambiguous = dated.length === times.length && dated.filter(t => t === earliest).length === 1;
      return { key, season: records[0].season!, airDates: records.map(e => e.airdate), airstamps: records.map(e => e.airstamp),
        certainlyPremieredAt: earliest === null ? null : new Date(earliest).toISOString(), schedulePremiered: unambiguous && earliest! <= now.getTime() };
    });
    shows.push({ title: target.title, tvmazeId: target.tvmazeId, externals: schedule.externals, source: `https://www.tvmaze.com/shows/${target.tvmazeId}/episodes`, timeZone, episodes });
  }
  const report = { checkedAt: now.toISOString(), readOnly: true, productionLibraryRead: false, canonicalAndTrackingRecheck: 'Requires authenticated production library; this report alone cannot authorize a correction.', writesExecuted: 0, shows };
  const output = process.env.CINETRA_ACTIVATION_EVIDENCE_PATH || '/tmp/cinetra-activation-provider-evidence.json';
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ checkedAt: report.checkedAt, output, shows: shows.map(s => ({ title: s.title, tvmazeId: s.tvmazeId, seasons: [...new Set(s.episodes.map(e => e.season))].map(season => { const released = s.episodes.filter(e => e.season === season && e.schedulePremiered); return { season, schedulePremiered: released.length, first: released[0], latest: released.at(-1) }; }) })) }, null, 2));
}
main().catch(error => { console.error('Fresh schedule check failed:', axios.isAxiosError(error) ? { name: error.name, status: error.response?.status } : error instanceof Error ? error.message : 'unknown error'); process.exitCode = 1; });
