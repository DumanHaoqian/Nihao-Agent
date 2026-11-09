#!/bin/sh
# Works from any directory and in environments that suppress editable .pth files.
set -eu
NIHAO_MODULE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$NIHAO_MODULE_DIR"
export PYTHONPATH="$NIHAO_MODULE_DIR/src${PYTHONPATH:+:$PYTHONPATH}"
exec "$NIHAO_MODULE_DIR/.venv/bin/python" -m nihao_ingest.cli "$@"
