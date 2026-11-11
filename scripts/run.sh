#!/bin/bash
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/node-env.sh"
if ! nihao_runtime_ready; then
  echo 'Project Node is not ready. Run: bash scripts/setup-env.sh (or double-click setup.command).' >&2
  exit 1
fi
nihao_use_runtime
nihao_mode=${1:-start}
case "$nihao_mode" in
  start|dev)
    [[ -d node_modules ]] || { echo 'Dependencies are missing. Rerun setup.command.' >&2; exit 1; }
    if [[ "$nihao_mode" == start && ! -f dist/server.mjs ]]; then
      echo 'Build is missing. Rerun setup.command.' >&2; exit 1
    fi
    "$nihao_node" --env-file-if-exists=.env scripts/check-env.mjs || {
      echo 'Fill in .env before starting. No API key values are printed.' >&2; exit 1;
    }
    if [[ "$nihao_mode" == start ]]; then
      exec "$nihao_node" --env-file-if-exists=.env --use-env-proxy dist/server.mjs
    else
      exec "$nihao_node" --env-file-if-exists=.env scripts/dev.mjs
    fi
    ;;
  check) exec "$nihao_node" --env-file-if-exists=.env scripts/check-env.mjs ;;
  build|typecheck|test) exec "$nihao_node" "$nihao_npm" run "$nihao_mode" ;;
  *) echo 'Usage: bash scripts/run.sh [start|dev|check|build|typecheck|test]' >&2; exit 1 ;;
esac
