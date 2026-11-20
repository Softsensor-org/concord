#!/usr/bin/env bash
# COORD-870 (COORD-589 batch 7): permanent compatibility shim (a stable adopter
# entrypoint in coord/engine/shim-registry.json stable_entrypoints). The check
# lives at coord/engine/scripts/check-template-sync.sh; this launcher only
# re-executes it with the caller's arguments, so its options, output and exit
# codes are the engine script's.
set -euo pipefail

SHIM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$SHIM_DIR/../engine/scripts/check-template-sync.sh" "$@"
