/**
 * Loads the version-controlled manual premiere-time overrides (backend/config/release-overrides.json) once per
 * process. Read-only: overrides change only through a reviewed commit and a deploy. A missing, unreadable or invalid
 * file never stops the server; it simply yields no overrides (and is reported by the health check).
 */
import fs from 'fs';
import path from 'path';
import { parseOverrideConfig, type RejectedOverride, type ReleaseOverride } from './release-override.model';

export const RELEASE_OVERRIDES_FILE = 'release-overrides.json';
type Loaded = { file: string | null; overrides: ReleaseOverride[]; rejected: RejectedOverride[]; error: string | null; loadedAt: string };
let loaded: Loaded | null = null;

function locate(): string | null {
  // Production runs from /backend (dist/src/services/...); tests and ts-node run from backend/ (src/services/...).
  const candidates = [path.join(process.cwd(), 'config', RELEASE_OVERRIDES_FILE), path.resolve(__dirname, '../../config', RELEASE_OVERRIDES_FILE), path.resolve(__dirname, '../../../config', RELEASE_OVERRIDES_FILE)];
  return candidates.find(file => fs.existsSync(file)) ?? null;
}

export function loadReleaseOverrides(): Loaded {
  if (loaded) return loaded;
  const file = locate();
  const today = new Date().toISOString().slice(0, 10);
  if (!file) loaded = { file: null, overrides: [], rejected: [], error: 'No release-overrides.json found; no manual release times apply', loadedAt: new Date().toISOString() };
  else {
    try {
      const parsed = parseOverrideConfig(JSON.parse(fs.readFileSync(file, 'utf8')), today);
      loaded = { file, ...parsed, loadedAt: new Date().toISOString() };
    } catch (error) {
      loaded = { file, overrides: [], rejected: [], error: `Could not read ${RELEASE_OVERRIDES_FILE}: ${error instanceof Error ? error.message : 'unknown error'}`, loadedAt: new Date().toISOString() };
    }
  }
  if (loaded.error || loaded.rejected.length) console.warn(`Release overrides: ${loaded.overrides.length} valid, ${loaded.rejected.length} rejected${loaded.error ? ` (${loaded.error})` : ''}`);
  return loaded;
}

/** The valid entries for one TMDB series. */
export const releaseOverridesFor = (tmdbId: number) => loadReleaseOverrides().overrides.filter(o => o.tmdbId === tmdbId);

/** Tests only: use this configuration instead of the file. */
export function setReleaseOverridesForTests(raw: unknown, today = new Date().toISOString().slice(0, 10)) {
  loaded = { file: '(test)', ...parseOverrideConfig(raw, today), loadedAt: new Date().toISOString() };
  return loaded;
}
