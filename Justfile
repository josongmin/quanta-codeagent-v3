# quanta-codeagent task runner.
#
#   just            # list recipes
#   just cli        # interactive REPL (tikitaka — multi-turn back-and-forth)
#   just cli "msg"  # one-shot prompt (skip the REPL, run a single turn)
#
# The REPL reads from stdin line-by-line and feeds each line as the next
# user message, carrying the full conversation forward (see
# src/apps/cli/index.ts:77 `Interactive REPL loop`). With no positional
# argument the CLI starts in this mode — `just cli` is just the canonical
# entry point.

set shell := ["bash", "-uc"]

BUN := env_var_or_default("BUN", "/Users/songmin/.bun/bin/bun")
CLI := "src/apps/cli/index.ts"
# Default provider for `just cli` / `just once`. Override per-invocation:
#   PROVIDER=anthropic just cli      # one-off Anthropic
#   just cli-anthropic               # alias
PROVIDER := env_var_or_default("PROVIDER", "openai")
# Default OpenAI model. The adapter (`src/llm/adapters/openai.ts`) detects the
# GPT-5 family via `usesCompletionTokensParam` and auto-routes to
# `max_completion_tokens` — no extra config needed. Override per-invocation:
#   MODEL=gpt-5 just cli
MODEL := env_var_or_default("MODEL", "gpt-5-mini")

# Web surface — the daemon serves the agent over WS + the built SPA on ONE port.
#   just web-up    # build frontend + run daemon → http://localhost:4096
#   just daemon    # server only (after `just web-build`)
#   just web       # frontend dev server (Vite HMR) → http://localhost:5173
WEB_PORT := env_var_or_default("WEB_PORT", "4096")
WEB_BIND := env_var_or_default("WEB_BIND", "127.0.0.1")
WEB_DIR := "apps/web-frontend"

# Default recipe: show the recipe list.
default:
    @just --list

# Tikitaka REPL — interactive multi-turn conversation. OpenAI + gpt-5-mini by
# default; override with `PROVIDER=anthropic` and/or `MODEL=...`. Pass an
# optional positional prompt to short-circuit into one-shot mode.
cli *args:
    QUANTA_LLM_PROVIDER={{PROVIDER}} QUANTA_MODEL={{MODEL}} {{BUN}} run {{CLI}} {{args}}

# One-shot prompt with edits auto-approved (safer default for non-interactive).
once prompt:
    QUANTA_LLM_PROVIDER={{PROVIDER}} QUANTA_MODEL={{MODEL}} QUANTA_PERMISSION=acceptEdits {{BUN}} run {{CLI}} {{quote(prompt)}}

# Explicit OpenAI alias — same as `just cli` when PROVIDER isn't overridden.
# Honors the `MODEL` env (defaults to gpt-5-mini).
cli-openai *args:
    QUANTA_LLM_PROVIDER=openai QUANTA_MODEL={{MODEL}} {{BUN}} run {{CLI}} {{args}}

# Force Anthropic provider. Deliberately does NOT pass `MODEL` (gpt-5 would
# 404 on Anthropic) — uses the CLI's anthropic default model unless you set
# `QUANTA_MODEL=claude-...` explicitly.
cli-anthropic *args:
    QUANTA_LLM_PROVIDER=anthropic {{BUN}} run {{CLI}} {{args}}

# Attach the CLI to a RUNNING daemon's shared session over WS (multi-surface
# join — the daemon must already be up, e.g. via `just daemon`/`just web-up`).
# URL defaults to ws://127.0.0.1:{{WEB_PORT}}/; pass another as the first arg.
# Token via QUANTA_WEB_AUTH_TOKEN or `just cli-attach <url> --token <tok>`.
cli-attach *args="ws://127.0.0.1:4096/":
    {{BUN}} run {{CLI}} attach {{args}}

# --- web (server + frontend) --------------------------------------------

# Web daemon — agent-over-WS + the built frontend SPA on one port. Open
# http://localhost:{{WEB_PORT}} after `just web-build` (or just use `just web-up`).
# Override port/bind: `WEB_PORT=5000 WEB_BIND=0.0.0.0 just daemon`.
daemon *args:
    QUANTA_WEB_PORT={{WEB_PORT}} QUANTA_WEB_BIND={{WEB_BIND}} {{BUN}} run src/apps/web-daemon/index.ts {{args}}

# Build the web frontend (Vite → apps/web-frontend/dist). Skips the tsc gate
# (a pre-existing test-only type error blocks `bun run build`); use `just web-typecheck`.
web-build:
    cd {{WEB_DIR}} && bunx vite build

# Frontend dev server (Vite HMR) → http://localhost:5173. Run `just daemon` alongside for the WS backend.
web *args:
    cd {{WEB_DIR}} && {{BUN}} run dev {{args}}

# One-shot: build the frontend, THEN run the daemon serving it at http://localhost:{{WEB_PORT}}.
web-up: web-build daemon

# Stop whatever is listening on the web port.
web-down:
    pids="$(lsof -ti tcp:{{WEB_PORT}} || true)"; if [ -n "$pids" ]; then kill $pids && echo "killed $pids"; else echo "nothing on :{{WEB_PORT}}"; fi

# Frontend unit tests (vitest) + typecheck.
web-test:
    cd {{WEB_DIR}} && {{BUN}} run test

web-typecheck:
    cd {{WEB_DIR}} && bunx tsc --noEmit

# Compile the CLI to a standalone binary at ./dist/agent.
build:
    {{BUN}} run build

# Smoke battery (tier-0 replay — hermetic, no API key needed).
smoke *args:
    {{BUN}} run tests/smoke/index.ts {{args}}

# Smoke battery with the LIVE provider (needs OPENAI_API_KEY / ANTHROPIC_API_KEY).
smoke-live *args:
    {{BUN}} run tests/smoke/index.ts --tier=live {{args}}

# Record a LIVE trajectory for a scenario + propose an `expect.json` diff.
# Overwrites the scenario's `trajectory.jsonl` unless you pass `--dry`.
smoke-record id *args:
    {{BUN}} run tests/smoke/record-cli.ts {{id}} {{args}}

# Coverage report — tool × depth matrix + forbidden/retention/judge counts.
smoke-report:
    {{BUN}} run tests/smoke/index.ts --report

# --- gates ---------------------------------------------------------------

# Type-check the whole tree (no emit).
typecheck:
    {{BUN}} run typecheck

# Full type-check gate including tests.
typecheck-all:
    {{BUN}} run typecheck:all

# Lint via Biome (warnings non-gating; non-zero exit on errors only).
lint:
    {{BUN}} run tools/dev/run-biome.ts check

# Auto-fix lint + format (skip if your repo state is precious).
lint-fix:
    {{BUN}} run tools/dev/run-biome.ts check --write

# Unit + integration suites (the deterministic gate; smoke battery folds in via
# `tests/unit/smoke-battery.test.ts`).
test *args:
    {{BUN}} test tests/unit tests/integration {{args}}

# Full pre-commit gate: typecheck → lint → test → smoke (tier-0 replay).
gates: typecheck-all lint test smoke
