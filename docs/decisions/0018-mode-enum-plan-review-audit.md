# ADR-0018 — Mode enum: default / plan / review / audit

Status: accepted (2026-05-20)
Phase: SOTA++ Codex absorption — Phase 3

## Context

`planMode: boolean` (ADR-0004 era) collapses interaction-shape information
into one bit: write-tools allowed / blocked. Codex
`mode-and-plan-process-audit.md` shows that mode is not just a permission —
it is the **place where human choice is structurally injected into the
loop**:

- **default** — assume-and-execute; forward progress, plain-text questions
  only when undiscoverable.
- **plan** — checkpoint-and-choose; structured branch points the user can
  resolve.
- **review** — read-only, findings-first output ({file:line, severity, what,
  why, impact}).
- **audit** — read-only, contract-vs-truth across the four surfaces
  (type/owner/wire/test).

Codex's key insight: **mode is not a tone difference — it is when and how
human choice enters the loop**. Three out of four modes are read-only task
postures, so they all need the same `isMutatingToolBlockedInPlan` gate
generalized to a typed enum.

## Decision

1. Add `AgentMode = "default" | "plan" | "review" | "audit"` exported from
   `src/agent/prompt.ts`.
2. Create `src/agent/mode.ts` with:
   - `resolveAgentMode(mode, planMode)` — `mode` wins; falls back to
     `planMode:true → "plan"`; both absent → `"default"`.
   - `isMutatingToolBlockedInMode(mode, action)` — read-only set is
     `{plan, review, audit}`; mutating action blocked when mode is in set.
   - `modeBlockReason(mode, toolName)` — deny message string.
3. `src/agent/plan.ts` → thin deprecated alias delegating to
   `isMutatingToolBlockedInMode("plan", …)`. Existing callers compile
   unchanged.
4. `src/agent/admissibility-gate.ts` `runAdmissibilityGate` calls
   `resolveAgentMode` + the new gate (the SSOT extraction from
   `src/agent/dispatch.ts`, see ADR-0026); deny payload uses
   `modeBlockReason` so the model sees a mode-specific reason.
5. `src/agent/prompt.ts` `buildDynamicContext` adds mode notices:
   - `PLAN_NOTICE` (preserved).
   - **new** `REVIEW_NOTICE` — findings-first posture.
   - **new** `AUDIT_NOTICE` — four-truth-surface posture.

`AgentConfig.mode` is optional. Absent + `planMode` absent ⇒ `"default"` ⇒
byte-identical to pre-Phase-3.

## Mechanism

- `mode.ts` exports the canonical `resolveAgentMode(mode, planMode)` and
  `buildDynamicContext` (in `prompt.ts`) calls it directly — single source
  of precedence, no duplicate to drift. The dispatch admissibility gate
  also routes through the same function so the per-turn reminder and the
  dispatch gate never disagree on the active mode.
- The read-only mode set is centralized in `mode.ts`; future modes only need
  to be added in one place.

## Consequences

- Review/audit runs now have prompt-level posture switching AND
  dispatch-level mutating-tool blocking — they cannot accidentally edit.
- A `Plan` mode tool implementation (`update_plan` state machine,
  `request_user_input` structured choice) can be layered on later as a
  separate ADR; the enum opens the seam.
- Backward compat: `planMode: true` still works exactly as before.

## Tests

- `tests/unit/mode.test.ts` — full coverage of `resolveAgentMode`,
  `isMutatingToolBlockedInMode` per mode, `modeBlockReason`, and the
  deprecated `isMutatingToolBlockedInPlan` delegation.
- `tests/unit/prompt.test.ts` — REVIEW_NOTICE / AUDIT_NOTICE contents, mode
  precedence over planMode.
- `tests/unit/dispatch.test.ts` — unchanged (legacy `planMode:true` path
  remains byte-identical).

## References

- Codex `mode-and-plan-process-audit.md`.
- ADR-0004 (original plan-mode design — superseded by mode enum here).

## Intentional non-absorption — closure rationale (2026-05-21)

### L1-B — Plan-mode meta-tools (`update_plan` / `request_user_input`)
(status: HOLD)

The enum opens the seam for Codex-style plan-mode meta-tools (`update_plan`
state machine, `request_user_input` structured choice) but they are not
wired. Today `plan` mode only forbids mutating dispatch and injects
`PLAN_NOTICE`.

**Why hold:**
- Claude Code exposes `EnterPlanMode` / `ExitPlanMode` (permission
  gates), NOT a `update_plan` state machine. Codex' own `update_plan`
  binds to its daemon's structured-choice surface — there is no
  equivalent surface in a single-shot CLI session, so the data the tool
  would manipulate (plan revision graph, user selection ack) has no
  consumer.
- A meta-tool added without a daemon consumer is a sink: the model would
  emit `update_plan` calls but the CLI cannot present the structured
  choice back to the user; it would degrade to plain text the model
  already emits.

**Promotion path (L1 → L3):** gated on a daemon/IDE host that can render
structured plan revisions and round-trip user choice. At that point a
separate ADR (e.g. ADR-0028 "Plan meta-tool surface") defines the tool
schema, the registry binding, and the host protocol. Not done now —
no consumer.

### L3-F — review/audit notice (status: closed via dispatch e2e matrix)

review/audit modes are advisory-by-design: they switch prompt notices and
block mutating dispatch, but there is no separate `Review` / `Audit` tool
and the actual findings-format compliance (`{file:line, severity, what,
why, impact}` for review; four-truth-surface for audit) is **prompt-only**
guidance the model is expected to follow. Real LLM behavior compliance
cannot be verified inside the deterministic test gate (it's a prompt
contract, not an executable one).

**What CAN be verified deterministically** (and is, as of 2026-05-21):
- `MUTATING_MODES` fail-closed: any tool whose dispatch reaches the
  admissibility gate under `plan`/`review`/`audit` is rejected with the
  mode-specific `modeBlockReason`.
- `REVIEW_NOTICE` / `AUDIT_NOTICE` prompt injection: the per-turn system
  prompt the LLM sees contains the mode-appropriate notice when and
  only when the mode is set.
- Matrix coverage: 4 modes × 4 mutating tools (edit / write /
  scripted_replace / mutating bash) — every combination dispatched
  through real `runAgent` + scripted LLM and asserted to produce the
  expected `ok:true | ok:false` outcome per the read-only set.

This closes the verifiable surface. The unverifiable surface (does the
real LLM honor the findings-first shape in a review run?) remains
**empirical** and lives in the Easy-5 bench smoke / future eval suites,
not the unit/integration tier.
