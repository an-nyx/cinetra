"""Approved six-show rollout: prepare the atomic batch, then separately enable its prospective scope."""
import hashlib
import json
import os
import time
import urllib.error
import urllib.request

base = os.environ['COOLIFY_URL'].rstrip('/') + '/api/v1'
app_id = os.environ['COOLIFY_APP_UUID']
url = os.environ['CINETRA_URL'].rstrip('/')
mode = os.environ.get('TV_STATUS_DEPLOY_MODE', 'preserve')
requested_mode = mode
if mode not in ('prepare', 'active', 'preserve'):
    raise RuntimeError('Unknown deployment mode')
scope = json.loads(os.environ['TV_STATUS_APPROVED_SCOPE'])
if len(scope['targets']) != 6 or len(scope['excludedShowIds']) != 28 or set(t['tmdbId'] for t in scope['targets']) != {84958, 97951, 247718, 108978, 84773, 153312}:
    raise RuntimeError('Deployment scope differs from the approved six-show plan')
if len(set(t['showId'] for t in scope['targets'])) != 6 or set(t['showId'] for t in scope['targets']) & set(scope['excludedShowIds']):
    raise RuntimeError('Conflicting approved scope')
scope_text = json.dumps(scope, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
scope_hash = hashlib.sha256(scope_text.encode()).hexdigest()
headers = {'Authorization': 'Bearer ' + os.environ['COOLIFY_TOKEN'], 'User-Agent': 'Cinetra-Deployment/1.0', 'Content-Type': 'application/json', 'Accept': 'application/json'}

def api(path, method='GET', body=None):
    request = urllib.request.Request(base + path, method=method, headers=headers, data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f'Coolify configuration/deployment request rejected with HTTP {error.code}') from None

def health():
    request = urllib.request.Request(url + '/api/v1/health', headers={'User-Agent': 'Cinetra-Deployment/1.0', 'Accept': 'application/json'})
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)

previous = health()
previous_push = previous.get('notifications', {})
if mode == 'preserve':
    status = previous.get('showStatus', {})
    if status.get('automaticWritesEnabled') is True and status.get('scopeSha256') != scope_hash:
        raise RuntimeError('Refusing to replace an active approved scope during a routine deployment')
    mode = 'active' if status.get('automaticWritesEnabled') is True else 'prepare'
if mode == 'active' and requested_mode != 'preserve' and (previous.get('showStatus', {}).get('scopeSha256') != scope_hash or previous.get('showStatus', {}).get('automaticWritesEnabled') is not False):
    raise RuntimeError('Active rollout requires the verified prepared six-show scope')

def set_env(key, value):
    variables = api(f'/applications/{app_id}/envs')
    existing = [e for e in variables if e['key'] == key and not e.get('is_preview')]
    if len(existing) > 1:
        raise RuntimeError('Ambiguous application environment variable: ' + key)
    api(f'/applications/{app_id}/envs', 'PATCH' if existing else 'POST', {'key': key, 'value': value, 'is_preview': False, 'is_literal': True, 'is_runtime': True, 'is_buildtime': False})
    saved = [e for e in api(f'/applications/{app_id}/envs') if e['key'] == key and not e.get('is_preview')]
    if len(saved) != 1 or saved[0].get('value') != value or saved[0].get('is_runtime') is False:
        raise RuntimeError('Runtime setting could not be verified: ' + key)

# Only these three keys change; notification configuration remains untouched.
if mode == 'prepare':
    set_env('TV_STATUS_RECONCILIATION_ENABLED', 'false')
    set_env('TV_STATUS_RECONCILIATION_SCOPE', scope_text)
    set_env('TV_STATUS_ACTIVATION_BATCH_ENABLED', 'true')
else:
    set_env('TV_STATUS_ACTIVATION_BATCH_ENABLED', 'false')
    set_env('TV_STATUS_RECONCILIATION_SCOPE', scope_text)
    set_env('TV_STATUS_RECONCILIATION_ENABLED', 'true')
queued = api(f'/deploy?uuid={app_id}', 'POST')
print('Scoped deployment queued: ' + queued['deployments'][0]['deployment_uuid'], flush=True)
for attempt in range(100):
    try:
        current = health()
        status = current.get('showStatus', {})
        ready = current.get('version') == os.environ['GITHUB_SHA'] and status.get('automaticWritesConfigured') == ('true' if mode == 'active' else 'false')
        if ready:
            assert status['scopeSha256'] == scope_hash
            assert status['scopedShows'] == 6
            assert status['automaticWritesEnabled'] is (mode == 'active')
            assert status['running'] is (mode == 'active')
            assert status['activationBatchEnabled'] is (mode == 'prepare')
            for key in ('enabled', 'configured', 'running', 'intervalMinutes'):
                assert current.get('notifications', {}).get(key) == previous_push.get(key), 'Web Push runtime changed: ' + key
            print(f'Live revision verified; mode={mode}; six-show scope verified; Web Push preserved.', flush=True)
            break
    except (OSError, ValueError):
        pass
    time.sleep(10)
else:
    raise RuntimeError('Live deployment safety verification timed out')
