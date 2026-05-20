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
