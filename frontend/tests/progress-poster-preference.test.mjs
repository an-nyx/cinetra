import { test } from 'node:test';
import assert from 'node:assert/strict';
const values = new Map();
let broken = false;
globalThis.localStorage = {
  getItem: key => { if (broken) throw new Error('blocked'); return values.get(key) ?? null; },
  setItem: (key, value) => { if (broken) throw new Error('blocked'); values.set(key, value); },
  removeItem: key => values.delete(key),
};
const { PROGRESS_POSTER_STORAGE_KEY, getProgressPosterPreference, setProgressPosterPreference, subscribeProgressPosterPreference } = await import('../src/lib/progress-poster-preference.ts');

test('defaults to OFF for users without a saved preference', () => {
  values.clear();
  assert.equal(getProgressPosterPreference(), false);
});

test('only the exact saved value "on" enables the effect', () => {
  for (const [saved, expected] of [['on', true], ['off', false], ['true', false], ['', false], ['1', false]]) {
    values.set(PROGRESS_POSTER_STORAGE_KEY, saved);
    assert.equal(getProgressPosterPreference(), expected, saved);
  }
});

test('enabling and disabling persist and notify subscribers immediately', () => {
  values.clear();
  let calls = 0;
  const unsubscribe = subscribeProgressPosterPreference(() => calls++);
  setProgressPosterPreference(true);
  assert.equal(values.get(PROGRESS_POSTER_STORAGE_KEY), 'on');
  assert.equal(getProgressPosterPreference(), true);
  setProgressPosterPreference(false);
  assert.equal(values.get(PROGRESS_POSTER_STORAGE_KEY), 'off');
  assert.equal(getProgressPosterPreference(), false);
  assert.equal(calls, 2);
  unsubscribe();
  setProgressPosterPreference(true);
  assert.equal(calls, 2);
  setProgressPosterPreference(false);
});

test('unavailable storage falls back to OFF and keeps the in-session choice without throwing', () => {
  values.clear();
  broken = true;
  try {
    assert.equal(getProgressPosterPreference(), false);
    setProgressPosterPreference(true);
    assert.equal(getProgressPosterPreference(), true);
    setProgressPosterPreference(false);
    assert.equal(getProgressPosterPreference(), false);
  } finally { broken = false; }
});
