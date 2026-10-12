#!/usr/bin/env bash
# Quan ly n8n owner/API key. n8n chi bind 127.0.0.1 nen chay tren server.
# Flow that cua n8n 1.x (da kiem chung tren prod):
# - login tra cookie `n8n-auth` (khong co token trong body)
# - key nam o `.data.apiKey`, chi hien 1 lan luc tao
#
# Tao owner lan dau (chi chay 1 lan):
#   OWNER_PW='...' bash tools/setup-n8n.sh --setup [email]
# Xoay API key moi (can password owner de login):
#   OWNER_PW='...' bash tools/setup-n8n.sh --rotate [email]
set -euo pipefail
cd "$(dirname "$0")/.."

DC="sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml"
if [ "$(id -u)" = "0" ]; then DC="docker compose -f docker-compose.yml -f docker-compose.prod.yml"; fi
if groups 2>/dev/null | grep -q '\bdocker\b'; then DC="docker compose -f docker-compose.yml -f docker-compose.prod.yml"; fi

MODE="${1:-}"; EMAIL="${2:-admin@synapsedx.sbs}"
[ -z "${OWNER_PW:-}" ] && { echo "thieu OWNER_PW (password owner n8n)" >&2; exit 1; }
export OWNER_PW EMAIL MODE

python3 - <<'EOF'
import json, os, urllib.request
n8n, email, pw, mode = 'http://127.0.0.1:5678', os.environ['EMAIL'], os.environ['OWNER_PW'], os.environ['MODE']

def call(method, path, data=None, headers=None):
    req = urllib.request.Request(n8n + path,
        data=json.dumps(data).encode() if data is not None else None,
        headers={'Content-Type': 'application/json', **(headers or {})}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            try: body = json.loads(raw or b'null')
            except Exception: body = raw.decode()[:200]
            return r.status, body, dict(r.headers.items())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300], {}

if mode == '--setup':
    s, b, _ = call('POST', '/rest/owner/setup', {'email': email, 'firstName': 'Admin',
        'lastName': 'SynapseDX', 'password': pw})
    print('SETUP', s, str(b)[:150])
    if s != 200 and 'already setup' not in str(b):
        raise SystemExit(1)

# login -> cookie jar
s, b, h = call('POST', '/rest/login', {'email': email, 'password': pw})
jar = '; '.join(v.split(';')[0] for k, v in h.items() if k.lower() == 'set-cookie')
if s != 200 or not jar:
    print('LOGIN_FAILED', s, str(b)[:150]); raise SystemExit(1)
H = {'Cookie': jar}

# xoa key cu (neu co) de tranh unique-violation
s, b, _ = call('GET', '/rest/api-keys', None, H)
items = []
if isinstance(b, dict):
    d = b.get('data', [])
    items = d if isinstance(d, list) else [d]
for it in items:
    if isinstance(it, dict) and it.get('id'):
        call('DELETE', '/rest/api-keys/' + it['id'], None, H)
print('DELETED_OLD_KEYS', len(items))

# tao key moi
s, k, _ = call('POST', '/rest/api-keys', {'label': 'synapsedx-workflow'}, H)
d = (k.get('data') or {}) if isinstance(k, dict) else {}
key = d.get('apiKey') if isinstance(d, dict) else None
if s != 200 or not key:
    print('KEY_FAILED', s, str(k)[:200]); raise SystemExit(1)
open('/tmp/n8n_apikey.txt', 'w').write(key)
print('KEY_CREATED ok')
EOF

KEY="$(cat /tmp/n8n_apikey.txt)"; shred -u /tmp/n8n_apikey.txt 2>/dev/null || rm -f /tmp/n8n_apikey.txt
python3 - "$KEY" <<'EOF'
import sys
key = sys.argv[1].strip()
assert len(key) > 20
lines = [('N8N_API_KEY=' + key + '\n' if l.startswith('N8N_API_KEY=') else l)
         for l in open('.env').read().splitlines(True)]
open('.env', 'w').writelines(lines)
print('saved N8N_API_KEY to .env')
EOF
$DC up -d workflow >/dev/null 2>&1
sleep 12
echo "N8N_API_KEY=${KEY}"
echo "(da luu .env + up workflow — luu key vao password manager, key chi hien 1 lan)"
