export type TMDBEnvironment = {
  TMDB_READ_ACCESS_TOKEN?: string;
  TMDB_API_KEY?: string;
  API_AUTHORIZATION?: string;
  [key: string]: string | undefined;
};

export type TMDBRequestAuth = { headers?: { Authorization: string }; params?: { api_key: string } };

const clean = (value?: string) => value?.trim() || '';
const bearer = (value: string) => /^Bearer\s/i.test(value) ? value : `Bearer ${value}`;

/** Resolve only server-side TMDB credentials; never pass these values to the frontend. */
export function resolveTMDBRequestAuth(environment: TMDBEnvironment): TMDBRequestAuth | null {
  const readAccessToken = clean(environment.TMDB_READ_ACCESS_TOKEN);
  if (readAccessToken) return { headers: { Authorization: bearer(readAccessToken) } };

  const apiKey = clean(environment.TMDB_API_KEY);
  if (apiKey) return { params: { api_key: apiKey } };

  const legacyAuthorization = clean(environment.API_AUTHORIZATION);
  if (legacyAuthorization) return { headers: { Authorization: bearer(legacyAuthorization) } };
  return null;
}

export const TMDB_AUTH_CONFIGURATION_ERROR = 'TMDB authentication is not configured. Set TMDB_READ_ACCESS_TOKEN or TMDB_API_KEY in the backend environment.';
