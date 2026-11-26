#!/usr/bin/env python3
"""Read installed SDK sources as data, without imports, subprocesses or network.

Pattern hits are evidence pointers, not a capability detector or permission to
launch. Missing/changed sources stay UNKNOWN. No input can produce safety PASS.
Exit 2 means native safety remains blocked, including when inspection succeeds.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re


FILES = {
    "package": "package.json",
    "window": "dist/api/bun/core/BrowserWindow.ts",
    "view": "dist/api/bun/core/BrowserView.ts",
    "ffi": "dist/api/bun/proc/native.ts",
    "socket": "dist/api/bun/core/Socket.ts",
    "launcher": "dist/main.js",
    "config": "dist/api/bun/ElectrobunConfig.ts",
    "utils": "dist/api/bun/core/Utils.ts",
}
PATTERNS = {
    "initialViewCreation": ("window", r"const webview = new BrowserView\("),
    "viewPartition": ("view", r"this\.partition = options\.partition \|\| null"),
    "fixedIpcPrefixString": ("view", r"/private/tmp/electrobun_ipc_pipe_"),
    "inactivePipeDestructure": ("ffi", r"// pipePrefix: string;"),
    "persistentFallback": ("ffi", r'toCString\(partition \|\| "persist:default"\)'),
    "socketListener": ("socket", r"server = Bun\.serve"),
    "workerCreation": ("launcher", r"new Worker\(appEntrypointPath, \{\}\)"),
    "nativeEventLoop": ("launcher", r"lib\.symbols\.startEventLoop\("),
    "asarTemporaryRoot": ("launcher", r"const systemTmpDir = tmpdir\(\)"),
    "supportedQuit": ("utils", r"native\.symbols\.stopEventLoop\(\)"),
}


def inspect_sdk(sdk_root):
    report = {
        "task": "FO-013A.2", "status": "BLOCKED",
        "nativeExecutionAuthorized": False, "nativeExecuted": False,
        "scope": "source-only; does not certify runtime storage or binary provenance",
        "version": "Unknown", "sources": {}, "observations": {}, "errors": [],
    }
    sources = {}
    try:
        root = Path(sdk_root).resolve(strict=True)
        if not root.is_dir():
            raise ValueError("SDK root must be a directory")
    except (OSError, ValueError):
        report["errors"].append("SDK root unavailable")
        return report
    for key, relative in FILES.items():
        try:
            file = (root / relative).resolve(strict=True)
            if not file.is_relative_to(root) or not file.is_file():
                raise ValueError("source escapes SDK root or is not a file")
            if file.stat().st_size > 4_000_000:
                raise ValueError("source too large")
            data = file.read_bytes()
            sources[key] = data.decode("utf-8")
            report["sources"][relative] = {"sha256": hashlib.sha256(data).hexdigest()}
        except (OSError, ValueError, UnicodeError):
            report["errors"].append("Missing, unsafe or unreadable source: " + relative)
    try:
        version = json.loads(sources.get("package", "{}"))["version"]
        if not isinstance(version, str):
            raise ValueError("invalid version")
        report["version"] = version
    except (KeyError, TypeError, ValueError):
        report["errors"].append("Missing or invalid SDK version")
    for name, (key, pattern) in PATTERNS.items():
        lines = [index for index, line in enumerate(sources.get(key, "").splitlines(), 1)
                 if re.search(pattern, line)]
        report["observations"][name] = {
            "status": "CONFIRMED_SOURCE" if lines else "UNKNOWN",
            "path": FILES[key], "lines": lines,
        }
    report["runtimeIpcFileCreation"] = "UNVERIFIED; a prefix string is not a filesystem trace"
    report["supportedCompleteStorageRedirection"] = "NOT ESTABLISHED"
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sdk-root", type=Path,
                        default=Path(__file__).resolve().parents[1] / "node_modules/electrobun")
    args = parser.parse_args()
    print(json.dumps(inspect_sdk(args.sdk_root), indent=2))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
