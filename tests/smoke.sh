#!/usr/bin/env bash
set -euo pipefail
HF_TEST_SKILL="$(cd "$(dirname "$0")/.." && pwd)"
node --test "$HF_TEST_SKILL/tests/"*.test.mjs
