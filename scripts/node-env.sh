#!/bin/bash
# Shared by the setup and launcher scripts; requires no system Node or Python.
nihao_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
nihao_version=$(tr -d '\r\n' < "$nihao_root/.node-version")
if [[ ! "$nihao_version" =~ ^24\.[0-9]+\.[0-9]+$ ]]; then
  echo 'Invalid Node version in .node-version.' >&2
  exit 1
fi
case "$(uname -s)" in
  Darwin) nihao_platform=darwin ;;
  Linux) nihao_platform=linux ;;
  *) echo 'This installer supports macOS and Linux. On Windows, use Node 24.9+ with npm.' >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) nihao_arch=arm64 ;;
  x86_64|amd64) nihao_arch=x64 ;;
  *) echo 'Supported CPU architectures: arm64 and x64.' >&2; exit 1 ;;
esac
nihao_distribution="node-v${nihao_version}-${nihao_platform}-${nihao_arch}"
nihao_runtime="$nihao_root/.local/node-env/$nihao_distribution"
nihao_node="$nihao_runtime/bin/node"
nihao_npm="$nihao_runtime/lib/node_modules/npm/bin/npm-cli.js"

nihao_runtime_ready() {
  [[ -x "$nihao_node" && -f "$nihao_npm" ]] || return 1
  local actual
  actual=$("$nihao_node" -p 'process.version + "/" + process.platform + "/" + process.arch' 2>/dev/null) || return 1
  [[ "$actual" == "v${nihao_version}/${nihao_platform}/${nihao_arch}" ]]
}

nihao_use_runtime() {
  # npm child processes also resolve this Node before Conda/system binaries.
  export PATH="$nihao_runtime/bin:$PATH"
  export npm_config_cache="$nihao_root/.local/npm-cache"
  export npm_config_prefix="$nihao_root/.local/node-env/npm-global"
  cd -- "$nihao_root"
}
