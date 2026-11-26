#!/usr/bin/env bash
# FO-DEPLOY03 — isolated deploy-staging.sh contract fixture (tests only).
set -euo pipefail

usage() {
  echo "Usage: deploy-staging-fixture.sh preflight|deploy|status <project> [--sha hex] [--dry-run] [--images-file path]" >&2
  exit 2
}

MODE="${STAGING_FIXTURE_MODE:-ok}"
SHA=""
DRY_RUN=0
IMAGES_FILE=""
PROJECT=""

while [ $# -gt 0 ]; do
  case "$1" in
    preflight|deploy|status) SUB="$1"; shift ;;
    --sha) SHA="${2:?}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --images-file) IMAGES_FILE="${2:?}"; shift 2 ;;
    -*) usage ;;
    *)
      if [[ "$1" =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]] && [ -z "$PROJECT" ]; then
        PROJECT="$1"; shift
      else
        usage
      fi
      ;;
  esac
done

[ "${SUB:-}" ] || usage
[ "$PROJECT" ] || usage

load_images() {
  [ -n "$IMAGES_FILE" ] || return 0
  [ -f "$IMAGES_FILE" ] || { echo "images file missing" >&2; exit 3; }
  # shellcheck disable=SC1090
  source "$IMAGES_FILE"
}

case "$SUB" in
  status)
    echo "=== $PROJECT (fixture) ==="
    echo "  current: {\"sha\":\"${SHA:-none}\",\"fixture\":true}"
    exit 0
    ;;
  preflight|deploy)
    [ "$SHA" ] || { echo "missing --sha" >&2; exit 4; }
    if [[ ! "$SHA" =~ ^[0-9a-f]{40}$ ]]; then
      echo "invalid sha" >&2
      exit 5
    fi
    load_images
    case "$MODE" in
      missing_digest)
        echo "missing image digest" >&2
        exit 6
        ;;
      wrong_sha)
        echo "sha mismatch" >&2
        exit 7
        ;;
      artifact_mismatch)
        echo "artifact mismatch" >&2
        exit 8
        ;;
      preflight_fail)
        echo "preflight failed" >&2
        exit 9
        ;;
      dry_run_fail)
        if [ "$SUB" = "deploy" ] && [ "$DRY_RUN" = 1 ]; then
          echo "dry-run failed" >&2
          exit 10
        fi
        ;;
      deploy_fail)
        if [ "$SUB" = "deploy" ] && [ "$DRY_RUN" = 0 ]; then
          echo "deploy failed" >&2
          exit 11
        fi
        ;;
      timeout)
        sleep 30
        echo "timeout" >&2
        exit 12
        ;;
      duplicate)
        lock="${TMPDIR:-/tmp}/staging-fixture-lock-${PROJECT}"
        if [ -f "$lock" ]; then
          echo "duplicate deploy" >&2
          exit 13
        fi
        touch "$lock"
        ;;
    esac
    if [ "$SUB" = "preflight" ]; then
      echo "preflight ok project=$PROJECT sha=$SHA"
      exit 0
    fi
    if [ "$DRY_RUN" = 1 ]; then
      echo "dry-run ok project=$PROJECT sha=$SHA"
      exit 0
    fi
    echo "deploy ok project=$PROJECT sha=$SHA"
    exit 0
    ;;
  *) usage ;;
esac
