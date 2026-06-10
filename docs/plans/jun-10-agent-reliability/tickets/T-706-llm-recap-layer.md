# T-706: Gated LLM recap layer on the deterministic skeleton

**RFC:** [07·W6](../07-rfc-pre-handoff-state-summary.md) · **Priority:** P2 · **Size:** M · **Deps:** T-701 · **Posture:** OFF (`QUANTA_PREHANDOFF_RECAP`)

## Deliverable
Optional short model-composed recap paragraph attached alongside the deterministic skeleton, reusing away-summary's tools-denied single-turn port (`src/agent/away-summary/port.ts`). Recap rubric absorbs Cursor's continuation-summary content checklist (explicit requests / approach / key decisions / file names / errors / user feedback — corpus `cursor-agent-exec/dist/main.js:~154897`). Skeleton must remain complete without it; recap failure → skeleton-only (no-throw).

## Acceptance criteria
- [ ] Gate OFF → zero LLM calls, byte-identical outcome.
- [ ] Recap failure degrades silently to skeleton.
- [ ] Rubric-pinned prompt test (verbatim system prompt, away-summary pattern).
