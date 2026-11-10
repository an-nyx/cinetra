import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localizedEpisodeLine, calendarRelative } from '../src/i18n/calendar.ts';

const episode = (season, number) => ({ season, number, seasonPremiere: number === 1 });
test('localized schedule lines preserve season and episode identity', () => {
  const single = { episodes: [episode(2, 1)], premiere: true };
  assert.equal(localizedEpisodeLine('en', single), 'S02E01 · Season 2 premiere');
  assert.match(localizedEpisodeLine('fr', single), /S02E01.*saison 2/);
  assert.match(localizedEpisodeLine('ar', single), /S02E01.*الموسم 2/);
  const group = { episodes: [episode(3, 2), episode(3, 3)], premiere: false };
  assert.match(localizedEpisodeLine('fr', group), /Saison 3.*2–3/);
  assert.match(localizedEpisodeLine('ar', group), /الموسم 3.*2–3/);
});
test('relative day labels use the selected language', () => {
  const now = new Date(2026, 10, 11, 12);
  assert.equal(calendarRelative('fr', '2026-11-11', now), 'Aujourd’hui');
  assert.equal(calendarRelative('ar', '2026-11-12', now), 'غدًا');
});
