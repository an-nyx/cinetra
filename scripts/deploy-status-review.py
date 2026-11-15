"""Deploy the full-library review only; activation requires a separate approved release."""
import json, os, time, urllib.request
url = os.environ['CINETRA_URL'].rstrip('/')
def health():
    req = urllib.request.Request(url + '/api/v1/health', headers={'User-Agent': 'Cinetra-Deployment/1.0'})
    with urllib.request.urlopen(req, timeout=20) as r: return json.load(r)
before = health()
assert before['showStatus']['automaticWritesEnabled'] is False
assert before['showStatus']['automaticWritesConfigured'] == 'false'
req = urllib.request.Request(os.environ['COOLIFY_URL'].rstrip('/') + '/api/v1/deploy?uuid=' + os.environ['COOLIFY_APP_UUID'], method='POST', headers={'Authorization': 'Bearer ' + os.environ['COOLIFY_TOKEN'], 'User-Agent': 'Cinetra-Deployment/1.0'})
with urllib.request.urlopen(req, timeout=30) as r: json.load(r)
for _ in range(100):
    try:
        current = health()
        if current.get('version') == os.environ['GITHUB_SHA']:
            assert current['showStatus']['mode'] == 'full-library'
            assert current['showStatus']['automaticWritesEnabled'] is False
            assert current['showStatus']['automaticWritesConfigured'] == 'false'
            assert current['showStatus']['activationMode'] == 'review'
            assert current['showStatus']['running'] is False
            for key in ('enabled', 'configured', 'running', 'intervalMinutes'):
                assert current['notifications'][key] == before['notifications'][key]
            print('Read-only full-library review verified; automatic writes disabled; Web Push preserved.')
            break
    except (OSError, ValueError): pass
    time.sleep(10)
else: raise RuntimeError('Read-only rollout verification timed out')
