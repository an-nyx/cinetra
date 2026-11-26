import { test } from 'node:test';
import assert from 'node:assert/strict';
const values = new Map();
let broken = false;
globalThis.localStorage = {
  getItem: key => { if (broken) throw new Error('blocked'); return values.get(key) ?? null; },
  setItem: (key, value) => { if (broken) throw new Error('blocked'); values.set(key, value); },
  removeItem: key => values.delete(key),
};
const { CELEBRATION_STORAGE_KEY, getCelebrationPreference, setCelebrationPreference, subscribeCelebrationPreference } = await import('../src/lib/celebration-preference.ts');
const { PROGRESS_POSTER_STORAGE_KEY, getProgressPosterPreference } = await import('../src/lib/progress-poster-preference.ts');

test('defaults to ON for users without a saved preference', () => {
  values.clear();
  assert.equal(getCelebrationPreference(), true);
});

test('only the exact saved value "off" disables celebrations', () => {
  for (const [saved, expected] of [['off', false], ['on', true], ['false', true], ['', true], ['0', true]]) {
    values.set(CELEBRATION_STORAGE_KEY, saved);
    assert.equal(getCelebrationPreference(), expected, saved);
  }
});

test('turning it off and on persists (survives a reload) and notifies subscribers immediately', () => {
  values.clear();
  let calls = 0;
  const unsubscribe = subscribeCelebrationPreference(() => calls++);
  setCelebrationPreference(false);
  assert.equal(values.get(CELEBRATION_STORAGE_KEY), 'off');
  assert.equal(getCelebrationPreference(), false);
  setCelebrationPreference(true);
  assert.equal(values.get(CELEBRATION_STORAGE_KEY), 'on');
  assert.equal(getCelebrationPreference(), true);
  assert.equal(calls, 2);
  unsubscribe();
  setCelebrationPreference(false);
  assert.equal(calls, 2);
  setCelebrationPreference(true);
});

test('is independent of the Progress Poster preference', () => {
  values.clear();
  setCelebrationPreference(false);
  assert.equal(values.has(PROGRESS_POSTER_STORAGE_KEY), false);
  assert.equal(getProgressPosterPreference(), false, 'Progress Poster keeps its own default');
  assert.notEqual(CELEBRATION_STORAGE_KEY, PROGRESS_POSTER_STORAGE_KEY);
  setCelebrationPreference(true);
});

test('unavailable storage falls back to ON and keeps the in-session choice without throwing', () => {
  values.clear();
  broken = true;
  try {
    assert.equal(getCelebrationPreference(), true);
    setCelebrationPreference(false);
    assert.equal(getCelebrationPreference(), false);
    setCelebrationPreference(true);
    assert.equal(getCelebrationPreference(), true);
  } finally { broken = false; }
});
