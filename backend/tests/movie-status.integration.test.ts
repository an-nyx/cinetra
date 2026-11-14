/** Movie statuses (Watchlist, Watched, Dropped) through the HTTP API against the disposable test database. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

if (!process.env.DATABASE_URL?.includes('/cinetra_episode_toggle_test_20261109')) throw new Error('Use the isolated test database only.');
process.env.JWT_SECRET ||= crypto.randomBytes(32).toString('hex');

async function main() {
  const { prisma } = await import('../src/database/prisma');
  const { securityModule } = await import('../src/modules/security');
  const express = (await import('express')).default;
  const apiRoutes = (await import('../src/api/v1')).default;
  const app = express(); app.use(express.json()); app.use('/api/v1', apiRoutes);
  const server = await new Promise<http.Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const user = await prisma.user.create({ data: { email: `movies-${crypto.randomUUID()}@example.invalid`, username: 'movies', password: 'not-a-password' } });
  const other = await prisma.user.create({ data: { email: `movies-other-${crypto.randomUUID()}@example.invalid`, username: 'other', password: 'not-a-password' } });
  const call = async (method: string, path: string, body?: unknown, who = user.id) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${securityModule.Commands.GenerateTokenCommand.execute(who)}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  // An existing movie with every personal field filled in, plus a legacy movie without a status.
  const movie = await prisma.movie.create({ data: { userId: user.id, name: 'Runner', tmdbId: 777001, status: 'watched', rating: 6, favorite: true, notes: 'Great score.' } });
  await prisma.movieWatch.create({ data: { movieId: movie.id } });
  const legacy = await prisma.movie.create({ data: { userId: user.id, name: 'Gladiator II', tmdbId: 777002, status: null, rating: 10 } });
  const personal = (m: { rating: number | null; favorite: boolean; notes: string | null; name: string; tmdbId: number | null }) => [m.rating, m.favorite, m.notes, m.name, m.tmdbId];

  const dropped = await call('PUT', `/movie/${movie.id}`, { status: 'dropped' });
  assert.equal(dropped.status, 200);
  assert.equal(dropped.json.status, 'dropped');
  assert.deepEqual(personal(dropped.json), [6, true, 'Great score.', 'Runner', 777001], 'rating, favorite and notes are kept');
  assert.equal(await prisma.movie.count({ where: { userId: user.id } }), 2, 'Dropped keeps the movie in the library');
  assert.equal(await prisma.movieWatch.count({ where: { movieId: movie.id } }), 1, 'viewing history kept');
  for (const status of ['watchlist', 'watched', 'dropped', null]) {
    const r = await call('PUT', `/movie/${movie.id}`, { status });
    assert.deepEqual([r.status, r.json.status], [200, status]);
    assert.deepEqual(personal(r.json), [6, true, 'Great score.', 'Runner', 777001]);
  }
  // Rating changes keep the status (also for Dropped).
  await call('PUT', `/movie/${movie.id}`, { status: 'dropped' });
  const rated = await call('PUT', `/movie/${movie.id}`, { rating: 3 });
  assert.deepEqual([rated.json.status, rated.json.rating], ['dropped', 3]);
  // Validation and isolation.
  for (const status of ['abandoned', 'DROPPED', 3, '']) assert.equal((await call('PUT', `/movie/${movie.id}`, { status })).status, 400, `rejects ${JSON.stringify(status)}`);
  assert.equal((await call('PUT', `/movie/${movie.id}`, { rating: 0 })).status, 400, '0 is never stored as a rating');
  assert.equal((await call('PUT', `/movie/${movie.id}`, { status: 'dropped' }, other.id)).status, 404, 'another user cannot change it');
  // Untouched rows stay exactly as they were.
  const legacyAfter = await prisma.movie.findUniqueOrThrow({ where: { id: legacy.id } });
  assert.deepEqual([legacyAfter.status, legacyAfter.rating, legacyAfter.updatedAt.getTime()], [null, 10, legacy.updatedAt.getTime()], 'existing statuses are never rewritten');
  const list = await call('GET', '/movie');
  assert.deepEqual(list.json.map((m: { name: string; status: string | null; rating: number | null }) => [m.name, m.status, m.rating]).sort(), [['Gladiator II', null, 10], ['Runner', 'dropped', 3]]);
  server.close();
  await prisma.$executeRawUnsafe('TRUNCATE "MovieWatch", "Movie", "User" CASCADE');
  console.log('Movie status integration tests passed');
  await prisma.$disconnect();
}
main().catch(error => { console.error(error); process.exit(1); });
