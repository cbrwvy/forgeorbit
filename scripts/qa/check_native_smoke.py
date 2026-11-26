"""Synthetic-root inspection only; never activates an application."""
import argparse
import hashlib
import time
from native_smoke_contract import diagnose_defaults, persistence_status, prepare_evidence_dir, decode_api_response, check_first_runtime_token
import fcntl
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--campaign', required=True, type=Path)
parser.add_argument('--evidence-dir', type=Path, help='Private subdirectory under campaign/evidence; defaults to smoke02')
parser.add_argument('phase', choices=['baseline', 'running', 'stopped', 'restarted'])
args = parser.parse_args()
base = args.campaign
if not base.is_absolute() or base.resolve(strict=True) != base:
    raise RuntimeError('Campaign must be a canonical absolute directory')
if base.stat().st_uid != os.getuid() or base.stat().st_mode & 0o077:
    raise RuntimeError('Campaign must be private and owned by this UID')
evidence_dir = prepare_evidence_dir(base, args.evidence_dir)
root = base / 'runtime'
data = root / 'data'
app = root / 'artifacts/ForgeOrbit-dev.app'
phase = args.phase
assert phase in ['baseline', 'running', 'stopped', 'restarted']
os.umask(0o077)
assert data.resolve() == data and (data / 'agetor.sqlite').resolve() == data / 'agetor.sqlite'
db = sqlite3.connect((data / 'agetor.sqlite').as_uri() + '?mode=ro', uri=True)
assert db.execute('PRAGMA integrity_check').fetchall() == [('ok',)]
assert db.execute('PRAGMA foreign_key_check').fetchall() == []
assert db.execute('SELECT count(*) FROM tasks').fetchone()[0] == 0
assert db.execute('SELECT count(*) FROM runs').fetchone()[0] == 0
assert db.execute('SELECT count(*) FROM resource_accounts').fetchone()[0] == 0
assert db.execute('SELECT count(*) FROM harnesses WHERE enabled != 0 OR env_json != ?',['{}']).fetchone()[0] == 0
marker = db.execute('SELECT value FROM preferences WHERE key=?',['fo-native005-host02-marker']).fetchone()[0]
assert marker == 'synthetic-59b8ee0'
if phase in ['running', 'restarted']:
    if phase == 'restarted':
        assert (evidence_dir/'running-completed.json').is_file(), 'No completed first running phase'
    creds = json.loads((data / 'agetor-core.json').read_text())
    assert creds['port'] == 49731 and creds['kind'] == 'app'
    os.kill(creds['pid'], 0)  # existence check only; no signal sent
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    def request(path, authenticated=True, payload=None):
        headers = {'Authorization': 'Bearer ' + creds['token']} if authenticated else {}
        if payload is not None: headers['Content-Type'] = 'application/json'
        req = urllib.request.Request('http://127.0.0.1:49731' + path, headers=headers,
                                     data=json.dumps(payload).encode() if payload is not None else None,
                                     method='PUT' if payload is not None else 'GET')
        with opener.open(req, timeout=3) as response:
            return decode_api_response(response.status, response.read())
    assert request('/health', False) == {'ok':True, 'app':'agetor'}
    try: request('/defaults', False); raise RuntimeError('Unauthenticated defaults accepted')
    except urllib.error.HTTPError as error: assert error.code == 401
    defaults = request('/defaults')
    diagnostic = diagnose_defaults(defaults, root, app/'Contents/MacOS')
    output = evidence_dir / ('defaults-' + str(time.time_ns()) + '.json')
    with output.open('x') as report: json.dump(diagnostic, report, indent=2)
    print(json.dumps({'defaultsDiagnostic': diagnostic, 'evidence':str(output)}))
    if not diagnostic['pass']:
        raise RuntimeError('Defaults contract rejected; see per-field diagnostics. No API preference written.')
    assert any(p['path'] == str(root/'projects') and p['name'] == 'HOST02 synthetic smoke' for p in request('/projects'))
    assert request('/updates/status')['status'] == 'idle'
    token_hash = hashlib.sha256(creds['token'].encode()).hexdigest()
    first = evidence_dir / 'first-runtime-token-sha256.txt'
    if phase == 'running':
        check_first_runtime_token(first, token_hash, evidence_dir/'running-completed.json')
        request('/preferences/fo-native005-host02-roundtrip', payload={'value':'round1'})
    else:
        assert first.read_text().strip() != token_hash, 'Token did not rotate'
        assert request('/preferences')['fo-native005-host02-roundtrip'] == 'round1'
    assert db.execute('SELECT value FROM preferences WHERE key=?',['fo-native005-host02-roundtrip']).fetchone() == ('round1',)
    if phase == 'running':
        if not first.exists():
            with first.open('x') as out: out.write(token_hash + '\n')
        with (evidence_dir/'running-completed.json').open('x') as proof:
            json.dump({'phase':'running','defaultsContract':'PASS','apiPreferenceReadback':'round1','tokenSha256':token_hash},proof)
    print(json.dumps({'phase':phase,'api':'PASS','dataDir':str(data),'pid':creds['pid'],'sqlite':'integrity/FK PASS; synthetic API marker persisted','token':'redacted'}))
else:
    assert not (data / 'agetor-core.json').exists(), 'Core creds remain'
    with socket.socket() as sock: sock.bind(('127.0.0.1',49731))
    result = subprocess.run(['/usr/sbin/lsof','-t','+D',str(app)],capture_output=True,text=True)
    assert result.returncode == 1 and not result.stdout.strip() and not result.stderr.strip(), 'Bundle holders or unknown lsof result'
    records = set((base/'evidence').glob('launch-*.json')) | set(evidence_dir.glob('launch-*.json'))
    for record in records:
        pid=json.loads(record.read_text())['pid']
        try: os.kill(pid,0)
        except ProcessLookupError: pass
        else: raise RuntimeError('Recorded launcher still alive; do not restart')
    if phase == 'stopped':
        with (data / 'desktop-instance.lock').open('rb') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(lock, fcntl.LOCK_UN)
        persistence = persistence_status(
            db.execute('SELECT value FROM preferences WHERE key=?',['fo-native005-host02-roundtrip']).fetchone(),
            (evidence_dir/'running-completed.json').is_file())
        print(json.dumps({'phase':phase,'cleanup':'PASS','persistence':persistence}))
        if not persistence['pass']:
            db.close()
            raise SystemExit(2)  # no restart authorization from a partial run
    print(json.dumps({'phase':phase,'port':49731,'portFree':True,'coreCredsAbsent':True,'bundleOpenHandles':'none visible','sqlite':'integrity/FK PASS','nativeWindowResult':'NOT_ASSESSED'}))
db.close()
