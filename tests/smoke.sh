#!/usr/bin/env bash
set -euo pipefail
HF_TEST_SKILL="$(cd "$(dirname "$0")/.." && pwd)"
# 러너가 실제 ~/.hyperfusion 기록(state·pacing·팀 파일)을 격리하고 Windows에서는 직렬로 돌린다.
exec node "$HF_TEST_SKILL/scripts/run-tests.mjs" "$HF_TEST_SKILL/tests/"*.test.mjs
