"""Token-free QA diagnostics. Never imports the application or opens a database."""

import hashlib
import json
import os
from pathlib import Path


FIELDS = ("home", "cwd", "dataDir")


def prepare_evidence_dir(campaign, requested=None):
    parent = Path(campaign) / "evidence"
    target = Path(requested) if requested is not None else parent / "smoke02"
    if not target.is_absolute() or target == parent or parent not in target.parents:
        raise ValueError("Evidence must be in a campaign-specific evidence subdirectory")
    if target.resolve() != target:
        raise ValueError("Evidence directory must be canonical without symlink escapes")
    target.mkdir(mode=0o700, parents=True, exist_ok=True)
    if target.stat().st_uid != os.getuid() or target.stat().st_mode & 0o077:
        raise ValueError("Evidence directory must be private and owned by this UID")
    return target


def decode_api_response(status, body):
    if status == 204:
        if body:
            raise ValueError("204 response must have no body")
        return None
    return json.loads(body)


def check_first_runtime_token(first, digest, completed):
    if Path(completed).exists():
        raise ValueError("First running phase already completed; use restart checks")
    if Path(first).exists() and Path(first).read_text().strip() != digest:
        raise ValueError("Incomplete phase belongs to another runtime token")


def _inside(root, value):
    if not isinstance(value, str) or not Path(value).is_absolute():
        return False
    candidate = Path(value)
    # Reject lexical escapes before inspecting any path outside the QA root.
    if ".." in candidate.parts or candidate == root or root not in candidate.parents:
        return False
    try:
        resolved = candidate.resolve(strict=True)
        return resolved != root and root in resolved.parents
    except OSError:
        return False


def diagnose_defaults(response, runtime_root, expected_cwd):
    root = Path(runtime_root).resolve(strict=True)
    expected = {"home": str(root / "home"), "cwd": str(expected_cwd), "dataDir": str(root / "data")}
    if not all(_inside(root, value) for value in expected.values()):
        raise ValueError("Expected paths must exist strictly inside the QA runtime root")
    is_object = isinstance(response, dict)
    actual = response if is_object else {}
    missing = sorted(set(FIELDS) - set(actual))
    extra = sorted(set(actual) - set(FIELDS))
    equality = {key: actual.get(key) == expected[key] for key in FIELDS}
    inside = {key: _inside(root, actual.get(key)) for key in FIELDS}
    safe_actual = {}
    for key in FIELDS:
        value = actual.get(key)
        if inside[key]:
            safe_actual[key] = value
        elif isinstance(value, str):
            digest = hashlib.sha256(value.encode()).hexdigest()[:12]
            safe_actual[key] = "<outside/invalid QA path; sha256=" + digest + ">"
        else:
            safe_actual[key] = "<missing or non-string>"
    return {
        "pass": is_object and not missing and not extra and all(equality.values()) and all(inside.values()),
        "expected": expected,
        "actual": safe_actual,
        "perFieldEqual": equality,
        "insideRuntimeRoot": inside,
        "extraFields": extra,
        "missingFields": missing,
        "responseIsObject": is_object,
    }


def persistence_status(marker_row, running_completed):
    """Cleanup can succeed independently; persistence needs completed API proof."""
    if not running_completed:
        return {"pass": False, "status": "NOT_PROVEN", "reason": "running phase did not complete"}
    if marker_row != ("round1",):
        return {"pass": False, "status": "FAIL", "reason": "API preference marker missing or changed"}
    return {"pass": True, "status": "PASS", "reason": "completed running phase and persisted API marker"}
