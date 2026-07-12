#!/usr/bin/env bash
set -euo pipefail

# Compatibility entry point for source checkouts. Installation policy lives in
# create-concord/lib/install-plan.js and must not be reimplemented in shell.
# The standalone Linux SEA binary is the supported no-Node distribution.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: init.sh requires Node for the shared transactional installer." >&2
  echo "Use the standalone Concord SEA binary on hosts without Node." >&2
  exit 2
fi

for arg in "$@"; do
  case "$arg" in
    --repo|--backend|--frontend|--project|--no-git)
      echo "ERROR: $arg is no longer an install-time mutation." >&2
      echo "Install transactionally, then configure repositories with 'coord onboard'." >&2
      exit 2
      ;;
  esac
done

exec node "$SCRIPT_DIR/create-concord/bin/create-concord.js" "$(pwd)" "$@"
