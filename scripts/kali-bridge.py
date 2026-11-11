#!/usr/bin/env python3
"""Single-request guest bridge. Only local platform APIs; no arbitrary commands or URLs."""
import json
import re
import ssl
import subprocess
import sys
import urllib.error
import urllib.request

ENDPOINTS = {'artex': ('http', 8787), 'cyberstrikeai': ('https', 8080)}
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None
ROUTES = {
    'artex': {'GET': [r'/api/auth/status', r'/api/version', r'/api/tasks', r'/api/tasks/[\w-]+', r'/api/tasks/[\w-]+/chat/status'],
              'POST': [r'/api/auth/login', r'/api/chat\?task=[\w%-]+']},
    'cyberstrikeai': {'GET': [r'/api/auth/validate', r'/api/projects', r'/api/projects/[\w%-]+', r'/api/eino-agent/runs/[\w%-]+'],
                      'POST': [r'/api/auth/login', r'/api/eino-agent/runs']}
}

def request(kind, path, token=None, body=None, key=None):
    method = 'GET' if body is None else 'POST'
    if kind not in ROUTES or not any(re.fullmatch(pattern, path) for pattern in ROUTES[kind][method]):
        raise ValueError('unsupported platform operation')
    scheme, port = ENDPOINTS[kind]
    handlers = [urllib.request.ProxyHandler({}), NoRedirect()]
    if scheme == 'https':
        # The authenticated Parallels guest channel reads the certificate from guest
        # loopback. Trust that exact certificate for this request; hostname validation
        # remains enabled. This supports CyberStrikeAI's per-boot self-signed cert.
        pem = ssl.get_server_certificate(('127.0.0.1', port), timeout=3)
        handlers.append(urllib.request.HTTPSHandler(context=ssl.create_default_context(cadata=pem)))
    headers = {'Accept': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    if key:
        headers['Idempotency-Key'] = key
    data = None if body is None else json.dumps(body).encode()
    if data is not None:
        headers['Content-Type'] = 'application/json'
    opener = urllib.request.build_opener(*handlers)
    req = urllib.request.Request(f'{scheme}://127.0.0.1:{port}{path}', data=data, headers=headers, method=method)
    try:
        with opener.open(req, timeout=10) as res:
            if res.geturl() != req.full_url:
                raise ValueError('redirect not allowed')
            raw = res.read(2 * 1024 * 1024 + 1)
            if len(raw) > 2 * 1024 * 1024:
                raise ValueError('response too large')
            return {'status': res.status, 'data': json.loads(raw)}
    except urllib.error.HTTPError as error:
        return {'status': error.code, 'data': {}}

def probe(tokens):
    platforms = []
    for kind in ENDPOINTS:
        unit = 'dsh-artex.service' if kind == 'artex' else 'dsh-cyberstrikeai.service'
        auto = subprocess.run(['systemctl', 'is-enabled', unit], capture_output=True, text=True, timeout=3).stdout.strip()
        item = {'id': kind, 'autostart': auto == 'enabled'}
        try:
            path = '/api/version' if kind == 'artex' else '/api/auth/validate'
            response = request(kind, path, tokens.get(kind))
            item.update(reachable=response['status'] in [200, 401, 403], authenticated=response['status'] == 200 and bool(tokens.get(kind)), httpStatus=response['status'])
        except Exception:
            item.update(reachable=False, authenticated=False)
        platforms.append(item)
    return {'vm': 'running', 'platforms': platforms}

def main():
    raw = sys.stdin.buffer.read(65537)
    if len(raw) > 65536:
        raise ValueError('request too large')
    value = json.loads(raw)
    if value.get('operation') == 'probe':
        result = probe(value.get('tokens', {}))
    elif value.get('operation') == 'request':
        result = request(value['connector'], value['path'], value.get('token'), value.get('body'), value.get('key'))
    else:
        raise ValueError('unsupported operation')
    print(json.dumps(result, ensure_ascii=False))

if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Do not echo request values, credentials, upstream response bodies or traceback.
        print(json.dumps({'error': 'guest bridge request failed'}))
        sys.exit(1)
