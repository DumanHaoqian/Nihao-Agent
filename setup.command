#!/bin/bash
cd -- "$(dirname -- "$0")" || exit 1
bash scripts/setup-env.sh
nihao_result=$?
if [[ -t 0 ]]; then read -r -p 'Press Enter to close this window…' nihao_answer; fi
exit "$nihao_result"
