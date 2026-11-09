import assert from 'node:assert/strict';
import { chooseVerifiedTVMazeMatch, verifyTVMazeIdentity } from '../src/services/tvmaze/upcoming-schedule.service';
import { isReturningWithoutDate, mergeUpcomingItems, type UpcomingItem } from '../src/services/upcoming-schedule.model';

const identity = {
  tmdbName: 'Example Series', tmdbOriginalName: 'Example Series', libraryName: 'Example Series',
  firstAirDate: '2020-03-01', tmdbOverview: 'A detective investigates unusual events in a coastal town.',
};
const correct = { id: 10, name: 'Example Series', premiered: '2020-03-01', summary: '<p>A detective investigates strange events in a coastal town.</p>' };
const remake = { id: 11, name: 'Example Series', premiered: '2024-01-01', summary: 'A detective investigates unusual events in a coastal town.' };
const similarTitleOnly = { id: 12, name: 'The Example Series', premiered: '2020-03-01', summary: 'A detective investigates unusual events in a coastal town.' };
assert.equal(verifyTVMazeIdentity(identity, correct).verified, true, 'matching title, year, and synopsis verifies the schedule identity');
assert.equal(verifyTVMazeIdentity(identity, remake).verified, false, 'same-title remake with another year is rejected');
assert.equal(verifyTVMazeIdentity(identity, similarTitleOnly).verified, false, 'title similarity alone is insufficient');
assert.equal(chooseVerifiedTVMazeMatch(identity, [correct, { ...correct, id: 13 }]).status, 'ambiguous', 'multiple verified candidates are excluded');
assert.equal(chooseVerifiedTVMazeMatch(identity, [correct]).show?.id, 10);

const item = (source: UpcomingItem['scheduleSource'], airDate: string, season: number | null = 2, number: number | null = 3, name = 'Next') : UpcomingItem => ({
  showId: 'show-a', showName: 'Example Series', posterURL: null, showStatus: 'watching', season, number,
  name, airDate, airTimestamp: null, seasonPremiere: false, scheduleSource: source, scheduleConflict: false,
});
const duplicate = mergeUpcomingItems([item('TMDB', '2030-05-01'), item('TVMaze', '2030-05-01')]);
assert.equal(duplicate.length, 1, 'same episode from both providers is shown once');
assert.equal(duplicate[0].scheduleSource, 'TMDB', 'TMDB remains the preferred schedule source');
assert.equal(mergeUpcomingItems([item('TMDB', '2030-05-01'), item('TVMaze', '2030-05-01', null, null)]).length, 1, 'same title and date deduplicate even when TVMaze numbering cannot map');
assert.equal(mergeUpcomingItems([item('TVMaze', '2030-05-01', null, null), item('TMDB', '2030-05-01')])[0].scheduleSource, 'TMDB', 'TMDB supersedes a same-date unmapped supplement');
const conflict = mergeUpcomingItems([item('TMDB', '2030-05-01'), item('TVMaze', '2030-05-02')]);
assert.equal(conflict.length, 1, 'conflicting dates do not create duplicate cards');
assert.equal(conflict[0].airDate, '2030-05-01', 'TMDB date is retained');
assert.equal(conflict[0].scheduleConflict, true, 'date conflict is surfaced');
assert.equal(mergeUpcomingItems([item('TVMaze', '2030-05-01', null, null), item('TVMaze', '2030-05-01', null, null)]).length, 1, 'unmapped duplicate schedule records are deduplicated by date and title');
assert.equal(isReturningWithoutDate('Returning Series', false), true);
assert.equal(isReturningWithoutDate('In Production', false), true);
assert.equal(isReturningWithoutDate('Ended', false), false, 'Ended alone is not interpreted as an upcoming schedule');
assert.equal(isReturningWithoutDate('Returning Series', true), false, 'dated releases do not also appear in Date TBA');

console.log('upcoming schedule tests passed');
