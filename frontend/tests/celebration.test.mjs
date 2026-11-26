import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal browser globals: celebrations travel as window events.
globalThis.window ??= new EventTarget();
const { CELEBRATION_DURATION, STATIC_CELEBRATION_DURATION, classifyWatchMilestone, completedSeason, createCelebrationGate, celebrateNextEpisodeSave, celebrateWatch, onCelebration } = await import('../src/lib/celebration.ts');
const { createHomeTracking } = await import('../src/lib/home-tracking.ts');

const summary = (showId, over = {}) => ({
  showId, name: `Show ${showId}`, posterURL: null, status: 'watching', source: 'TMDB', guideAvailable: true, countDataAvailable: true, legacyPosition: null,
  watchedCount: 5, explicitWatchedCount: 5, legacyInferredCount: 0, releasedCount: 10, remainingCount: 5, progressPercent: 50,
  viewingState: 'in_progress', nextEpisode: { season: 1, number: 6, name: 'Six', airDate: '2026-01-01', runtime: 50, watchedAt: null },
  lastEpisode: null, upcomingEpisode: null, newEpisodes: 0, recentHistory: [], error: null, ...over,
});
const guide = (season, watched) => ({ season, episodes: watched.map((w, i) => ({ number: i + 1, watched: w })) });
const input = over => ({ before: summary('a'), after: summary('a'), season: 1, episode: 6, guideAfter: guide(1, [true, true, true, true, true, true, false]), ...over });

test('a regular episode is the subtle level', () => {
  assert.equal(classifyWatchMilestone(input()), 'episode');
});

test('watching the last episode of a season completes it', () => {
  assert.equal(classifyWatchMilestone(input({ guideAfter: guide(1, [true, true, true, true, true, true]) })), 'season');
  assert.equal(classifyWatchMilestone(input({ episode: null, guideAfter: guide(1, [true, true, true]) })), 'season', 'whole-season action');
});

test('season completion needs this save to be the one that finished it', () => {
  const full = guide(1, [true, true, true, true, true, true]);
  assert.equal(completedSeason(input({ guideAfter: full, seasonCompleteBefore: true })), false, 'already complete');
  assert.equal(completedSeason(input({ guideAfter: guide(2, [true, true]) })), false, 'guide of another season');
  assert.equal(completedSeason(input({ guideAfter: null })), false, 'no guide in the answer');
  assert.equal(completedSeason(input({ season: 0, guideAfter: { season: 0, episodes: [{ number: 6, watched: true }] } })), false, 'specials never count');
  assert.equal(completedSeason(input({ episode: 9, guideAfter: full })), false, 'episode missing from that guide');
  assert.equal(completedSeason(input({ guideAfter: { season: 1, episodes: [] } })), false);
});

test('all caught up outranks a season finale on an ongoing show', () => {
  const after = summary('a', { viewingState: 'caught_up', remainingCount: 0, nextEpisode: null });
  assert.equal(classifyWatchMilestone(input({ after, guideAfter: guide(1, [true, true, true, true, true, true]) })), 'caught_up');
});

test('series completed outranks everything, and only on a real transition to fully watched', () => {
  const after = summary('a', { viewingState: 'fully_watched', remainingCount: 0, nextEpisode: null, finalityConfirmed: true });
  assert.equal(classifyWatchMilestone(input({ after, guideAfter: guide(1, [true, true, true, true, true, true]) })), 'series');
  assert.equal(classifyWatchMilestone(input({ before: summary('a', { viewingState: 'fully_watched' }), after })), 'episode', 'already fully watched');
  assert.equal(classifyWatchMilestone(input({ before: summary('a', { viewingState: 'caught_up' }), after: summary('a', { viewingState: 'caught_up' }) })), 'episode', 'already caught up');
});

test('without the progress shown before the save, no series or caught-up celebration is inferred', () => {
  assert.equal(classifyWatchMilestone(input({ before: null, after: summary('a', { viewingState: 'fully_watched' }) })), 'episode');
  assert.equal(classifyWatchMilestone(input({ after: null })), 'episode');
  assert.equal(classifyWatchMilestone(input({ after: summary('other', { viewingState: 'fully_watched' }) })), 'episode', 'answer for another show');
});

test('the personal status is never consulted: a Completed status alone is not a series celebration', () => {
  const after = summary('a', { status: 'completed', viewingState: 'in_progress' });
  assert.equal(classifyWatchMilestone(input({ before: summary('a', { status: 'watching' }), after })), 'episode');
  const unverified = summary('a', { status: 'completed', viewingState: 'unknown', remainingCount: 0 });
  assert.equal(classifyWatchMilestone(input({ after: unverified })), 'episode', 'unverified finality');
});

test('the gate drops repeats of one save and never cuts a bigger celebration short', () => {
  let time = 0;
  const gate = createCelebrationGate({ dedupeMs: 5000, now: () => time });
  const series = { key: 'a:1:6', level: 'series' };
  assert.equal(gate.admit(series, 2200), true);
  assert.equal(gate.admit(series, 2200), false, 'same save twice (rapid taps / two components)');
  time = 500;
  assert.equal(gate.admit({ key: 'b:1:1', level: 'episode' }, 480), false, 'smaller one waits for the series to finish');
  time = 2300;
  assert.equal(gate.admit({ key: 'b:1:2', level: 'episode' }, 480), true, 'after it ends');
  assert.equal(gate.admit({ key: 'c:1:9', level: 'season' }, 1400), true, 'bigger one replaces a running check');
  time = 4000;
  assert.equal(gate.admit(series, 2200), false, 'still inside the dedupe window');
  time = 5100;
  assert.equal(gate.admit(series, 2200), true, 'window expired');
  gate.clear();
  assert.equal(gate.admit({ key: 'd:1:1', level: 'episode' }, 480), true, 'clear() ends the active one');
});

test('durations match the brief', () => {
  assert.ok(CELEBRATION_DURATION.episode >= 300 && CELEBRATION_DURATION.episode <= 500);
  assert.ok(CELEBRATION_DURATION.season >= 1000 && CELEBRATION_DURATION.season <= 1500);
  assert.ok(Math.abs(CELEBRATION_DURATION.series - 2000) <= 250);
  for (const level of Object.keys(CELEBRATION_DURATION)) assert.ok(STATIC_CELEBRATION_DURATION[level] >= CELEBRATION_DURATION[level]);
});

test('a confirmed next-episode save emits exactly one celebration with the highest level', () => {
  const seen = [];
  const stop = onCelebration(c => seen.push(c));
  try {
    const before = summary('a', { nextEpisode: { season: 2, number: 8 } });
    const after = summary('a', { viewingState: 'caught_up', remainingCount: 0, nextEpisode: null });
    celebrateNextEpisodeSave(before, { season: 2, number: 8 }, { summary: after, guide: guide(2, Array(8).fill(true)), statusChange: null }, null);
    assert.equal(seen.length, 1);
    assert.deepEqual({ level: seen[0].level, key: seen[0].key, showName: seen[0].showName, season: seen[0].season }, { level: 'caught_up', key: 'a:2:8', showName: 'Show a', season: 2 });
    // The answer for another show is ignored (guide included): only the subtle check.
    celebrateNextEpisodeSave(before, { season: 2, number: 8 }, { summary: summary('zz', { viewingState: 'fully_watched' }), guide: guide(2, Array(8).fill(true)) }, null);
    assert.equal(seen[1].level, 'episode');
    // No summary in the answer (older server): the save still succeeded, so the subtle check only.
    celebrateNextEpisodeSave(before, { season: 2, number: 8 }, { summary: null, guide: null }, null);
    assert.equal(seen[2].level, 'episode');
    celebrateWatch({ ...input({ episode: null, guideAfter: guide(1, [true, true]) }), showId: 'a', showName: 'A', anchor: null });
    assert.equal(seen[3].key, 'a:1:season');
  } finally { stop(); }
});

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test('Home resolves mark() with the save answer only when this tap saved and it is shown', async () => {
  const answer = { summary: summary('a', { watchedCount: 6 }), guide: null, statusChange: null };
  const flow = createHomeTracking({ read: async () => [[], [summary('a')]], save: async () => answer, publish: () => {}, pending: () => {} });
  await flow.load();
  assert.equal(await flow.mark(summary('a')), answer);

  // Failed save: rejects, nothing to celebrate.
  const failing = createHomeTracking({ read: async () => [[], []], save: async () => { throw Error('save failed'); }, publish: () => {}, pending: () => {} });
  await assert.rejects(failing.mark(summary('a')), /save failed/);

  // A second tap while the first save is pending is skipped and resolves without an answer.
  const slow = deferred();
  const busy = createHomeTracking({ read: async () => [[], []], save: () => slow.promise, publish: () => {}, pending: () => {} });
  const first = busy.mark(summary('a'));
  assert.equal(await busy.mark(summary('a')), undefined);
  slow.resolve(answer);
  assert.equal(await first, answer);

  // Superseded (e.g. the page unmounted): no answer.
  const late = deferred();
  const gone = createHomeTracking({ read: async () => [[], []], save: () => late.promise, publish: () => {}, pending: () => {} });
  const pending = gone.mark(summary('a'));
  gone.invalidate();
  late.resolve(answer);
  assert.equal(await pending, undefined);
});
