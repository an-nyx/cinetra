/**
 * Read-only, library-wide tracking audit against a running Cinetra API.
 *
 *   CINETRA_API_URL   Base URL of the app, e.g. https://cinetra.example.com (no /api/v1). HTTPS is required except for localhost.
 *   CINETRA_EMAIL     Optional; otherwise you are asked for it. The password is always typed at a hidden prompt.
 *   CINETRA_TOKEN     Optional alternative to logging in (not recommended: Cinetra session tokens never expire).
 *   AUDIT_TMDB_ENV    Env file holding a TMDB credential for the independent check (default: repository .env)
 *   AUDIT_OUTPUT_DIR  Where reports are written; must be outside the repository (default: a new private temp folder)
 *   AUDIT_BASELINE    Optional earlier report.json; preserved fields are compared against it
 *
 * Authentication: one POST to /api/v1/auth/login, which only verifies the password and returns a session token.
 * The token is kept in memory and discarded on exit. Every data request then goes through a client that refuses any
 * method other than GET before sending, never follows redirects, and never retries. Nothing is written to the database.
 *
 * Outputs: summary.json (aggregate counts only: no show names, IDs or viewing history; safe to share) and the private
 * report.md / report.json (per-show detail including your viewing history), all with owner-only permissions.
 */
import axios, { type AxiosInstance } from 'axios';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import { TMDBApiService } from '../src/services/tmdb/tmdb-api.service';
import { redactTMDBText } from '../src/services/tmdb/tmdb-error';
import {
  auditLibrarySurfaces, auditShow, auditUpcoming, comparePreservation, preservationRecord,
  categoryOf, type GuidePage, type Issue, type PreservationRecord, type RawShow, type ShowAudit, type Summary, type TMDBFacts, type UpcomingResponse,
} from './audit/tracking-audit.model';

const TMDB_KEYS = ['TMDB_READ_ACCESS_TOKEN', 'TMDB_API_KEY', 'API_AUTHORIZATION'] as const;

export async function pool<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await work(items[index]); }
  }));
  return results;
}

/** An HTTP client that can only read, and whose failures never carry the session token. */
export function readOnlyClient(baseURL: string, token: string, adapter?: AxiosInstance['defaults']['adapter']) {
  const authorization = /^Bearer\s/i.test(token) ? token : `Bearer ${token}`;
  const secret = authorization.replace(/^Bearer\s+/i, '');
  const client = axios.create({ baseURL: `${baseURL.replace(/\/+$/, '')}/api/v1`, timeout: 180_000, headers: { Authorization: authorization }, maxRedirects: 0, ...(adapter ? { adapter } : {}) });
  client.interceptors.request.use(config => {
    if ((config.method || 'get').toLowerCase() !== 'get') throw new Error('Read-only audit: only GET requests are allowed.');
    return config;
  });
  return async function get<T>(url: string): Promise<{ ok: true; data: T } | { ok: false; status: number | null; error: string }> {
    try {
      return { ok: true, data: (await client.get<T>(url)).data };
    } catch (error) {
      const status = axios.isAxiosError(error) ? error.response?.status ?? null : null;
      const serverMessage = axios.isAxiosError(error) && typeof error.response?.data?.message === 'string' ? `: ${error.response.data.message}` : '';
      const text = status ? `HTTP ${status}${serverMessage}` : error instanceof Error ? error.message : 'request failed';
      return { ok: false, status, error: redactTMDBText(text, [secret]) };
    }
  };
}

/** Refuse to send credentials over plain HTTP to anything but this machine. */
export function assertSecureURL(baseURL: string) {
  const url = new URL(baseURL);
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('CINETRA_API_URL must use https:// (plain http is allowed only for localhost).');
}

/** The single non-GET request: exchange email + password for a session token. Errors carry only the HTTP status. */
export async function login(baseURL: string, email: string, password: string, adapter?: AxiosInstance['defaults']['adapter']) {
  assertSecureURL(baseURL);
  try {
    const response = await axios.post<{ token?: string }>(`${baseURL.replace(/\/+$/, '')}/api/v1/auth/login`, { email, password }, { timeout: 30_000, maxRedirects: 0, ...(adapter ? { adapter } : {}) });
    if (!response.data?.token) throw new Error('Login returned no session token.');
    return response.data.token;
  } catch (error) {
    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
    throw new Error(status === 401 ? 'Login failed: email or password not accepted.' : status ? `Login failed: HTTP ${status}.` : 'Login failed: the server could not be reached.');
  }
}

function promptLine(question: string): Promise<string> {
  return new Promise(resolve => {
    process.stdout.write(question);
    process.stdin.resume(); process.stdin.setEncoding('utf8');
    process.stdin.once('data', data => { process.stdin.pause(); resolve(String(data).trim()); });
  });
}

/** Read a password without echoing it. Requires an interactive terminal. */
function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) return Promise.reject(new Error('Run this in an interactive terminal so the password can be typed at a hidden prompt.'));
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let value = '';
    const cleanup = () => { stdin.off('data', onData); stdin.setRawMode(false); stdin.pause(); process.stdout.write('\n'); };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') { cleanup(); resolve(value); return; }
        if (char === '\u0003') { cleanup(); reject(new Error('Cancelled.')); return; }
        value = char === '\u007f' || char === '\b' ? value.slice(0, -1) : value + char;
      }
    };
    process.stdout.write(question);
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8'); stdin.on('data', onData);
  });
}

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..');
/** Reports hold viewing history, so they must never land inside the repository. */
export function resolveOutputDir(requested: string | undefined, repositoryRoot = REPOSITORY_ROOT) {
  const dir = requested ? path.resolve(requested) : fs.mkdtempSync(path.join(os.tmpdir(), 'cinetra-tracking-audit-'));
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const relative = path.relative(real(repositoryRoot), real(path.dirname(dir)) + path.sep + path.basename(dir));
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) throw new Error('AUDIT_OUTPUT_DIR must be outside the repository; reports contain viewing history.');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Load only the TMDB variables from the given env file into this process, for the independent metadata check. */
function loadTMDBCredential(file: string) {
  for (const key of TMDB_KEYS) delete process.env[key];
  if (!fs.existsSync(file)) return false;
  const parsed = dotenv.parse(fs.readFileSync(file));
  let found = false;
  for (const key of TMDB_KEYS) if (parsed[key]) { process.env[key] = parsed[key]; found = true; }
  return found;
}

async function tmdbFacts(tmdb: TMDBApiService, tmdbId: number): Promise<{ facts: TMDBFacts | null; error: string | null }> {
  try {
    const details = await tmdb.getShow(tmdbId);
    const seasons = (details.seasons || []).filter(s => s.season_number > 0).map(s => ({ number: s.season_number, episodeCount: s.episode_count }));
    const pages = await Promise.all(seasons.map(s => tmdb.getSeason(tmdbId, s.number)));
    const episodes = pages.flatMap((page, i) => (page.episodes || []).filter(e => e.episode_number > 0).map(e => ({ season: seasons[i].number, number: e.episode_number, airDate: e.air_date || null })));
    const next = details.next_episode_to_air;
    return {
      facts: { seasons, episodes, status: details.status || null, inProduction: typeof details.in_production === 'boolean' ? details.in_production : null, nextEpisodeAnnounced: !!next, nextEpisode: next ? { season: next.season_number, number: next.episode_number, airDate: next.air_date || null } : null },
      error: null,
    };
  } catch (error) {
    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
    return { facts: null, error: status ? `TMDB HTTP ${status}` : 'TMDB request failed' };
  }
}

type Get = ReturnType<typeof readOnlyClient>;

async function guidesFor(get: Get, show: RawShow, preferredSeason: number | undefined) {
  const first = await get<GuidePage>(`/show/${show.id}/episodes?season=${preferredSeason || 1}`);
  if (!first.ok) return { guides: [] as GuidePage[], error: first.error };
  const guides = [first.data];
  for (const season of first.data.seasons.filter(s => s.number > 0 && s.number !== first.data.season)) {
    const page = await get<GuidePage>(`/show/${show.id}/episodes?season=${season.number}`);
    if (!page.ok) return { guides, error: `season ${season.number}: ${page.error}` };
    guides.push(page.data);
  }
  return { guides: guides.sort((a, b) => a.season - b.season), error: null };
}

export async function runAudit(options: { get: Get; tmdb: TMDBApiService | null; today?: string; concurrency?: number }) {
  const { get, tmdb } = options;
  const today = options.today || new Date().toISOString().slice(0, 10);
  const startedAt = new Date().toISOString();
  const showsResponse = await get<RawShow[]>('/show');
  if (!showsResponse.ok) throw new Error(`GET /show failed (${showsResponse.error}). Check CINETRA_API_URL and that your token is current.`);
  const shows = showsResponse.data;
  const summariesResponse = await get<Summary[]>('/show/tracking');
  const summaries = summariesResponse.ok ? summariesResponse.data : [];
  const upcomingResponse = await get<UpcomingResponse>('/show/upcoming');

  const perShow = await pool(shows, options.concurrency ?? 4, async show => {
    const oracle = tmdb && show.tmdbId ? await tmdbFacts(tmdb, show.tmdbId) : { facts: null, error: tmdb ? null : 'independent TMDB check disabled' };
    const detail = await get<Summary>(`/show/${show.id}/tracking`);
    const guide = show.tmdbId ? await guidesFor(get, show, oracle.facts?.seasons[0]?.number) : { guides: [] as GuidePage[], error: null };
    return { show, oracle, detail, guide };
  });

  const factsById = new Map(perShow.map(p => [p.show.id, p.oracle.facts]));
  const upcoming = upcomingResponse.ok ? auditUpcoming(shows, upcomingResponse.data, factsById, today) : null;
  const audits: ShowAudit[] = perShow.map(({ show, oracle, detail, guide }) => {
    const audit = auditShow({
      show, summary: summaries.find(s => s.showId === show.id) || null,
      detail: detail.ok ? detail.data : null, detailError: detail.ok ? null : detail.error,
      guides: guide.guides, guideError: guide.error, facts: oracle.facts, factsError: tmdb && show.tmdbId ? oracle.error : null,
      upcoming: upcomingResponse.ok ? upcomingResponse.data.releases.filter(r => r.showId === show.id) : [], today,
    });
    audit.issues.push(...(upcoming?.perShow[show.id] || []));
    return audit;
  });
  const library: Issue[] = [
    ...(summariesResponse.ok ? [] : [{ code: 'library_tracking_failed', severity: 'error' as const, detail: `GET /show/tracking failed: ${summariesResponse.error}` }]),
    ...(upcomingResponse.ok ? [] : [{ code: 'upcoming_failed', severity: 'error' as const, detail: `GET /show/upcoming failed: ${upcomingResponse.error}` }]),
    ...auditLibrarySurfaces(summaries, shows.length),
    ...(upcoming?.library || []),
  ];
  const preservation: PreservationRecord[] = perShow.map(({ show, detail, guide }) => preservationRecord(show, guide.guides.length ? guide.guides[0].watched : null, detail.ok ? detail.data.explicitWatchedCount ?? null : null));
  const issueCounts: Record<string, { category: string; severity: string; shows: number; causes?: Record<string, number> }> = {};
  for (const audit of audits) for (const code of new Set(audit.issues.map(i => i.code))) {
    const matching = audit.issues.filter(i => i.code === code);
    const entry = issueCounts[code] ||= { category: categoryOf(code), severity: matching[0].severity, shows: 0 };
    entry.shows++;
    for (const tag of new Set(matching.flatMap(i => i.tags || []))) (entry.causes ||= {})[tag] = (entry.causes[tag] || 0) + 1;
  }
  const showsByCategory = Object.fromEntries((['defect', 'insufficient_metadata', 'saved_data_conflict', 'informational'] as const).map(category => [category, audits.filter(a => a.issues.some(i => categoryOf(i.code) === category)).length]));
  return {
    startedAt, today, independentTMDBCheck: !!tmdb,
    totals: {
      shows: shows.length, withTmdbId: shows.filter(s => s.tmdbId).length,
      percentShown: audits.filter(a => a.percent.production !== null).length, percentComputable: audits.filter(a => a.percent.expectedExact !== null).length,
      showsWithDefects: showsByCategory.defect, showsWithInsufficientMetadata: showsByCategory.insufficient_metadata,
      showsWithSavedDataConflicts: showsByCategory.saved_data_conflict,
      showsFullyConsistent: audits.filter(a => !a.issues.some(i => categoryOf(i.code) !== 'informational')).length,
      showsWithoutGuide: audits.filter(a => a.checkmarksMatch === null).length,
      explicitRecords: preservation.reduce((n, r) => n + (r.explicitCount || 0), 0),
    },
    issueCounts, library: library.map(i => ({ ...i, category: categoryOf(i.code) })), upcoming: upcoming ? { coverage: upcoming.coverage, releases: upcoming.releases, returningWithoutDate: upcoming.returningWithoutDate, diagnostics: Object.fromEntries(Object.entries(upcomingResponse.ok ? upcomingResponse.data : {}).filter(([k]) => !['releases', 'returningTba'].includes(k))) } : null,
    shows: audits, preservation, preservationFingerprint: crypto.createHash('sha256').update(JSON.stringify(preservation)).digest('hex'),
  };
}
export type AuditReport = Awaited<ReturnType<typeof runAudit>>;

export const LIMITATIONS = [
  'Shows without a TMDB association have no episode list in production, so their checkmarks, released counts and percentages cannot be verified, and their individual watch records are compared by count only.',
  'Page states (Shows card, Continue watching, Home, Details) are derived from API responses using the same expressions as the frontend; the rendered UI itself is not inspected, so client-side rendering bugs, stale browser state and layout are out of scope.',
  'Expected values use the catalog production served (cached for up to 1 hour); the independent TMDB fetch is used for broadcast status and Upcoming. A TMDB update in between can cause a one-off difference.',
  'TVMaze is not queried by the audit. TVMaze entries are checked for how they are used (never replacing a TMDB date, never for unmatched shows), not for whether TVMaze identified the right show.',
  'Upcoming per-show diagnostics are not exposed by the API, so the reason a returning show has no schedule is inferred from TMDB, not read from production.',
  'Release cut-off is the UTC date at run time, matching production; an episode airing today counts as released.',
  'Classification needs TMDB facts; without the independent TMDB check every classification is reported as unverifiable rather than guessed.',
];

/** Aggregate-only view: counts, categories and causes. No show names, IDs, positions or watch history. */
export function shareableSummary(report: AuditReport, preservationChanges: string[] | null) {
  return {
    startedAt: report.startedAt, today: report.today, independentTMDBCheck: report.independentTMDBCheck, totals: report.totals,
    issueCounts: report.issueCounts, library: report.library.map(({ code, category, severity, detail }) => ({ code, category, severity, detail })),
    upcoming: report.upcoming, preservationFingerprint: report.preservationFingerprint,
    preservationChanges: preservationChanges === null ? 'no baseline given' : preservationChanges.length, limitations: LIMITATIONS,
  };
}

const cell = (value: unknown) => String(value ?? '—').replace(/\|/g, '\\|').replace(/\n/g, ' ');
export function renderMarkdown(report: AuditReport, preservationChanges: string[] | null) {
  const lines = [
    '# Cinetra tracking audit', '',
    `Run ${report.startedAt} (release cut-off ${report.today}, UTC). Independent TMDB check: ${report.independentTMDBCheck ? 'on' : 'off'}.`, '',
    '| Total | Value |', '|---|---|',
    ...Object.entries(report.totals).map(([k, v]) => `| ${k} | ${v} |`), '',
    '## Issues by type', '', '| Issue | Category | Severity | Shows | Causes |', '|---|---|---|---|---|',
    ...Object.entries(report.issueCounts).sort((a, b) => a[1].category.localeCompare(b[1].category) || b[1].shows - a[1].shows).map(([code, v]) => `| ${code} | ${v.category} | ${v.severity} | ${v.shows} | ${v.causes ? Object.entries(v.causes).map(([t, n]) => `${t} ${n}`).join(', ') : ''} |`), '',
    '## Library-wide', '', ...(report.library.length ? report.library.map(i => `- **${i.code}** (${i.severity}): ${i.detail}`) : ['- No library-wide issues.']), '',
  ];
  if (report.upcoming) lines.push('## Upcoming', '', `Coverage by show: ${Object.entries(report.upcoming.coverage).map(([k, v]) => `${k} ${v}`).join(' · ')}. Releases listed: ${report.upcoming.releases}; returning without date: ${report.upcoming.returningWithoutDate}.`, '', '```json', JSON.stringify(report.upcoming.diagnostics, null, 2), '```', '');
  if (preservationChanges) lines.push('## Preservation versus baseline', '', ...(preservationChanges.length ? preservationChanges.map(c => `- ${c}`) : ['- No changes to shows, saved positions, statuses, favorites, associations or individual watch records.']), '');
  lines.push('## Every show', '', '| Show | Saved position | Effective watched (prod / expected) | Released (prod / expected) | % (prod / exact) | Checkmarks | State (prod / expected) | Manual status | Shows card | Continue watching |', '|---|---|---|---|---|---|---|---|---|---|');
  for (const a of [...report.shows].sort((x, y) => x.name.localeCompare(y.name))) {
    lines.push(`| ${cell(a.name)} | ${cell(a.legacyPosition.saved)} | ${cell(a.effectiveWatched.production)} / ${cell(a.effectiveWatched.expected)} | ${cell(a.releasedRegular.production)} / ${cell(a.releasedRegular.expected)} | ${cell(a.percent.production)} / ${cell(a.percent.expectedExact)} | ${a.checkmarksMatch === null ? '—' : a.checkmarksMatch ? 'match' : 'MISMATCH'} | ${cell(a.classification.production)} / ${cell(a.classification.expected)} | ${cell(a.classification.manualStatus)} | ${cell(a.surfaces.showsCard)} | ${cell(a.surfaces.continueWatching)} |`);
  }
  lines.push('', '## Findings per show', '');
  for (const a of [...report.shows].sort((x, y) => x.name.localeCompare(y.name))) {
    const relevant = a.issues;
    if (!relevant.length) continue;
    lines.push(`### ${a.name}`, '', ...relevant.map(i => `- **${i.code}** (${categoryOf(i.code)}, ${i.severity}): ${i.detail}`), ...(a.percent.expectedExact === null ? [`- Percentage unavailable because: ${a.percent.unavailableBecause.join(' ') || 'unknown'}`] : []), '');
  }
  lines.push('## Limitations of this audit', '', ...LIMITATIONS.map(l => `- ${l}`), '');
  return lines.join('\n');
}

async function main() {
  const baseURL = process.env.CINETRA_API_URL;
  if (!baseURL) throw new Error('Set CINETRA_API_URL to your Cinetra address (see the header of this script).');
  assertSecureURL(baseURL);
  let token = process.env.CINETRA_TOKEN || '';
  if (!token && !process.stdin.isTTY) throw new Error('Run this in an interactive terminal so the password can be typed at a hidden prompt.');
  const outDir = resolveOutputDir(process.env.AUDIT_OUTPUT_DIR);
  if (token && process.argv.some(arg => arg.includes(token.replace(/^Bearer\s+/i, '')))) throw new Error('Do not pass the token as an argument; it would be stored in shell history.');
  if (!token) {
    const email = process.env.CINETRA_EMAIL || await promptLine('Cinetra email: ');
    const password = await promptHidden('Cinetra password (hidden): ');
    token = await login(baseURL, email, password);
  }
  const tmdbEnv = process.env.AUDIT_TMDB_ENV || path.join(REPOSITORY_ROOT, '.env');
  const tmdb = loadTMDBCredential(tmdbEnv) ? new TMDBApiService() : null;
  console.log(`Auditing read-only${tmdb ? ' with' : ' WITHOUT'} the independent TMDB check…`);
  const report = await runAudit({ get: readOnlyClient(baseURL, token), tmdb });
  token = '';
  const baselineFile = process.env.AUDIT_BASELINE;
  const changes = baselineFile ? comparePreservation((JSON.parse(fs.readFileSync(baselineFile, 'utf8')) as AuditReport).preservation, report.preservation) : null;
  const summary = shareableSummary(report, changes);
  const write = (name: string, content: string) => fs.writeFileSync(path.join(outDir, name), content, { mode: 0o600 });
  write('report.json', JSON.stringify({ ...report, preservationChanges: changes, limitations: LIMITATIONS }, null, 2));
  write('report.md', renderMarkdown(report, changes));
  write('summary.json', JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ output: outDir, shareable: path.join(outDir, 'summary.json'), private: [path.join(outDir, 'report.md'), path.join(outDir, 'report.json')], totals: report.totals, preservationChanges: summary.preservationChanges }, null, 2));
}

if (require.main === module) main().catch(error => { console.error(error instanceof Error ? error.message : 'Audit failed'); process.exitCode = 1; });
