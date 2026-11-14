/**
 * Web Push transport (VAPID + RFC 8291 aes128gcm payload encryption via the `web-push` library).
 *
 * The VAPID private key is read from the server environment only and is never returned, logged or sent to a client.
 * Senders are injectable so tests and the local manual trigger can use a mock instead of real push services.
 */
import crypto from 'crypto';
import type { Agent } from 'https';
import webpush from 'web-push';
import type { PushPayload } from './episode-alerts.model';

export type PushTarget = { endpoint: string; p256dh: string; auth: string };
export type SendOptions = { ttlSeconds: number; topic?: string; urgency?: 'very-low' | 'low' | 'normal' | 'high' };
/** What the push service said. `statusCode` is null when no answer arrived (timeout, connection reset). */
export type SendResult = { statusCode: number | null; error?: string };
export interface PushSender { send(target: PushTarget, payload: PushPayload, options: SendOptions): Promise<SendResult> }

/**
 * How a send ended, for the delivery state machine:
 * - delivered: accepted by the push service (2xx).
 * - gone: 404/410, the subscription expired or was revoked; the subscription is removed.
 * - retry: 429 or 503, an explicit "not accepted, try later"; nothing was delivered.
 * - failed: any other 4xx (bad request, VAPID mismatch, payload too large): retrying would not help.
 * - uncertain: no answer, or another 5xx; the push service may have accepted it, so it is never re-sent.
 */
export type SendOutcome = 'delivered' | 'gone' | 'retry' | 'failed' | 'uncertain';
export function classifySend(result: SendResult): SendOutcome {
  const status = result.statusCode;
  if (status === null) return 'uncertain';
  if (status >= 200 && status < 300) return 'delivered';
  if (status === 404 || status === 410) return 'gone';
  if (status === 429 || status === 503) return 'retry';
  if (status >= 400 && status < 500) return 'failed';
  return 'uncertain';
}

export type VapidConfig = { publicKey: string; privateKey: string; subject: string };
const B64URL = /^[A-Za-z0-9_-]+$/;
const decode = (value: string) => Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** VAPID keys from the environment, or null when push is not configured. Throws on a malformed configuration. */
export function vapidConfig(env: NodeJS.ProcessEnv = process.env): VapidConfig | null {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  const subject = env.VAPID_SUBJECT?.trim();
  if (!publicKey && !privateKey) return null;
  if (!publicKey || !privateKey || !subject) throw new Error('Push notifications need VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT together');
  if (!B64URL.test(publicKey) || decode(publicKey).length !== 65 || !B64URL.test(privateKey) || decode(privateKey).length !== 32) throw new Error('VAPID keys must be URL-safe base64 P-256 keys');
  if (!/^(mailto:\S+@\S+|https:\/\/\S+)$/.test(subject)) throw new Error('VAPID_SUBJECT must be a mailto: address or an https: URL');
  return { publicKey, privateKey, subject };
}

/** Public key for browsers, or null. Never throws (a broken configuration just reads as "not configured"). */
export function publicVapidKey(): string | null {
  try { return vapidConfig()?.publicKey ?? null; } catch { return null; }
}

let transportAgent: Agent | undefined;
/** Tests only: route pushes through an HTTPS agent that trusts a local fake push service's self-signed certificate. */
export function useTransportAgent(agent: Agent | undefined) { transportAgent = agent; }

/** Real sender. Timeouts and network failures come back as `statusCode: null` (uncertain), never thrown. */
export function webPushSender(config: VapidConfig, timeoutMs = 15_000, agent: Agent | undefined = transportAgent): PushSender {
  return {
    async send(target, payload, options) {
      try {
        const response = await webpush.sendNotification(
          { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
          JSON.stringify(payload),
          { vapidDetails: config, TTL: options.ttlSeconds, urgency: options.urgency ?? 'normal', topic: options.topic, timeout: timeoutMs, contentEncoding: 'aes128gcm', ...(agent ? { agent } : {}) },
        );
        return { statusCode: response.statusCode };
      } catch (error) {
        const statusCode = (error as { statusCode?: unknown })?.statusCode;
        // Never include the endpoint or the raw response body (it can echo identifiers). The push service's short
        // `reason` code (e.g. Apple's "BadUrgency") is extracted alone: it names the cause without carrying data.
        const reason = pushRejectionReason((error as { body?: unknown })?.body);
        return typeof statusCode === 'number'
          ? { statusCode, error: `HTTP ${statusCode}${reason ? ` ${reason}` : ''}` }
          : { statusCode: null, error: 'No response from push service' };
      }
    },
  };
}

/** The service's machine-readable rejection code from an error body, e.g. {"reason":"BadUrgency"}. Nothing else. */
export function pushRejectionReason(body: unknown): string | null {
  if (typeof body !== 'string' || body.length > 2048) return null;
  const match = /"reason"\s*:\s*"([A-Za-z0-9_-]{1,40})"/.exec(body);
  return match ? match[1] : null;
}

/** The configured sender, or null when VAPID keys are not set. */
export function defaultSender(): PushSender | null {
  const config = vapidConfig();
  return config ? webPushSender(config) : null;
}

// Push services browsers hand out today: Apple (Safari / iOS Home Screen apps), Google FCM (Chrome, Edge on Android),
// Mozilla autopush (Firefox) and Windows WNS. Restricting hosts keeps the server from POSTing to arbitrary URLs (SSRF).
const PUSH_HOSTS = [/^web\.push\.apple\.com$/, /^[a-z0-9-]+\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^[a-z0-9-]+\.notify\.windows\.com$/];

export type SubscriptionInput = { endpoint: string; p256dh: string; auth: string };
/**
 * Validate a browser PushSubscription JSON ({ endpoint, keys: { p256dh, auth } }). Returns null when invalid.
 * Non-production only: `PUSH_ALLOW_LOCAL_ENDPOINTS=true` also accepts https://127.0.0.1:<port> endpoints for local tests.
 */
export function parseSubscription(body: unknown, env: NodeJS.ProcessEnv = process.env): SubscriptionInput | null {
  if (!body || typeof body !== 'object') return null;
  const { endpoint, keys } = body as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } | null };
  if (typeof endpoint !== 'string' || endpoint.length > 2048 || !keys || typeof keys !== 'object') return null;
  const { p256dh, auth } = keys;
  if (typeof p256dh !== 'string' || typeof auth !== 'string' || p256dh.length > 200 || auth.length > 100) return null;
  const p = p256dh.replace(/=+$/, ''); const a = auth.replace(/=+$/, '');
  if (!B64URL.test(p) || !B64URL.test(a)) return null;
  const key = decode(p);
  if (key.length !== 65 || key[0] !== 0x04 || decode(a).length !== 16) return null;
  let url: URL;
  try { url = new URL(endpoint); } catch { return null; }
  if (url.username || url.password) return null;
  const local = env.NODE_ENV !== 'production' && env.PUSH_ALLOW_LOCAL_ENDPOINTS === 'true' && url.protocol === 'https:' && url.hostname === '127.0.0.1';
  if (!local && (url.protocol !== 'https:' || url.port || !PUSH_HOSTS.some(host => host.test(url.hostname)))) return null;
  return { endpoint, p256dh: p, auth: a };
}

/** Lookup key for an endpoint, so the raw capability URL never appears in a WHERE clause or a log line. */
export const endpointHash = (endpoint: string) => crypto.createHash('sha256').update(endpoint).digest('hex');
