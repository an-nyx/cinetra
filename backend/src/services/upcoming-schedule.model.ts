export type ScheduleSource = 'TMDB' | 'TVMaze';
export type UpcomingItem = {
  showId: string; showName: string; posterURL: string | null; showStatus: string | null;
  season: number | null; number: number | null; name: string; airDate: string; airTimestamp: string | null;
  seasonPremiere: boolean; scheduleSource: ScheduleSource; scheduleConflict: boolean;
};

export function upcomingItemKey(item: UpcomingItem) {
  return item.season && item.number
    ? `${item.showId}:${item.season}:${item.number}`
    : `${item.showId}:${item.airDate}:${item.name.trim().toLocaleLowerCase()}`;
}

export function mergeUpcomingItems(items: UpcomingItem[]) {
  const merged = new Map<string, UpcomingItem>();
  for (const item of items) {
    const key = upcomingItemKey(item);
    const title = item.name.trim().toLocaleLowerCase();
    let currentKey = key;
    let current = merged.get(key);
    if (!current && title) {
      const sameTitleAndDate = [...merged.entries()].find(([, existing]) =>
        existing.showId === item.showId && existing.airDate === item.airDate && existing.name.trim().toLocaleLowerCase() === title,
      );
      if (sameTitleAndDate) [currentKey, current] = sameTitleAndDate;
    }
    if (!current) { merged.set(key, item); continue; }
    if (currentKey === key && current.airDate !== item.airDate) {
      const preferred = current.scheduleSource === 'TMDB' ? current : item.scheduleSource === 'TMDB' ? item : current;
      merged.set(key, { ...preferred, scheduleConflict: true });
      continue;
    }
    if (current.scheduleSource !== 'TMDB' && item.scheduleSource === 'TMDB') {
      merged.delete(currentKey);
      merged.set(key, item);
    }
  }
  return [...merged.values()];
}

export function isReturningWithoutDate(broadcastStatus: string | null | undefined, hasDatedRelease: boolean) {
  return !hasDatedRelease && ['Returning Series', 'In Production', 'Planned'].includes(broadcastStatus || '');
}
