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
#   MODEL=gpt-4o just cli
MODEL := env_var_or_default("MODEL", "gpt-5")

# Default recipe: show the recipe list.
default:
    @just --list

# Tikitaka REPL — interactive multi-turn conversation. OpenAI + gpt-5 by
# default; override with `PROVIDER=anthropic` and/or `MODEL=...`. Pass an
# optional positional prompt to short-circuit into one-shot mode.
cli *args:
    QUANTA_LLM_PROVIDER={{PROVIDER}} QUANTA_MODEL={{MODEL}} {{BUN}} run {{CLI}} {{args}}

# One-shot prompt with edits auto-approved (safer default for non-interactive).
once prompt:
    QUANTA_LLM_PROVIDER={{PROVIDER}} QUANTA_MODEL={{MODEL}} QUANTA_PERMISSION=acceptEdits {{BUN}} run {{CLI}} {{quote(prompt)}}

# Explicit OpenAI alias — same as `just cli` when PROVIDER isn't overridden.
# Honors the `MODEL` env (defaults to gpt-5).
cli-openai *args:
    QUANTA_LLM_PROVIDER=openai QUANTA_MODEL={{MODEL}} {{BUN}} run {{CLI}} {{args}}

# Force Anthropic provider. Deliberately does NOT pass `MODEL` (gpt-5 would
# 404 on Anthropic) — uses the CLI's anthropic default model unless you set
# `QUANTA_MODEL=claude-...` explicitly.
cli-anthropic *args:
    QUANTA_LLM_PROVIDER=anthropic {{BUN}} run {{CLI}} {{args}}

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
    ./node_modules/.bin/tsc --noEmit

# Lint via Biome (warnings non-gating; non-zero exit on errors only).
lint:
    ./node_modules/.bin/biome check src tests

# Auto-fix lint + format (skip if your repo state is precious).
lint-fix:
    ./node_modules/.bin/biome check --write src tests

# Unit + integration suites (the deterministic gate; smoke battery folds in via
# `tests/unit/smoke-battery.test.ts`).
test *args:
    {{BUN}} test tests/unit tests/integration {{args}}

# Full pre-commit gate: typecheck → lint → test → smoke (tier-0 replay).
gates: typecheck lint test smoke
