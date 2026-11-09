import assert from 'node:assert/strict';
import util from 'node:util';
import axios, { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';
import { TMDBApiService } from '../src/services/tmdb/tmdb-api.service';

// Obviously fake credentials; no real TMDB value is used or needed.
const FAKE_V4 = 'eyJmYWtlLXRlc3Qtb25seQ.eyJub3QtYS1yZWFsLXRva2Vu.ZmFrZS1zaWduYXR1cmU';
const FAKE_V3 = 'feedfacefeedfacefeedfacefeedface';
const TMDB_ENV = ['TMDB_READ_ACCESS_TOKEN', 'TMDB_API_KEY', 'API_AUTHORIZATION'] as const;

/** Build the service with only the given credential variable set, and route requests to a fake adapter. */
function serviceWith(env: Partial<Record<typeof TMDB_ENV[number], string>>, adapter: AxiosAdapter) {
  const saved = Object.fromEntries(TMDB_ENV.map(key => [key, process.env[key]]));
  for (const key of TMDB_ENV) delete process.env[key];
  Object.assign(process.env, env);
  try {
    const service = new TMDBApiService();
    (service as unknown as { fetcher: { defaults: { adapter: AxiosAdapter } } }).fetcher.defaults.adapter = adapter;
    return service;
  } finally {
    for (const key of TMDB_ENV) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  }
}

/** Every way the error could be logged or serialized must be free of the secret. */
function assertNoSecret(error: unknown, secret: string) {
  const err = error as Error & { toJSON?: () => unknown };
  const renderings = [
    util.inspect(error, { depth: Infinity, showHidden: true }),
    util.format('%o', error),
    JSON.stringify(error),
    JSON.stringify(err.toJSON?.()),
    String(error),
    err.stack || '',
    err.message,
  ];
  for (const text of renderings) assert.ok(!text.includes(secret), 'credential leaked through error output');
  assert.equal('config' in err && (err as { config?: unknown }).config !== undefined, false);
  assert.equal('request' in err && (err as { request?: unknown }).request !== undefined, false);
  assert.equal((err as { cause?: unknown }).cause, undefined);
}

async function rejection(promise: Promise<unknown>) {
  try { await promise; } catch (error) { return error; }
  assert.fail('expected the TMDB request to fail');
}

async function main() {
  // v4 token: an HTTP 401 whose original error carries the Bearer header, request, response headers and a secret-echoing message.
  {
    let seen: InternalAxiosRequestConfig | undefined;
    const service = serviceWith({ TMDB_READ_ACCESS_TOKEN: FAKE_V4 }, async config => {
      seen = config;
      const response = { status: 401, statusText: 'Unauthorized', headers: { 'www-authenticate': `Bearer ${FAKE_V4}` }, config, request: { headers: config.headers }, data: { status_code: 7, status_message: 'Invalid API key: You must be granted a valid key.', echoed: FAKE_V4 } };
      throw new AxiosError(`Request failed with status code 401 (Authorization: Bearer ${FAKE_V4})`, 'ERR_BAD_REQUEST', config, response.request, response);
    });
    const error = await rejection(service.getShow(52814));
    assert.equal(seen?.headers.Authorization, `Bearer ${FAKE_V4}`); // authentication itself is unchanged
    assert.ok(axios.isAxiosError(error));
    assert.equal(error.response?.status, 401); // episode-guide and scripts classify on this
    assert.equal(error.code, 'ERR_BAD_REQUEST');
    assert.deepEqual(error.response?.data, { status_code: 7, status_message: 'Invalid API key: You must be granted a valid key.' });
    assertNoSecret(error, FAKE_V4);
  }

  // v3 key: a network failure (no response) whose message and cause embed the full URL with ?api_key=.
  {
    let seen: InternalAxiosRequestConfig | undefined;
    const service = serviceWith({ TMDB_API_KEY: FAKE_V3 }, async config => {
      seen = config;
      const error = new AxiosError(`connect ECONNREFUSED https://api.themoviedb.org/3/tv/52814/season/1?api_key=${FAKE_V3}`, 'ECONNREFUSED', config, { path: `/3/tv/52814/season/1?api_key=${FAKE_V3}` });
      error.cause = new Error(`socket for api_key=${FAKE_V3}`);
      throw error;
    });
    const error = await rejection(service.getSeason(52814, 1));
    assert.equal(seen?.params.api_key, FAKE_V3); // authentication itself is unchanged
    assert.ok(axios.isAxiosError(error));
    assert.equal(error.response, undefined); // still classified as network_or_timeout
    assert.equal(error.code, 'ECONNREFUSED');
    assertNoSecret(error, FAKE_V3);
  }

  // Credential-shaped text is scrubbed even if it does not match the configured value exactly.
  {
    const service = serviceWith({ API_AUTHORIZATION: `Bearer ${FAKE_V4}` }, async config => {
      throw new AxiosError('failed with Authorization: Bearer some-other-token and ?api_key=another-key&page=1', 'ERR_BAD_RESPONSE', config);
    });
    const error = await rejection(service.getShow(1)) as Error;
    assert.equal(error.message, 'failed with Authorization: Bearer [REDACTED] and ?api_key=[REDACTED]&page=1');
  }

  // The search path logs on failure; that log line must not contain the credential either.
  {
    const service = serviceWith({ TMDB_READ_ACCESS_TOKEN: FAKE_V4 }, async config => {
      throw new AxiosError('Request failed with status code 401', 'ERR_BAD_REQUEST', config, {}, { status: 401, statusText: 'Unauthorized', headers: {}, config, data: {} });
    });
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { logged.push(util.format(...args)); };
    try { await rejection(service.searchShows('halo')); } finally { console.error = original; }
    assert.deepEqual(logged, ['TMDB API Error: HTTP 401']);
  }

  // Successful responses are returned untouched.
  {
    const service = serviceWith({ TMDB_READ_ACCESS_TOKEN: FAKE_V4 }, async config => ({ status: 200, statusText: 'OK', headers: {}, config, data: { name: 'Halo', seasons: [] } }));
    assert.deepEqual(await service.getShow(52814), { name: 'Halo', seasons: [] });
  }

  console.log('TMDB error sanitization tests passed');
}

main().catch(error => {
  // Report only the assertion message; never dump the raw error object from a TMDB test.
  console.error(error instanceof Error ? error.message : 'TMDB error sanitization tests failed');
  process.exitCode = 1;
});
