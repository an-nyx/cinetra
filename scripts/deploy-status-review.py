"""Approved full-library rollout. Credentials stay in the Actions runner environment."""
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

    # A failed build or migration cannot reach the activation step.
    staged = deploy()
    require(staged['showStatus']['mode'] == 'full-library', 'Unexpected status automation implementation')
    print('Tested revision deployed; migrations and Web Push health verified.', flush=True)
    settings = [{'key': key, 'value': value, 'is_buildtime': False,
                 'is_runtime': True, 'is_preview': False, 'is_literal': True}
                for key, value in [('TV_STATUS_RECONCILIATION_MODE', 'full-library'),
                                   ('TV_STATUS_RECONCILIATION_ENABLED', 'true')]]
    try:
        request(api + '/applications/' + app + '/envs/bulk', 'PATCH', {'data': settings}, token)
    except RuntimeError as error:
        raise RuntimeError(f'Activation environment update blocked: {error}. '
                           'Grant the existing COOLIFY_TOKEN application environment write permission, then rerun this workflow.') from None
    current = deploy()
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
