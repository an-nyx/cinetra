"""Deploy while preserving existing full-library settings. Credentials stay in the Actions runner environment."""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


def request(url, method='GET', data=None, token=None):
    headers = {'User-Agent': 'Cinetra-Deployment/1.0'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    if data is not None:
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, method=method, headers=headers,
                                 data=json.dumps(data).encode() if data is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        # Do not print API response bodies, URLs or credentials.
        raise RuntimeError(f'{method} API request rejected: HTTP {error.code}') from None


def sync_runtime_env(api, app, token):
    """Upsert optional runtime-only variables (SONARR_URL, SONARR_API_KEY) into the Coolify application before deploying.

    Values come from GitHub Actions secrets and are sent only to the Coolify API. Nothing but variable names and
    actions is printed; API responses (which may contain other variables' values) are never printed.
    """
    wanted = {key: os.environ.get(key, '').strip() for key in ('SONARR_URL', 'SONARR_API_KEY')}
    if not all(wanted.values()):
        print('Sonarr runtime variables not provided; leaving Coolify environment unchanged.', flush=True)
        return False
    require(wanted['SONARR_URL'].startswith('https://'), 'SONARR_URL must be an https:// URL')
    application = request(api + '/applications/' + app, token=token)
    require(application.get('build_pack') != 'dockercompose',
            'Compose build pack: variables must also be referenced in the compose file')
    envs = request(api + '/applications/' + app + '/envs', token=token)
    require(isinstance(envs, list), 'Unexpected environment listing from Coolify')
    sample = next((env for env in envs if isinstance(env, dict)), {})
    # Runtime only: never passed to the image build. Use whichever flag names this Coolify version exposes.
    flags = {'is_runtime': True, 'is_buildtime': False} if 'is_buildtime' in sample else \
        {'is_build_time': False} if 'is_build_time' in sample else {}
    for key, value in wanted.items():
        current = [env for env in envs if isinstance(env, dict) and env.get('key') == key and not env.get('is_preview')]
        if current and current[0].get('value') == value and all(current[0].get(f) == v for f, v in flags.items()):
            print(f'Coolify variable {key}: unchanged', flush=True)
            continue
        body = {'key': key, 'value': value, 'is_preview': False, 'is_literal': True, **flags}
        request(api + '/applications/' + app + '/envs', 'PATCH' if current else 'POST', body, token=token)
        print(f'Coolify variable {key}: {"updated" if current else "created"} (runtime only)', flush=True)
    keys = {env.get('key') for env in request(api + '/applications/' + app + '/envs', token=token) if isinstance(env, dict) and not env.get('is_preview')}
    require(all(key in keys for key in wanted), 'Coolify did not store the Sonarr variables')
    return True


def verify_sonarr(health):
    """Read-only: the new process reports a successful Sonarr check (status, root folders, quality profiles)."""
    for _ in range(30):
        sonarr = health().get('sonarr') or {}
        if sonarr.get('checkedAt'):
            require(sonarr.get('configured') is True, 'Sonarr variables are not configured in the running app: '
                    + str(sonarr.get('configError')))
            require(sonarr.get('connected') is True, 'Production cannot reach Sonarr: ' + str(sonarr.get('error')))
            require((sonarr.get('rootFolders') or 0) > 0 and (sonarr.get('qualityProfiles') or 0) > 0,
                    'Sonarr returned no root folders or quality profiles')
            print('Sonarr connectivity verified: ' + json.dumps({k: sonarr[k] for k in ('connected', 'rootFolders', 'qualityProfiles')}), flush=True)
            return
        time.sleep(5)
    raise RuntimeError('Sonarr connectivity check did not run after deployment')


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def verify_push(current, baseline):
    for key in ('enabled', 'configured', 'running', 'intervalMinutes'):
        require(current['notifications'][key] == baseline['notifications'][key],
                f'Web Push setting changed: {key}')
    require(current['notifications']['configError'] is None, 'Web Push configuration error')
    require(current['notifications']['lastError'] is None, 'Web Push scheduler error')


def main():
    public_url = os.environ['CINETRA_URL'].rstrip('/')
    api = os.environ['COOLIFY_URL'].rstrip('/') + '/api/v1'
    app = urllib.parse.quote(os.environ['COOLIFY_APP_UUID'], safe='')
    token = os.environ['COOLIFY_TOKEN']
    revision = os.environ['GITHUB_SHA']
    health = lambda: request(public_url + '/api/v1/health')
    before = health()
    for key in ('enabled', 'configured', 'running'):
        require(before['notifications'][key] is True, f'Web Push preflight failed: {key}')
    verify_push(before, before)

    def deploy():
        result = request(api + '/deploy?uuid=' + app, 'POST', token=token)
        deployments = result.get('deployments', [])
        require(len(deployments) == 1 and deployments[0].get('deployment_uuid'),
                'Deployment API did not return exactly one deployment')
        deployment = urllib.parse.quote(deployments[0]['deployment_uuid'], safe='')
        for _ in range(180):
            state = request(api + '/deployments/' + deployment, token=token)
            status = state.get('status')
            require(status not in ('failed', 'cancelled', 'canceled'),
                    'Coolify deployment ' + str(status) + '; activation halted')
            if status == 'finished':
                current = health()
                require(current.get('version') == revision, 'Production revision does not match tested commit')
                verify_push(current, before)
                return current
            time.sleep(10)
        raise RuntimeError('Coolify deployment timed out; activation halted')

    # Only the optional Sonarr variables may be added/updated; every other runtime setting is left untouched.
    sonarr_configured = sync_runtime_env(api, app, token)
    current = deploy()
    print('Tested revision deployed; migrations and Web Push health verified.', flush=True)
    if sonarr_configured:
        verify_sonarr(health)
    status = current['showStatus']
    require(status['automaticWritesEnabled'] is True and status['automaticWritesConfigured'] == 'true'
            and status['activationMode'] == 'full-library' and status['running'] is True,
            'Production reconciliation activation or monitor check failed')
    # Both schedulers must finish a pass in the new process. No synthetic viewing or notification data.
    for _ in range(120):
        current = health()
        require(current.get('version') == revision, 'Production revision changed during verification')
        verify_push(current, before)
        status = current['showStatus']
        require(status['running'] and status['automaticWritesEnabled'], 'Status monitor stopped')
        require(status['lastError'] is None, 'Status monitor reported an error')
        if status['lastRun'] and current['notifications']['lastTickFinishedAt']:
            print('Full-library reconciliation enabled; background pass: ' + json.dumps(status['lastRun']), flush=True)
            push = current['notifications']['lastRun']
            require(push is not None and push['failed'] == 0 and push['retry'] == 0,
                    'Web Push pass reported delivery failures or retries')
            print('Web Push scheduler pass verified: ' + json.dumps({k: push[k] for k in
                  ('devices', 'showsChecked', 'delivered', 'failed', 'retry')}), flush=True)
            return
        time.sleep(10)
    raise RuntimeError('Background status or notification pass did not finish before verification timeout')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Deployment verification failed: ' + str(error), file=sys.stderr)
        sys.exit(1)
