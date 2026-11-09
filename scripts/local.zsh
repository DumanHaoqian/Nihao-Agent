#!/bin/zsh
# Load the user's existing credential shortcuts without displaying their values.
# No credential is stored in this repository or passed on the command line.
nihao_mode=${1:-start}
# Oh My Zsh's automatic terminal titles are not useful in this noninteractive launcher.
DISABLE_AUTO_TITLE=true
if [[ -z "${POE_API_KEY:-}" || -z "${DOUBAO_API_KEY:-}" || -z "${BAIDU_MAP_API_KEY:-}" ]]; then
  if [[ -f "${ZDOTDIR:-$HOME}/.zshrc" ]]; then
    source "${ZDOTDIR:-$HOME}/.zshrc" >/dev/null 2>&1
  fi
fi
for nihao_loader nihao_variable in poe POE_API_KEY doubao DOUBAO_API_KEY baidumap BAIDU_MAP_API_KEY; do
  if [[ -z "${(P)nihao_variable}" ]] && (( $+aliases[$nihao_loader] || $+functions[$nihao_loader] )); then
    eval "$nihao_loader" >/dev/null 2>&1
  fi
done
cd "${0:A:h:h}" || exit 1
case "$nihao_mode" in
  start) exec node --use-env-proxy dist/server.mjs ;;
  dev) exec node scripts/dev.mjs ;;
  check)
    exec node --input-type=module -e '
      for (const name of ["POE_API_KEY", "DOUBAO_API_KEY", "BAIDU_MAP_API_KEY"]) {
        console.log(`${name}: ${process.env[name]?.trim() ? "loaded (value hidden)" : "not loaded"}`);
      }
      console.log("This checks environment loading, not provider authorization.");
    '
    ;;
  *) print -u2 -- 'Usage: zsh scripts/local.zsh [start|dev|check]'; exit 1 ;;
esac
