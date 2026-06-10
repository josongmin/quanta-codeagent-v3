# T-502: ADR-0397 env-block wiring closeout + git op-state line

**RFC:** [05·W2](../05-rfc-git-state-and-resume-staleness.md) · **Priority:** P1 · **Size:** M (bigger than "one line" — R4-H3) · **Deps:** T-501 · **Posture:** OFF initially (new registered gate)

## Deliverable
Two parts, both required:
(a) **Wire the built-not-wired env block:** `probeTurnEnv` (`src/agent/env-context.ts`) has zero live callers — thread its output into live context assembly (`src/agent/loop/context-assembler.ts:287-317` → `buildTurnContext` env input) behind a NEW registered gate (knob registry + `--help`; `QUANTA_ENABLE_ENV_PROBE` is the unrelated shell-probe — don't reuse). Default-OFF initially; ON-flip is a later measured decision.
(b) **Op-state line:** extend the block with T-501's result — `git: rebase in progress (3 conflicts unresolved)`; conflict count from porcelain v2 `u` lines (already parsed). Rendered only when an op is active.

## Acceptance criteria
- [ ] Live e2e: block appears in a real turn with gate ON.
- [ ] Per-op-state unit fixtures; no active op → no line.
- [ ] Gate OFF → byte-identical prompt.
- [ ] Knob registered in inventory + help (knob-systems grep done first).
