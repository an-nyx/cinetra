import axios, { AxiosError, type AxiosResponse } from 'axios';
import type { TMDBRequestAuth } from './tmdb-auth';

const REDACTED = '[REDACTED]';

/** The raw credential values in use, so they can be scrubbed from any text that might echo them. */
export function tmdbSecrets(auth: TMDBRequestAuth | null): string[] {
  const bearer = auth?.headers?.Authorization.replace(/^Bearer\s+/i, '');
  return [bearer, auth?.params?.api_key].filter((value): value is string => !!value);
}

/** Remove the configured secrets plus anything credential-shaped (Bearer values, api_key query values). */
export function redactTMDBText(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) result = result.split(secret).join(REDACTED);
  return result
    .replace(/(Bearer\s+)[^\s"',;]+/gi, `$1${REDACTED}`)
    .replace(/(api_key=)[^&\s"',;]+/gi, `$1${REDACTED}`);
}

/**
 * Rebuild a TMDB failure as a fresh error carrying only a redacted message, the error code and the HTTP status.
 * The original request config (headers, params, URL), request object, response headers and cause are dropped,
 * so logging or serializing the error (console.error, util.inspect, JSON.stringify, toJSON) cannot reveal a
 * credential. Axios errors stay Axios errors, so `axios.isAxiosError(e)` and `e.response?.status` still work.
 */
export function sanitizeTMDBError(error: unknown, secrets: readonly string[]): Error {
  const message = redactTMDBText(error instanceof Error && error.message ? error.message : 'TMDB request failed', secrets);
  if (!axios.isAxiosError(error)) return new Error(message);

  const status = error.response?.status;
  const body = error.response?.data as { status_code?: unknown; status_message?: unknown } | undefined;
  // Keep TMDB's documented error fields only; nothing else from the response survives.
  const data = body && typeof body === 'object' ? {
    ...(typeof body.status_code === 'number' ? { status_code: body.status_code } : {}),
    ...(typeof body.status_message === 'string' ? { status_message: redactTMDBText(body.status_message, secrets) } : {}),
  } : undefined;
  const response = typeof status === 'number'
    ? { status, statusText: redactTMDBText(error.response?.statusText || '', secrets), headers: {}, data } as unknown as AxiosResponse
    : undefined;
  return new AxiosError(message, error.code, undefined, undefined, response);
}
