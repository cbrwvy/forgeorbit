#!/usr/bin/env python3
"""Retired FO-013A.1 native launcher. This entrypoint must never launch an app.

FO-013A.2: a missing IPC string or blocked-root marker is not isolation proof.
Use native-sdk-storage-audit.py for read-only source evidence. Future native QA
requires a separately approved disposable identity and a new reviewed harness.
The historical matrix is retained in Git and docs/qa/fo-013a1-validation.json.
"""


def main():
    raise SystemExit(
        "NATIVE-005 BLOCKED: native execution harness retired; no subprocess created. "
        "See docs/qa/fo-013a2-native-storage-isolation.md. "
        "Disposable macOS identity/VM and native execution require separate Owner approval."
    )


if __name__ == "__main__":
    main()
