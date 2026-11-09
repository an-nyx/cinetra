export type TMDBEnvironment = {
  TMDB_READ_ACCESS_TOKEN?: string;
  TMDB_API_KEY?: string;
  API_AUTHORIZATION?: string;
  [key: string]: string | undefined;
};

export type TMDBRequestAuth = { headers?: { Authorization: string }; params?: { api_key: string } };

/** Trim whitespace and one pair of surrounding quotes, which literal env vars (e.g. Coolify) keep verbatim. */
const clean = (value?: string) => (value?.trim() || '').replace(/^(["'])([\s\S]*)\1$/, '$2').trim();
const stripBearer = (value: string) => value.replace(/^Bearer\s+/i, '').trim();
// v3 API keys are 32 hex chars and must go in ?api_key=; v4 read access tokens are JWTs sent as Bearer.
const isV3ApiKey = (value: string) => /^[a-f0-9]{32}$/i.test(value);
const isV4Token = (value: string) => /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(value);

function authFor(credential: string, preferApiKey: boolean): TMDBRequestAuth {
  const core = stripBearer(credential);
  const useApiKey = isV3ApiKey(core) || (preferApiKey && !isV4Token(core));
  return useApiKey ? { params: { api_key: core } } : { headers: { Authorization: `Bearer ${core}` } };
}

/** Resolve only server-side TMDB credentials; never pass these values to the frontend. */
export function resolveTMDBRequestAuth(environment: TMDBEnvironment): TMDBRequestAuth | null {
  const readAccessToken = clean(environment.TMDB_READ_ACCESS_TOKEN);
  if (readAccessToken) return authFor(readAccessToken, false);

  const apiKey = clean(environment.TMDB_API_KEY);
  if (apiKey) return authFor(apiKey, true);

  const legacyAuthorization = clean(environment.API_AUTHORIZATION);
  if (legacyAuthorization) return authFor(legacyAuthorization, false);
  return null;
}

export const TMDB_AUTH_CONFIGURATION_ERROR = 'TMDB authentication is not configured. Set TMDB_READ_ACCESS_TOKEN or TMDB_API_KEY in the backend environment.';
