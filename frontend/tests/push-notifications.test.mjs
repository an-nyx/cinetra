import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { applicationServerKey, detectEnvironment, explain, pushSupport, sameKey } from '../src/lib/push-support.ts';
import { navigationTarget } from '../src/lib/service-worker.ts';

const UA = {
  iphone17: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  iphone163: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.3 Mobile/15E148 Safari/604.1',
  iphone164: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Mobile/15E148 Safari/604.1',
  ipadDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
};
const env = ({ ua, standalone = false, push = true, permission = 'default', secure = true, touch = 0, notifications = true }) => detectEnvironment(
  { isSecureContext: secure, PushManager: push ? function PushManager() {} : undefined, Notification: notifications ? { permission } : undefined, matchMedia: () => ({ matches: standalone }) },
  { userAgent: ua, maxTouchPoints: touch, serviceWorker: {} },
);

test('iPhone in a regular Safari tab is told to add Cinetra to the Home Screen', () => {
  // Safari tabs on iOS do not expose PushManager at all.
  const e = env({ ua: UA.iphone17, push: false });
  assert.equal(e.ios, true); assert.deepEqual(e.iosVersion, [17, 4]);
  assert.equal(pushSupport(e), 'ios_install_required');
  const text = explain({ support: 'ios_install_required', permission: e.permission, device: 'inactive', serverConfigured: true });
  assert.equal(text.title, 'Add Cinetra to your Home Screen');
  assert.match(text.detail, /Share.*Add to Home Screen.*open Cinetra from your Home Screen/);
});

test('iPhone Home Screen app on iOS 16.4+ supports push; older iOS needs an update', () => {
  assert.equal(pushSupport(env({ ua: UA.iphone17, standalone: true })), 'supported');
  assert.equal(pushSupport(env({ ua: UA.iphone164, standalone: true })), 'supported', '16.4 exactly');
  assert.equal(pushSupport(env({ ua: UA.iphone163, standalone: true, push: false })), 'ios_update_required');
  assert.equal(pushSupport(env({ ua: UA.iphone163 })), 'ios_update_required');
  // navigator.standalone (Safari) also marks a Home Screen app.
  const legacy = detectEnvironment({ PushManager: function () {}, Notification: { permission: 'default' }, matchMedia: () => ({ matches: false }) }, { userAgent: UA.iphone17, standalone: true, serviceWorker: {} });
  assert.equal(pushSupport(legacy), 'supported');
});

test('iPadOS desktop-mode user agent is recognised by touch, with the Safari version', () => {
  const e = env({ ua: UA.ipadDesktop, touch: 5, push: false });
  assert.equal(e.ios, true); assert.deepEqual(e.iosVersion, [17, 4]);
  assert.equal(pushSupport(e), 'ios_install_required');
  assert.equal(env({ ua: UA.mac, touch: 0 }).ios, false, 'a real Mac is not iOS');
  assert.equal(pushSupport(env({ ua: UA.mac })), 'supported', 'Safari on macOS supports push in a tab');
});

test('desktop, unsupported and insecure browsers', () => {
  assert.equal(pushSupport(env({ ua: UA.chrome })), 'supported');
  assert.equal(pushSupport(env({ ua: UA.chrome, push: false })), 'unsupported');
  assert.equal(pushSupport(env({ ua: UA.chrome, notifications: false })), 'unsupported');
  assert.equal(env({ ua: UA.chrome, notifications: false }).permission, 'unsupported');
  assert.equal(pushSupport(env({ ua: UA.chrome, secure: false })), 'insecure');
  assert.match(explain({ support: 'unsupported', permission: 'unsupported', device: 'inactive', serverConfigured: true }).title, /can’t receive notifications/);
  assert.match(explain({ support: 'insecure', permission: 'default', device: 'inactive', serverConfigured: true }).detail, /HTTPS/);
});

test('permission and subscription states each get a clear explanation', () => {
  const s = (permission, device, extra = {}) => explain({ support: 'supported', permission, device, serverConfigured: true, ...extra });
  assert.equal(env({ ua: UA.chrome }).permission, 'default');
  assert.deepEqual([s('default', 'inactive').title, s('default', 'inactive').tone], ['Notifications are off', 'info']);
  assert.match(s('default', 'inactive').detail, /nothing is requested before you tap/, 'permission is only requested after the tap');
  assert.deepEqual([s('granted', 'active').title, s('granted', 'active').tone], ['Notifications are on for this device', 'ok']);
  assert.match(s('granted', 'active').detail, /even when Cinetra is closed/);
  assert.equal(s('granted', 'inactive').title, 'Allowed, but this device isn’t subscribed');
  assert.deepEqual([s('denied', 'inactive').title, s('denied', 'inactive').tone], ['Notifications are blocked', 'error']);
  assert.match(s('denied', 'inactive').detail, /Settings › Notifications/);
  assert.equal(s('denied', 'active').title, 'Notifications are blocked', 'a revoked permission wins over a stale subscription');
  assert.equal(s('granted', 'failed', { error: 'Invalid push subscription.' }).detail, 'Invalid push subscription.');
  assert.equal(s('granted', 'failed').title, 'Couldn’t turn on notifications');
  assert.equal(s('default', 'inactive', { serverConfigured: false }).title, 'Notifications aren’t set up on the server');
});

test('VAPID key conversion and key-rotation check', () => {
  const key = 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM';
  const bytes = applicationServerKey(key);
  assert.equal(bytes.length, 65); assert.equal(bytes[0], 4);
  assert.equal(Buffer.from(bytes).toString('base64url'), key);
  assert.equal(sameKey(bytes.buffer, bytes), true);
  assert.equal(sameKey(new Uint8Array(65).buffer, bytes), false);
  assert.equal(sameKey(null, bytes), false);
});

test('in-app navigation messages accept same-origin paths only', () => {
  assert.equal(navigationTarget({ type: 'cinetra:navigate', url: '/shows?show=abc' }), '/shows?show=abc');
  assert.equal(navigationTarget({ type: 'cinetra:navigate', url: 'https://evil.example/' }), null);
  assert.equal(navigationTarget({ type: 'cinetra:navigate', url: '//evil.example/' }), null);
  assert.equal(navigationTarget({ type: 'other', url: '/' }), null);
  assert.equal(navigationTarget(null), null);
});

// --- Service worker (public/sw.js) in a sandbox ---------------------------------------------------------------------
function loadWorker({ windows = [], focusFails = false } = {}) {
  const handlers = {}; const shown = []; const opened = []; const messages = [];
  const clients = windows.map(w => ({ ...w, focus: async function () { if (focusFails) throw new Error('not allowed'); this.focusedNow = true; return this; }, postMessage(m) { messages.push({ url: this.url, m }); } }));
  const self = {
    location: { origin: 'https://cinetra.aniskh.com' },
    addEventListener: (type, fn) => { handlers[type] = fn; },
    skipWaiting() {},
    registration: { showNotification: async (title, options) => { shown.push({ title, options }); } },
    clients: { matchAll: async () => clients, openWindow: async url => { opened.push(url); }, claim: async () => {} },
  };
  vm.runInNewContext(fs.readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), { self, URL });
  const dispatch = async (type, event) => { let wait; handlers[type]({ ...event, waitUntil: p => { wait = p; } }); await wait; };
  return { handlers, shown, opened, messages, clients, dispatch };
}
const pushEvent = payload => ({ data: { json: () => (typeof payload === 'string' ? JSON.parse(payload) : payload) } });
const click = url => { let closed = false; return { notification: { data: { url }, close: () => { closed = true; } }, closed: () => closed }; };

test('push shows the episode notification with its icon, tag and link', async () => {
  const w = loadWorker();
  await w.dispatch('push', pushEvent({ title: 'New episode of Silo', body: 'Season 3, Episode 2 has premiered.', url: '/shows?show=s1', tag: 'episode-44778-3001', icon: '/icon-192.png?v=2', badge: '/icon-192.png?v=2' }));
  assert.equal(w.shown.length, 1);
  assert.equal(w.shown[0].title, 'New episode of Silo');
  assert.deepEqual(JSON.parse(JSON.stringify(w.shown[0].options)), { body: 'Season 3, Episode 2 has premiered.', icon: '/icon-192.png?v=2', badge: '/icon-192.png?v=2', data: { url: '/shows?show=s1' }, tag: 'episode-44778-3001' });
});

test('cinematic alert carries the show poster as the large image; the Cinetra icon and click link are unchanged', async () => {
  const w = loadWorker();
  await w.dispatch('push', pushEvent({ title: 'A new chapter of MobLand.', body: 'S02E09 just premiered. Your next episode awaits.', url: '/shows?show=s1', tag: 'episode-75026-1', icon: '/icon-192.png?v=2', badge: '/icon-192.png?v=2', image: 'https://image.tmdb.org/t/p/w780/mob.jpg' }));
  assert.deepEqual(JSON.parse(JSON.stringify(w.shown[0].options)), { body: 'S02E09 just premiered. Your next episode awaits.', icon: '/icon-192.png?v=2', badge: '/icon-192.png?v=2', data: { url: '/shows?show=s1' }, image: 'https://image.tmdb.org/t/p/w780/mob.jpg', tag: 'episode-75026-1' });
  await w.dispatch('push', pushEvent({ title: 't', image: 'https://static.tvmaze.com/uploads/images/medium_portrait/590/1475000.jpg' }));
  assert.equal(w.shown[1].options.image, 'https://static.tvmaze.com/uploads/images/medium_portrait/590/1475000.jpg');
});

test('missing or unsafe artwork is dropped: text-only notification, never an unrelated image', async () => {
  const w = loadWorker();
  const bad = [undefined, '', 'http://image.tmdb.org/t/p/w780/a.jpg', 'https://evil.example/a.jpg', 'https://image.tmdb.org.evil.example/a.jpg', 'https://image.tmdb.org/t/p/w780/a.jpg?token=x',
    'https://u:p@image.tmdb.org/a.jpg', 'https://image.tmdb.org:444/a.jpg', 'javascript:alert(1)', 'data:image/png;base64,AAAA', 42, 'https://image.tmdb.org/' + 'a'.repeat(600)];
  for (const image of bad) await w.dispatch('push', pushEvent({ title: 'x', image }));
  assert.equal(w.shown.length, bad.length, 'still shown (iOS requires a visible notification)');
  assert.ok(w.shown.every(n => !('image' in n.options)), 'no image option at all');
  assert.ok(w.shown.every(n => n.options.icon === '/icon-192.png?v=2'));
});

test('push is always shown, and unsafe links fall back to the home page', async () => {
  const w = loadWorker();
  await w.dispatch('push', pushEvent('"not an object"'));
  await w.dispatch('push', { data: { json: () => { throw new Error('bad json'); } } });
  await w.dispatch('push', pushEvent({ title: 'x', url: 'https://evil.example/phish', icon: 'javascript:alert(1)' }));
  await w.dispatch('push', pushEvent({ title: 'x', url: '//evil.example' }));
  assert.equal(w.shown.length, 4, 'iOS requires a visible notification for every push');
  assert.equal(w.shown[0].title, 'Cinetra'); assert.equal(w.shown[1].title, 'Cinetra');
  assert.equal(w.shown[2].options.data.url, '/'); assert.equal(w.shown[2].options.icon, '/icon-192.png?v=2');
  assert.equal(w.shown[3].options.data.url, '/');
});

test('click focuses the open Cinetra window and routes it, without opening a new tab', async () => {
  const w = loadWorker({ windows: [{ url: 'https://other.example/', focused: true, visibilityState: 'visible' }, { url: 'https://cinetra.aniskh.com/upcoming', focused: false, visibilityState: 'hidden' }, { url: 'https://cinetra.aniskh.com/movies', focused: false, visibilityState: 'visible' }] });
  const event = click('/shows?show=s1');
  await w.dispatch('notificationclick', event);
  assert.equal(event.closed(), true);
  assert.deepEqual(w.opened, [], 'no duplicate tab');
  assert.deepEqual(JSON.parse(JSON.stringify(w.messages)), [{ url: 'https://cinetra.aniskh.com/movies', m: { type: 'cinetra:navigate', url: '/shows?show=s1' } }], 'the visible Cinetra window, never another site');
  assert.equal(w.clients[2].focusedNow, true);
});

test('click opens Cinetra when no window is open, or when focusing is refused', async () => {
  const closed = loadWorker();
  await closed.dispatch('notificationclick', click('/shows?show=s1'));
  assert.deepEqual(closed.opened, ['/shows?show=s1']);
  const refused = loadWorker({ windows: [{ url: 'https://cinetra.aniskh.com/', focused: false, visibilityState: 'hidden' }], focusFails: true });
  await refused.dispatch('notificationclick', click('/shows?show=s2'));
  assert.deepEqual(refused.opened, ['/shows?show=s2']);
  const hostile = loadWorker();
  await hostile.dispatch('notificationclick', click('https://evil.example/'));
  assert.deepEqual(hostile.opened, ['/']);
});

test('the worker never intercepts page loads or API calls', () => {
  const w = loadWorker();
  assert.equal(w.handlers.fetch, undefined);
  assert.ok(w.handlers.pushsubscriptionchange);
});
