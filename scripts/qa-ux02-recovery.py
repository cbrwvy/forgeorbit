#!/usr/bin/env python3
"""Bounded UX02 recovery. Private capsule only; no app discovery/name launches.

Compile qa-native-pid.m into OUT/qa-native-pid first. Run outside the terminal
sandbox with existing AX permission. Never prompts for or changes permissions.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.request

CAPSULE = Path('/private/tmp/fo-mvp-ux02-33_0dgv3')
ROOT = CAPSULE / 'runtime'
APP = ROOT / 'artifacts/ForgeOrbitQA-dev.app'
OUT = Path(os.environ.get('FORGEORBIT_QA_EVIDENCE_ROOT', '/private/tmp/fo-mvp-ux02-recovery01'))
if 'FORGEORBIT_QA_EVIDENCE_ROOT' in os.environ:
    # A new acceptance campaign must not append to historical evidence. This
    # controls only the QA controller, never the packaged app environment.
    assert OUT == OUT.resolve(strict=True) and OUT.is_relative_to('/private/tmp')
    assert OUT.stat().st_uid == os.getuid() and OUT.stat().st_mode & 0o077 == 0
EVIDENCE = OUT / 'evidence'
EVIDENCE.mkdir(mode=0o700, exist_ok=True)
MANIFEST = CAPSULE / 'evidence/artifact-files.json'
if (EVIDENCE / 'build-result.json').exists():
    APP = ROOT / 'artifacts/ux02-recovery01/ForgeOrbitQA-dev.app'
    MANIFEST = EVIDENCE / 'artifact-files.json'
os.umask(0o077)


def write(name, value):
    path = EVIDENCE / (name + '.json')
    with path.open('x') as stream:
        json.dump(value, stream, indent=2, ensure_ascii=False)
        stream.write('\n')


def read(path):
    return json.loads(path.read_text())


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def artifact():
    expected = read(MANIFEST)
    actual = {str(p.relative_to(APP)): digest(p) for p in APP.rglob('*') if p.is_file()}
    assert actual == expected, 'artifact changed'
    return len(actual)


def creds():
    c = read(ROOT / 'data/agetor-core.json')
    assert c['kind'] == 'app' and c['port'] == 49791
    return c


def api(method, path, data=None):
    c = creds()
    request = urllib.request.Request('http://127.0.0.1:49791' + path, method=method,
        headers={'Authorization': 'Bearer ' + c['token'], 'Content-Type': 'application/json'},
        data=json.dumps(data).encode() if data is not None else None)
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=10) as response:
        return json.loads(response.read())


def obs():
    return json.loads(api('GET', '/preferences')['qa.ux02-observation'])


def guard():
    binding = read(OUT / 'binding.json')
    c = creds()
    assert c['pid'] == binding['corePid'], 'credential owner PID changed'
    listeners = subprocess.check_output(['/usr/sbin/lsof', '-nP', '-a', '-p', str(c['pid']), '-iTCP', '-sTCP:LISTEN'], text=True)
    assert '127.0.0.1:49791 (LISTEN)' in listeners and '127.0.0.1:50000 (LISTEN)' in listeners
    defaults = api('GET', '/defaults')
    assert defaults['home'] == str(ROOT / 'home') and defaults['dataDir'] == str(ROOT / 'data')
    env = read(CAPSULE / 'runtime-env.json')
    assert env['HOME'] == str(ROOT / 'home') and env['FORGEORBIT_DATA_DIR'] == env['AGETOR_DATA_DIR'] == str(ROOT / 'data')
    assert all(env[f'AGETOR_{k}_DRIVER'] == 'fake' for k in ['CLAUDE', 'CODEX', 'CURSOR', 'GEMINI', 'FX', 'ANTIGRAVITY'])
    for relative in ['Contents/Info.plist', 'Contents/MacOS/launcher', 'Contents/MacOS/bun']:
        assert digest(APP / relative) == read(MANIFEST)[relative]
    current = obs()
    assert current['protocol'] == 'views:' and current['capturedAt'] >= binding['launchTime'] * 1000
    return binding


def native(command, *args):
    guard()
    return subprocess.check_output([str(OUT / 'qa-native-pid'), str(OUT / 'binding.json'), command, *map(str, args)], text=True)


def state():
    tasks = api('GET', '/tasks')
    return {'tasks': tasks, 'runs': {t['id']: api('GET', '/tasks/' + t['id'] + '/runs') for t in tasks},
        'attempts': {t['id']: api('GET', '/employee-execution/attempts?taskId=' + t['id']) for t in tasks}}


mode = sys.argv[1]
if mode == 'closure':
    absent = []
    for pid in [80861, 80875, 79618, 79622]:
        result = subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'pid=,comm='], capture_output=True, text=True)
        assert result.returncode == 1 and not result.stdout, 'historical PID currently present; inspect before proceeding'
        absent.append(pid)
    for port in [4317, 49791, 50000]:
        result = subprocess.run(['/usr/sbin/lsof', '-nP', '-iTCP:' + str(port), '-sTCP:LISTEN'], capture_output=True, text=True)
        assert result.returncode == 1 and not result.stdout
    repo = Path.cwd()
    old = repo / 'docs/qa/evidence/fo-mvp-ux02'
    manifest = read(old / 'manifest.json')
    for item in manifest['files']:
        assert digest(old / item['path']) == item['sha256']
    for item in read(old / 'preserved-reports.json'):
        assert digest(repo / item['path']) == item['sha256']
    con = sqlite3.connect((ROOT / 'data/agetor.sqlite').as_uri() + '?mode=ro', uri=True)
    runs = con.execute('SELECT status, count(*) FROM runs GROUP BY status').fetchall()
    assert not runs
    con.close()
    write('incident-closure', {'at': time.time(), 'absentPids': absent, 'portsFree': [4317, 49791, 50000],
        'historicalEvidenceHashesVerified': len(manifest['files']), 'artifactFilesVerified': artifact(),
        'privateRuns': runs, 'historicalReportsUnchanged': 3,
        'productionStartupEffects': 'Unknown; existing evidence does not establish effects; production contents not inspected'})
    print('Incident closure verified; production impact remains Unknown')
elif mode == 'preflight':
    assert not (ROOT / 'data/agetor-core.json').exists()
    artifact()
    for port in [49791, 50000]:
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', port))
    code = f'const m=await import({json.dumps(str(CAPSULE / "source/src/bun/native-qa-environment.ts"))});m.assertNativeQaEnvironment({json.dumps(str(ROOT))},process.env);console.log("QA environment and exact stubs PASS")'
    subprocess.run([str(CAPSULE / 'tools/bun'), '-e', code], cwd=ROOT / 'projects', env=read(CAPSULE / 'runtime-env.json'), check=True)
    write('preflight-' + sys.argv[2], {'at': time.time(), 'artifactFiles': artifact(), 'roots': str(ROOT), 'portsFree': [49791, 50000]})
elif mode == 'launch':
    run = sys.argv[2]
    assert not (ROOT / 'data/agetor-core.json').exists()
    artifact()
    with (EVIDENCE / ('native-' + run + '.log')).open('x') as log:
        child = subprocess.Popen(['/usr/bin/sandbox-exec', '-f', str(CAPSULE / 'runtime.sb'), str(APP / 'Contents/MacOS/launcher')],
            cwd=ROOT / 'projects', env=read(CAPSULE / 'runtime-env.json'), stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        write('launch-' + run, {'pid': child.pid, 'app': str(APP), 'startedAt': time.time()})
        print('Exact artifact launcher PID', child.pid, flush=True)
        result = child.wait()
        write('exit-' + run, {'pid': child.pid, 'code': result, 'at': time.time()})
        print('Owned launcher exit', result, flush=True)
elif mode == 'bind':
    run = sys.argv[2]
    launch = read(EVIDENCE / ('launch-' + run + '.json'))
    for _ in range(100):
        try:
            c = creds()
            current = obs()
            prefs = api('GET', '/preferences')
            rpc = json.loads(prefs.get('qa.ux02-rpc', '{}'))
            stores = sorted((CAPSULE / 'evidence').glob('live-store-*.json'))
            store = read(stores[-1]) if stores else {}
            if current.get('capturedAt', 0) > launch['startedAt'] * 1000 and rpc.get('complete') and rpc.get('observedAt', 0) > launch['startedAt'] * 1000 and stores[-1].stat().st_mtime > launch['startedAt'] and store.get('views'):
                break
        except (OSError, ValueError):
            pass
        time.sleep(.25)
    else:
        raise RuntimeError('fresh native readiness not established')
    assert store['bundleIdentifier'] == 'app.forgeorbit.qa' and all(v['isPersistent'] is False for v in store['views'])
    assert rpc['authenticatedUpgrade'] and rpc['encryptedResponseFrames'] >= 1
    candidate = OUT / 'candidate.json'
    candidate.write_text(json.dumps({'corePid': c['pid'], 'launcherPid': launch['pid'], 'artifact': str(APP)}))
    identity = json.loads(subprocess.check_output([str(OUT / 'qa-native-pid'), str(candidate), 'identify'], text=True))
    assert identity['artifact'] == str(APP) and identity['executable'] == str(APP / 'Contents/MacOS/bun') and identity['launcherExecutable'] == str(APP / 'Contents/MacOS/launcher')
    assert identity['axTrusted']
    windows = [w for w in identity['windows'] if w.get('kCGWindowIsOnscreen') and w.get('kCGWindowLayer') == 0 and w['kCGWindowBounds']['Width'] >= 500]
    assert len(windows) == 1, 'ambiguous owned main windows'
    binding = {k: v for k, v in identity.items() if k != 'windows'}
    binding.update(launcherPid=launch['pid'], windowId=windows[0]['kCGWindowNumber'], launchTime=launch['startedAt'], run=run)
    (OUT / 'binding.json').write_text(json.dumps(binding, indent=2))
    guard()
    proof = json.loads(native('inspect'))
    write('identity-' + run, {'binding': binding, 'window': windows[0], 'store': store, 'rpc': rpc, 'ax': proof, 'artifactFiles': artifact()})
    print(json.dumps(binding, indent=2))
elif mode in ['focus', 'key', 'text', 'click', 'resize', 'press', 'focus-name']:
    binding = guard()
    args = sys.argv[2:]
    if mode == 'key':
        keys = {'return': 36, 'tab': 48, 'space': 49, 'escape': 53, 'left': 123, 'right': 124, 'down': 125, 'up': 126, 'q': 12, 'a': 0, 'backspace': 51}
        flags = {'none': 0, 'shift': 1 << 17, 'cmd': 1 << 20, 'option': 1 << 19}
        args = [keys[args[0]], flags[args[1]] if len(args) > 1 else 0]
    if mode == 'click':
        frame = json.loads(native('inspect'))['window']['kCGWindowBounds']
        args = [frame['X'] + float(args[0]), frame['Y'] + float(args[1])]
    if mode in ['press', 'focus-name'] and len(args) == 4:
        frame = json.loads(native('inspect'))['window']['kCGWindowBounds']
        args = args[:2] + [frame['X'] + float(args[2]), frame['Y'] + float(args[3])]
    started = time.time()
    # Codex can regain foreground between tool calls. Reactivate the exact PID;
    # the native helper still rejects every input unless foreground ownership
    # and process/window generation checks succeed again at dispatch time.
    if mode != 'focus':
        native('focus')
        time.sleep(.2)
    native(mode, *args)
    with (EVIDENCE / 'inputs.jsonl').open('a') as log:
        log.write(json.dumps({'at': started, 'run': binding['run'], 'corePid': binding['corePid'], 'windowId': binding['windowId'], 'command': mode, 'args': args, 'guards': 'API roots/listener/credentials/executable hashes + native process generation/tree/window guard per event'}) + '\n')
    time.sleep(.3)
    print('Verified native input', mode, args)
elif mode == 'show':
    guard()
    current = obs()
    print(current['visibleText'])
    print('ACTIVE', json.dumps(current['active']))
elif mode == 'snapshot':
    guard()
    name = sys.argv[2]
    current = obs()
    write(name, {'observation': current, 'ax': json.loads(native('inspect')), 'state': state()})
    print(json.dumps({k: current[k] for k in ['viewport', 'theme', 'active', 'dialogs', 'popups', 'alerts']}, indent=2))
elif mode == 'screenshot':
    binding = guard()
    native('inspect')
    path = EVIDENCE / (sys.argv[2] + '.png')
    assert not path.exists()
    subprocess.run(['/usr/sbin/screencapture', '-x', '-o', '-l', str(binding['windowId']), str(path)], check=True)
    print(path)
elif mode == 'ax':
    print(native('inspect'))
elif mode == 'cleanup':
    run = sys.argv[2]
    launch = read(EVIDENCE / ('launch-' + run + '.json'))
    receipt = EVIDENCE / ('exit-' + run + '.json')
    result = read(receipt) if receipt.exists() else {'code': 'Unknown', 'reason': 'launcher waiter receipt absent after interrupted tool turn'}
    assert result['code'] in [0, 'Unknown']
    rows = subprocess.check_output(['/bin/ps', '-axo', 'pid=,pgid=,comm='], text=True)
    assert not [line for line in rows.splitlines() if line.split()[1] == str(launch['pid'])]
    assert not (ROOT / 'data/agetor-core.json').exists()
    for port in [49791, 50000]:
        r = subprocess.run(['/usr/sbin/lsof', '-nP', '-iTCP:' + str(port), '-sTCP:LISTEN'], capture_output=True, text=True)
        assert r.returncode == 1 and not r.stdout
    fd = os.open(ROOT / 'data/desktop-instance.lock', os.O_RDWR)
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    fcntl.flock(fd, fcntl.LOCK_UN)
    os.close(fd)
    con = sqlite3.connect((ROOT / 'data/agetor.sqlite').as_uri() + '?mode=ro', uri=True)
    assert con.execute('PRAGMA integrity_check').fetchall() == [('ok',)]
    assert not con.execute('PRAGMA foreign_key_check').fetchall()
    tasks = con.execute('SELECT id,title FROM tasks').fetchall()
    runs = con.execute('SELECT status,count(*) FROM runs GROUP BY status').fetchall()
    con.close()
    write('cleanup-' + run, {'exit': result, 'ownedProcessGroupAbsent': True, 'credentialsAbsent': True, 'portsFree': [49791, 50000],
        'lockFree': True, 'sqliteIntegrity': 'ok', 'foreignKeys': 0, 'tasks': tasks, 'runs': runs, 'artifactFiles': artifact(), 'method': 'native PID-scoped Cmd+Q; see trusted events/input log'})
    print('Cleanup verified')
else:
    raise RuntimeError('Unknown mode')
