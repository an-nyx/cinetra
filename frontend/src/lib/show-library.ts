import type { ShowType } from '../types/index';

export type PersonalStatus = NonNullable<ShowType['status']> | 'none';
export type LibraryFilters = {
  favoriteFilter?: 'favorite' | 'notFavorite';
  completeFilter?: 'completed' | 'notCompleted';
  statusFilter?: PersonalStatus;
  sortBy?: 'nameAsc' | 'nameDesc' | 'dateNewest' | 'dateOldest' | 'updatedNewest' | 'updatedOldest';
};

/** Explicit status wins over the historical completed flag. */
export const personalStatus = (show: Pick<ShowType, 'status' | 'completed'>): PersonalStatus => show.status || (show.completed ? 'completed' : 'none');
export const personalStatusLabels: Record<PersonalStatus, string> = { watching: 'Watching', completed: 'Completed', dropped: 'Dropped', planned: 'Planned', paused: 'Paused', none: 'No status selected' };
export const personalStatusColors: Partial<Record<PersonalStatus, string>> = { watching: '#557da8', completed: '#5c9775', dropped: '#a75d60' };

export function filterAndSortShows(shows: ShowType[], search: string, filters: LibraryFilters): ShowType[] {
  return shows.filter(show => {
    if (!show.name.toLowerCase().includes(search.toLowerCase())) return false;
    if (filters.favoriteFilter === 'favorite' && !show.favorite) return false;
    if (filters.favoriteFilter === 'notFavorite' && show.favorite) return false;
    const status = personalStatus(show);
    if (filters.completeFilter === 'completed' && status !== 'completed') return false;
    if (filters.completeFilter === 'notCompleted' && status === 'completed') return false;
    if (filters.statusFilter && status !== filters.statusFilter) return false;
    return true;
  }).sort((a, b) => {
    switch (filters.sortBy) {
    case 'nameAsc': return a.name.localeCompare(b.name);
    case 'nameDesc': return b.name.localeCompare(a.name);
    case 'dateNewest': return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    case 'dateOldest': return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    case 'updatedNewest': return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    case 'updatedOldest': return new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
    default: return 0;
    }
  });
}
