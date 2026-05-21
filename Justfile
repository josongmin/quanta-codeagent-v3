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

# Default recipe: show the recipe list.
default:
    @just --list

# Tikitaka REPL — interactive multi-turn conversation. Pass an optional
# positional prompt to short-circuit into one-shot mode.
cli *args:
    {{BUN}} run {{CLI}} {{args}}

# One-shot prompt with edits auto-approved (safer default for non-interactive).
once prompt:
    QUANTA_PERMISSION=acceptEdits {{BUN}} run {{CLI}} {{quote(prompt)}}

# Force OpenAI provider (env override).
cli-openai *args:
    QUANTA_LLM_PROVIDER=openai {{BUN}} run {{CLI}} {{args}}

# Force Anthropic provider (env override).
cli-anthropic *args:
    QUANTA_LLM_PROVIDER=anthropic {{BUN}} run {{CLI}} {{args}}

# Smoke battery (tier-0 replay — hermetic, no API key needed).
smoke *args:
    {{BUN}} run tests/smoke/index.ts {{args}}

# Smoke battery with the LIVE provider (needs OPENAI_API_KEY / ANTHROPIC_API_KEY).
smoke-live *args:
    {{BUN}} run tests/smoke/index.ts --tier=live {{args}}
