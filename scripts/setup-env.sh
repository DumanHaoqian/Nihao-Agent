#!/bin/bash
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/node-env.sh"

mkdir -p "$nihao_root/.local/node-env"
nihao_lock="$nihao_root/.local/node-env/setup.lock"
if ! mkdir "$nihao_lock" 2>/dev/null; then
  echo 'Another setup may be running. Close it before retrying.' >&2
  echo "If a previous setup was forcibly terminated, remove the empty directory: $nihao_lock" >&2
  exit 1
fi
nihao_stage=''
nihao_phase='preparing the runtime'
nihao_cleanup() {
  local result=$?
  trap - EXIT
  if [[ -n "$nihao_stage" ]]; then rm -rf -- "$nihao_stage"; fi
  rmdir "$nihao_lock"
  if [[ "$result" -ne 0 ]]; then
    echo "Setup stopped while $nihao_phase. Fix the reported error, then rerun setup.command; existing .env values are preserved." >&2
  fi
  exit "$result"
}
trap nihao_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if ! nihao_runtime_ready; then
  if [[ -e "$nihao_runtime" ]]; then
    echo "The local runtime cannot run on this machine: $nihao_runtime" >&2
    echo 'Move that runtime directory aside and rerun setup. On Linux, a glibc-based distribution is required.' >&2
    exit 1
  fi
  for nihao_tool in curl tar; do
    command -v "$nihao_tool" >/dev/null || { echo "Missing prerequisite: $nihao_tool" >&2; exit 1; }
  done
  nihao_stage=$(mktemp -d "$nihao_root/.local/node-env/.download.XXXXXX")
  echo "Downloading official Node v$nihao_version ($nihao_platform/$nihao_arch)…"
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --retry 2 --connect-timeout 20 --max-time 600 \
    "https://nodejs.org/dist/v$nihao_version/$nihao_distribution.tar.gz" \
    --output "$nihao_stage/node.tar.gz"
  tar -xzf "$nihao_stage/node.tar.gz" -C "$nihao_stage"
  nihao_actual=$("$nihao_stage/$nihao_distribution/bin/node" -p 'process.version + "/" + process.platform + "/" + process.arch')
  [[ "$nihao_actual" == "v${nihao_version}/${nihao_platform}/${nihao_arch}" ]] || { echo 'Downloaded Node cannot run with the required version/architecture.' >&2; exit 1; }
  mv -- "$nihao_stage/$nihao_distribution" "$nihao_runtime"
else
  echo "Reusing project Node v$nihao_version ($nihao_platform/$nihao_arch)."
fi

nihao_use_runtime
if [[ ! -e .env ]]; then
  (umask 077; set -o noclobber; cat .env.example > .env)
  echo 'Created .env with empty API key fields.'
else
  echo 'Preserved existing .env.'
fi

nihao_phase='installing project dependencies'
echo 'Installing locked project dependencies…'
"$nihao_node" "$nihao_npm" ci --include=dev --no-fund
nihao_phase='building Nihao Agent'
"$nihao_node" "$nihao_npm" run build
nihao_phase='checking configuration'
if "$nihao_node" --env-file-if-exists=.env scripts/check-env.mjs; then
  echo 'Environment ready. Start with: bash scripts/run.sh start (or double-click start.command).'
else
  echo 'Runtime and build are ready. Fill the three API keys in .env, then double-click start.command.'
fi
