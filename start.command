#!/bin/bash
cd -- "$(dirname -- "$0")" || exit 1
bash scripts/run.sh start
nihao_result=$?
if [[ "$nihao_result" -ne 0 && -t 0 ]]; then read -r -p 'Press Enter to close this window…' nihao_answer; fi
exit "$nihao_result"
