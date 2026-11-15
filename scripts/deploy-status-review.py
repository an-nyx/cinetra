"""Deploy the preview-only image and verify safety without changing Coolify settings."""
import json
import os
import time
import urllib.request

base = os.environ['COOLIFY_URL'].rstrip('/') + '/api/v1'
app_id = os.environ['COOLIFY_APP_UUID']
url = os.environ['CINETRA_URL'].rstrip('/')

def health():
    request = urllib.request.Request(url + '/api/v1/health', headers={'User-Agent': 'Cinetra-Deployment/1.0', 'Accept': 'application/json'})
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)

previous_push = health().get('notifications', {})
request = urllib.request.Request(
    base + f'/deploy?uuid={app_id}', method='POST',
    headers={'Authorization': 'Bearer ' + os.environ['COOLIFY_TOKEN'], 'User-Agent': 'Cinetra-Deployment/1.0', 'Accept': 'application/json'})
with urllib.request.urlopen(request, timeout=30) as response:
    queued = json.load(response)
print('Deployment queued: ' + queued['deployments'][0]['deployment_uuid'], flush=True)
# The Dockerfile forces the Node process flag to false. Coolify env settings and
# notification keys are never read, rewritten, or exposed by this workflow.
for attempt in range(100):
    try:
        current = health()
        if current.get('version') == os.environ['GITHUB_SHA']:
            assert current['showStatus']['automaticWritesConfigured'] == 'false'
            assert current['showStatus']['automaticWritesEnabled'] is False
            assert current['showStatus']['running'] is False
            for key in ('enabled', 'configured', 'running', 'intervalMinutes'):
                assert current.get('notifications', {}).get(key) == previous_push.get(key), 'Web Push runtime changed: ' + key
            print('Live revision verified; TV_STATUS_RECONCILIATION_ENABLED=false; status monitor stopped.', flush=True)
            print('Web Push settings and scheduler preserved.', flush=True)
            print('Review URL: ' + url, flush=True)
            break
    except (OSError, ValueError):
        pass
    time.sleep(10)
else:
    raise RuntimeError('Live deployment safety verification timed out')
