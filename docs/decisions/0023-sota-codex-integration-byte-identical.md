# ADR-0023 — SOTA++ Codex absorption: integration + byte-identical invariant

Status: accepted (2026-05-20)
Phase: SOTA++ Codex absorption — Phase 8

## Context

Phases 0–7 (ADR-0015 … ADR-0022) absorbed Codex's operating contract into
quanta-codeagent-v3. Each phase shipped with its own tests and its own
default-OFF flag. This ADR records the integration contract that ties them
together and the byte-identical regression the suite enforces.

## Decision

### Integration contract

Each Phase adds at most ONE optional field to `AgentConfig`. None of them
default to ON. The matrix:

| Phase | Field | Default | When set |
|-------|-------|---------|---------|
| 0 | `mode?` | undefined (`"default"` resolved) | enum-typed mode wins over `planMode` |
| 0 | `repoRules?` | undefined | per-turn reminder gains a "Repo-local rules" block |
| 1 | (no new field) | — | static prompt augmentation only |
| 2 | `closeoutGuard.fourRule?` | `false` (legacy one-liner) | 4-rule defended-claim checklist |
| 3 | `mode?` (extended use) | `"default"` | dispatch blocks mutating tools in `plan`/`review`/`audit` |
| 4 | (default tool registration) | always-on (`scripted_replace` joins `defaultTools`) | LLM-routed, no behavior unless invoked |
| 5 | `hitl.enabled?` | `false` | HITL 4-tier gate engages |
| 6 | `workingState.enabled?` | `false` | session WorkingState + `update_working_state` tool |
| 7 | (uses existing `skills`) | absent ⇒ no block | active-skills block + trigger rules in reminder |

Reminder block ordering (top → bottom in the `<system-reminder>` tail):

```
Today's date is …
Working directory: …
[mode notice]              # Phase 0/3
[repo-local rules]         # Phase 0          ── authority
[active skills]            # Phase 7
[working state]            # Phase 6
[memory hints]             # labelled "routing hints only — not proof" (Phase 6)
```

This order encodes Codex's trust ladder structurally: authority (repo
rules) precedes posture (skills) precedes state (working) precedes hints
(memory).

### Byte-identical invariant

Pre-Phase-0 callers (bench, dev CLI) must observe **identical loop
behavior** when none of the new fields are set. The suite enforces this
along three rails:

1. **Type-level**: every new field on `AgentConfig` is `?` optional with no
   default fill-in inside the loop.
2. **Runtime**: absent field ⇒ `undefined` short-circuit at the earliest
   point, no allocation, no decision branch in the hot path.
3. **Tests**: existing test files were not modified to add new fields
   except where the test itself is intentionally exercising a Phase.
   `dispatch.test.ts`, `prompt.test.ts` (legacy sections), `closeout-guard
   .test.ts` (legacy cases), `verify-guard.test.ts`, and the bench
   integration tests all run their pre-Phase-0 assertions unchanged.

### Verification matrix

The integration check (Phase 8) is the combined test suite:

```
tsc --noEmit                             ✓ 0 errors
bun test tests/unit/                     ✓ 1163+ pass / 0 fail
bun test tests/integration/              ✓ 133+ pass / 0 fail
```

Counts grew from 1058 (pre-Phase-0) to 1163+ across unit, and 131 → 133
across integration. No legacy test was modified to make a Phase pass.

## Mechanism

The contract is **"behaviorally equivalent for legacy flows"** — strict
byte-identical applies to the LOOP control flow and emit ordering, NOT to
the LLM request payload (which legitimately grows when new policy prose
and new always-on tools are added). Three patterns recur:

- **`?` field on AgentConfig + explicit `undefined` short-circuit at the
  call site**: e.g. `verifyGuard`, `closeoutGuard.fourRule`,
  `hitl.enabled`, `workingState.enabled`. These are structurally
  byte-identical — the absent field traverses a `undefined` short-circuit
  at the earliest point with no allocation.
- **New tools default-registered but LLM-routed**: e.g. `scripted_replace`
  is registered in `defaultTools` always-on. The model only invokes it
  when prompt routes there, but the tool SCHEMA does enter the LLM request
  (~776 bytes JSON / ~194 tokens per turn). Legacy LOOP behavior is
  unchanged; LLM input bytes are not (this is the deliberate cost of
  Phase 4 — a fresh tool only adds value when it's discoverable). The
  bench harness can pass an explicit `registry` to opt out if a baseline
  comparison demands identical tool listings.
- **Static prompt growth**: Phase 1's policy stack / ladders / budget /
  honesty rail / reporting shape add ~11,500 bytes (~2,874 tokens) to
  `buildSystemPrompt`. The provider cache prefix grows but stays
  byte-stable across a session, so cache hits are preserved — first-turn
  cost +$0.0086 (Anthropic) / +150–300ms TTFT, cached-turn cost
  +$0.00086 each. Legacy callers can override via `AgentConfig.system`
  to get the pre-Phase-1 prompt verbatim.

## Consequences

- The bench harness (which intentionally does NOT load repo rules and does
  NOT enable the new gates) sees byte-identical behavior post-Phase-0
  through pre-Phase-7. Easy-5 baseline (3/5 resolved) is preserved.
- Future callers (e.g. a developer CLI) can opt into the full SOTA++
  surface by setting all new flags; the prompt + dispatch + closeout chain
  composes consistently.
- Slice isolation (ADR-0001) was preserved across all Phases — no new
  cross-slice imports were introduced. Duck-typed mirrors handled
  cross-slice contracts (HITLTier, WorkingStateHandle).

## References

- ADR-0015 … ADR-0022 (the seven Phases this ADR integrates).
- RFC §1.2 (ROI-agnostic SOTA++ scope).
- Codex analysis directory (the absorption source):
  `/Users/songmin/Documents/code-new/semantica-codegraph-v2/docs/analysis/codex-agent/`.
