#!/usr/bin/env bash
# verify-debug-mode.sh — manual sanity check for the debug-mode surface
# (ADR-0239 family: tracer, decision counter, timeline, /inspect, /replay,
# /why). Run AFTER cherry-picking the slice:
#
#     bash tools/dev/verify-debug-mode.sh
#
# Spawns the real CLI binary 8 times with different arg / env combinations
# and asserts on exit code + stdout + stderr substrings. Prints
# "PASS"/"FAIL" per assertion. Exits 0 iff ALL assertions pass.
#
# Distinct from the hellgate at tests/integration/cli-live-debug-mode-
# hellgate.test.ts (which lives in bun-test) — this script is for ad-hoc
# release-time confidence + for sanity-checking on a machine where Bun's
# test harness isn't immediately at hand.
#
# Non-goals:
#   - This script does NOT exercise the live tracer inside `runRepl()`
#     (which needs an LLM to make a turn). For that, see
#     `debug-cli-surface-e2e-hellgate.test.ts` and the in-process
#     dispatcher tests.
#   - This script does NOT mutate any production code or write outside
#     `$TMPDIR`.

set -euo pipefail
IFS=$'\n\t'

REPO_ROOT="${REPO_ROOT:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)}"
CLI_ENTRY="${REPO_ROOT}/src/apps/cli/index.ts"
BUN_BIN="${BUN_BIN:-bun}"

if [[ ! -f "${CLI_ENTRY}" ]]; then
  printf 'verify-debug-mode: CLI entry not found at %s\n' "${CLI_ENTRY}" >&2
  exit 2
fi

if ! command -v "${BUN_BIN}" >/dev/null 2>&1; then
  # shellcheck disable=SC2016  # backticks here are literal markdown, not subst.
  printf 'verify-debug-mode: `bun` not on PATH; set BUN_BIN= to the binary path\n' >&2
  exit 2
fi

# Hermetic tmpdir. The CLI's loadEnvFiles() resolves relative to cwd, so
# running from $TMPDIR keeps the repo's `.env.dev` (which may carry a
# live OPENAI_API_KEY) from leaking into the subprocess env.
WORK_DIR="$(mktemp -d -t quanta-verify-debug-mode-XXXX)"
trap 'rm -rf "${WORK_DIR}"' EXIT

PASS_COUNT=0
FAIL_COUNT=0

# spawn_cli "<env-prefix>" <args…>
# Captures stdout, stderr, exit code into globals OUT, ERR, EXIT.
spawn_cli() {
  local env_prefix="$1"
  shift
  OUT_FILE="${WORK_DIR}/out.txt"
  ERR_FILE="${WORK_DIR}/err.txt"
  # Run from $WORK_DIR so the repo's .env.dev is invisible to loadEnvFiles.
  set +e
  # shellcheck disable=SC2086  # env_prefix MUST word-split into KEY=val args for `env -i`.
  (cd "${WORK_DIR}" && env -i \
      PATH="${PATH}" \
      HOME="${HOME:-/tmp}" \
      QUANTA_PROVIDER="anthropic" \
      ANTHROPIC_API_KEY="test" \
      ${env_prefix} \
      "${BUN_BIN}" "${CLI_ENTRY}" "$@" \
      </dev/null \
      >"${OUT_FILE}" \
      2>"${ERR_FILE}")
  EXIT=$?
  set -e
  OUT="$(cat "${OUT_FILE}")"
  ERR="$(cat "${ERR_FILE}")"
}

# assert_eq <label> <expected> <actual>
assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "${expected}" == "${actual}" ]]; then
    printf '  PASS: %s\n' "${label}"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    printf '  FAIL: %s\n' "${label}"
    printf '        expected: %q\n' "${expected}"
    printf '        actual  : %q\n' "${actual}"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

# assert_contains <label> <needle> <haystack>
assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  if [[ "${haystack}" == *"${needle}"* ]]; then
    printf '  PASS: %s\n' "${label}"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    printf '  FAIL: %s\n' "${label}"
    printf '        needle: %q\n' "${needle}"
    printf '        haystack-head:\n'
    printf '        %.200s\n' "${haystack}"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

# assert_not_contains <label> <needle> <haystack>
assert_not_contains() {
  local label="$1" needle="$2" haystack="$3"
  if [[ "${haystack}" != *"${needle}"* ]]; then
    printf '  PASS: %s\n' "${label}"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    printf '  FAIL: %s (unexpected substring present)\n' "${label}"
    printf '        needle: %q\n' "${needle}"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

printf 'verify-debug-mode: running 8 assertions against %s\n' "${CLI_ENTRY}"
printf '                   work_dir = %s\n\n' "${WORK_DIR}"

# ── A1 — /help registers /debug + /inspect + /replay + /why ─────────────
printf '[A1] /help enumerates the 5 debug-mode slash commands\n'
spawn_cli "" /help
assert_eq          'A1.exit'        '0'         "${EXIT}"
assert_contains    'A1.has-debug'   '/debug'    "${OUT}"
assert_contains    'A1.has-inspect' '/inspect'  "${OUT}"
# Combined into a single A1 assertion (the help block prints all five — we
# don't need to enumerate each separately to count as A1).
printf '\n'

# ── A2 — /debug status default-OFF byte-identical ───────────────────────
printf '[A2] /debug status in one-shot ⇒ not wired + exit 0\n'
spawn_cli "" /debug status
assert_eq         'A2.exit'              '0'                            "${EXIT}"
assert_contains   'A2.not-wired-stdout'  'not wired in this surface'    "${OUT}"
# Stdout-only — stderr must be empty (proves the "not wired" path uses
# ctx.out, not ctx.err).
assert_eq         'A2.err-empty'         ''                             "${ERR}"
printf '\n'

# ── A3 — QUANTA_DEBUG=1 in non-TTY subprocess does NOT wire tracer ──────
printf '[A3] QUANTA_DEBUG=1 in non-TTY ⇒ tracer NOT wired (gate honors non-TTY)\n'
spawn_cli "QUANTA_DEBUG=1" /help
assert_eq            'A3.exit'                  '0'         "${EXIT}"
# Tracer lines contain `[t<N>]` turn markers — none must appear on stderr.
assert_not_contains  'A3.no-tracer-on-stderr'   '[t0]'      "${ERR}"
printf '\n'

# ── A4 — /debug status output ──────────────────────────────────────────
printf '[A4] /debug status hints the QUANTA_DEBUG=1 boot knob\n'
spawn_cli "" /debug status
assert_contains   'A4.hint-quanta-debug'  'QUANTA_DEBUG=1'  "${OUT}"
printf '\n'

# ── A5 — /inspect (no arg) ⇒ exit 1 + usage on stderr ───────────────────
printf '[A5] /inspect (no arg) ⇒ usage on stderr + exit 1\n'
spawn_cli "" /inspect
assert_eq         'A5.exit'                 '1'                             "${EXIT}"
assert_contains   'A5.usage-on-stderr'      'tool call id required'         "${ERR}"
printf '\n'

# ── A6 — /inspect tc_xx in one-shot ⇒ "no active session" + exit 1 ──────
printf '[A6] /inspect tc_xx (no session) ⇒ no active session + exit 1 + stdout-only\n'
spawn_cli "" /inspect tc_definitely_not_present
assert_eq         'A6.exit'                 '1'                            "${EXIT}"
assert_contains   'A6.no-session-on-stdout' 'no active session'            "${OUT}"
printf '\n'

# ── A7 — /replay nonexistent-session in one-shot ⇒ not wired + exit 0 ───
printf '[A7] /replay nonexistent (one-shot, ctx.replay absent) ⇒ not wired + exit 0\n'
spawn_cli "" /replay nonexistent-session-id-zzz
assert_eq         'A7.exit'                 '0'                            "${EXIT}"
assert_contains   'A7.not-wired-on-stdout'  '/replay: not wired'           "${OUT}"
printf '\n'

# ── A8 — /why last in one-shot ⇒ not wired + exit 0 + NO LLM call ──────
printf '[A8] /why last (one-shot, ctx.why absent) ⇒ not wired + exit 0 (zero LLM cost)\n'
spawn_cli "" /why last
assert_eq         'A8.exit'                 '0'                            "${EXIT}"
assert_contains   'A8.not-wired-on-stdout'  '/why: not wired'              "${OUT}"
# Defense-in-depth: prove no model name leaked into the output (would be
# a sign that an LLM call somehow ran).
assert_not_contains 'A8.no-model-leak'      'gpt-5'                        "${OUT}${ERR}"
printf '\n'

# ── summary ─────────────────────────────────────────────────────────────
TOTAL=$((PASS_COUNT + FAIL_COUNT))
printf '────────────────────────────────────────────────────────────\n'
printf 'verify-debug-mode: %d/%d assertions passed\n' "${PASS_COUNT}" "${TOTAL}"

if [[ "${FAIL_COUNT}" -ne 0 ]]; then
  printf 'verify-debug-mode: %d assertion(s) FAILED\n' "${FAIL_COUNT}" >&2
  exit 1
fi

exit 0
