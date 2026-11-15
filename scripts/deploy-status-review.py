"""Deploy the read-only status review; never enable automatic status writes."""
import json
import os
import time
import urllib.request

base = os.environ['COOLIFY_URL'].rstrip('/') + '/api/v1'
app_id = os.environ['COOLIFY_APP_UUID']
headers = {'Authorization': 'Bearer ' + os.environ['COOLIFY_TOKEN'], 'Content-Type': 'application/json'}

def api(path, method='GET', data=None):
    request = urllib.request.Request(base + path, headers=headers, method=method,
                                    data=json.dumps(data).encode() if data is not None else None)
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)

notification_keys = {'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT', 'NOTIFICATIONS_SCHEDULER', 'NOTIFICATIONS_INTERVAL_MINUTES'}
def notification_env():
    return {e['key']: e.get('value') for e in api(f'/applications/{app_id}/envs') if e['key'] in notification_keys and not e.get('is_preview')}

push_before = notification_env()
# Touch only these keys; preserve notification keys and all other runtime configuration.
for key, value in [('TV_STATUS_RECONCILIATION_ENABLED', 'false'), ('APP_VERSION', os.environ['GITHUB_SHA'])]:
    envs = api(f'/applications/{app_id}/envs')
    exists = any(e['key'] == key and not e.get('is_preview') for e in envs)
    api(f'/applications/{app_id}/envs', 'PATCH' if exists else 'POST',
        {'key': key, 'value': value, 'is_preview': False, 'is_literal': True, 'is_runtime': True, 'is_buildtime': False})
    saved = [e for e in api(f'/applications/{app_id}/envs') if e['key'] == key and not e.get('is_preview')]
    if len(saved) != 1 or saved[0].get('value') != value:
        raise RuntimeError(f'{key} runtime configuration could not be verified; refusing deployment')
assert notification_env() == push_before, 'Notification configuration changed; refusing deployment'
print('Verified automatic TV status writes configured false; Web Push configuration unchanged.', flush=True)
application = api(f'/applications/{app_id}')
urls = application.get('fqdn', '').split(',')
url = next((u.strip().rstrip('/') for u in urls if u.strip().startswith('https://')), None)
if not url:
    raise RuntimeError('No HTTPS application URL available for rollout verification')
print('Review URL: ' + url, flush=True)
with urllib.request.urlopen(url + '/api/v1/health', timeout=20) as response:
    previous_health = json.load(response)
previous_push = previous_health.get('notifications', {})
queued = api(f'/deploy?uuid={app_id}', 'POST')
queue_id = queued['deployments'][0]['deployment_uuid']
print('Deployment queued: ' + queue_id, flush=True)
for _ in range(90):
    deployment = api(f'/deployments/{queue_id}')
    status = deployment.get('status')
    if status == 'finished':
        break
    if status in ('failed', 'cancelled'):
        raise RuntimeError('Deployment ' + status)
    time.sleep(10)
else:
    raise RuntimeError('Deployment verification timed out')
for _ in range(30):
    try:
        with urllib.request.urlopen(url + '/api/v1/health', timeout=20) as response:
            health = json.load(response)
        if health.get('version') == os.environ['GITHUB_SHA']:
            assert health['showStatus']['automaticWritesEnabled'] is False
            assert health['showStatus']['running'] is False
            print('Live revision verified; automatic writes disabled; status monitor stopped.', flush=True)
            for key in ('enabled', 'configured', 'running', 'intervalMinutes'):
                assert health.get('notifications', {}).get(key) == previous_push.get(key), 'Web Push runtime changed: ' + key
            print('Web Push scheduler enabled: ' + str(health.get('notifications', {}).get('enabled')), flush=True)
            break
    except (OSError, ValueError):
        pass
    time.sleep(5)
else:
    raise RuntimeError('Live safety verification failed')
