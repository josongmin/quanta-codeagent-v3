# ADR-0497: guardian per-action TYPED assessment (binary verdict → discriminated assessment)

- **상태**: Accepted
- **날짜**: 2026-06-07
- **관련**:
  - Ticket: `docs/tickets/misc-jun-7/03-guardian-per-action-assessor.md`
  - Types + collapse: `src/permission/types.ts` (`ActionAssessment` / `ALL_ASSESSMENT_KINDS` / optional `ReviewerPort.guardianAssess`), `src/permission/assessment-collapse.ts` (`collapseAssessment`)
  - Dispatch: `src/permission/reviewer.ts` (`dispatchFresh` — knob-gated branch)
  - Assessor adapter: `src/agent/tier1/reviewer-subagent.ts` (`createSubagentBackedGuardianAssess`), `src/agent/reviewer-port.ts` (optional `guardianAssess` wiring)
  - Tests: `tests/unit/guardian-assessment-collapse-hellgate.test.ts`, `tests/unit/guardian-assessor-subagent-hellgate.test.ts`
  - Knob: `QUANTA_GUARDIAN_ASSESSOR` (`src/shared/runtime-config.ts` `guardianAssessor`, `gateOnStrict` `=== "1"`)
  - Competitor source: Codex 0.135 (`.extracted_source/codex/_codex-rs-0.135-symbols.txt` — `GuardianAssessmentEvent` / `GuardianApprovalReviewAction` / `ReviewDecision`)

## Context

quanta's guardian/reviewer is binary: every tier ultimately collapses to approve or deny
(`reviewer-subagent.ts` emits a two-value `guardian_approved | guardian_denied`). The guardian can
veto but cannot allow-with-modification, ask-the-human as a first-class outcome, deny with a
machine-classifiable reason, or escalate a capability request. Codex 0.135 structures every action
into a typed per-action assessment with a richer decision set (`approved_exec` / `proposed_exec` /
`network_policy_amendment` / `denied` / `abort` / `timed_out`). This is a strict superset of quanta's
binary.

## Decision

Add a typed `ActionAssessment` discriminated union (kinds: `allow` / `allow_for_session` /
`allow_with_edit` / `ask` / `deny` / `deny_and_steer` / `escalate`) emitted by an OPT-IN richer
assessor, which **collapses to the existing `ApprovalDecision` at a single pure boundary**
(`collapseAssessment`) before any current consumer. The collapse routes through `buildDecision`, so
the `outcome.ts` ADMISSIBLE matrix is the second line of defense; everything downstream of the
collapse (`reviewer.ts` dispatch matrix, `admissibility-gate.ts` allow/deny/steer/HITL routing) is
UNCHANGED.

The richer assessor is wired as an OPTIONAL `ReviewerPort.guardianAssess?` method (minimum blast
radius — option (1) in the ticket §4.b). `reviewAction`'s `dispatchFresh` calls it ONLY when the
active tier is `guardian_subagent`, the method is present, AND the `QUANTA_GUARDIAN_ASSESSOR` knob is
strictly on; otherwise it falls through to the verbatim binary `guardianReview`. The assessor is the
SAME guardian subagent round-trip with a richer reply schema — no extra LLM pass.

## Default posture

OFF, byte-identical. `gateOnStrict(env, "QUANTA_GUARDIAN_ASSESSOR")` (`=== "1"`). Absent the knob (or
the optional method, which every current `ReviewerPort` impl omits), `guardianAssess` is never called,
`collapseAssessment` is never reached, and the guardian path is the exact current binary
`ApprovalDecision`. A loose-truthy value (`"true"`) does NOT arm it — this is a security boundary.

## Correctness invariants (hellgate-proven)

1. **Collapse is TOTAL + CONSERVATIVE.** Only `allow` / `allow_for_session` collapse to an allow
   outcome; every other variant collapses to at least a deny. Property test over `ALL_ASSESSMENT_KINDS`.
2. **Unknown/future kind ⇒ fail-closed.** A version-skew / malformed-but-typed kind reaching the
   collapse at runtime (past the compile-time `never` guard) falls to `guardian_denied`, never allow.
3. **`allow_with_edit` never runs the original.** The guardian's corrected input is a counter-proposal;
   the conservative collapse turns it into a `guardian_denied` + `reject_and_tell` steer (the edit
   becomes a steering suggestion). Threading the edit through the executor would need a NEW
   reviewer→input-mutation hop (the gate's `onInputMutation` sink fires in the pre_tool_use stage,
   AFTER the reviewer verdict — ticket §9.2); until that hop exists, deny-with-steer is the only safe
   collapse.
4. **`allow_for_session` does not widen authority.** A machine assessor's sticky-allow collapses to a
   one-shot `guardian_approved`, never `user_approved_for_session` (which the matrix forbids for the
   guardian tier anyway — it would throw).
5. **`escalate` never auto-grants.** Default collapse is a forced ask-the-human (fail-closed
   guardian_denied with a categorical steer naming the requested axis). A sandbox/policy auto-grant is
   a separate, separately-gated opt-in (deferred).
6. **Matrix second-line.** The collapse output flows through `buildDecision`; any (reviewer, outcome)
   pair it produced that violates the ADMISSIBLE matrix throws `OutcomeInvariantError`.
7. **No-leak (C6).** The assessor's fallback `denyReason.safeReason` is categorical, never the raw
   input/command.

## Scope / deferred (open questions)

- Variant set: ships the full verified Codex subset (7 kinds) but with conservative collapses for
  `allow_for_session` (→ one-shot) and `escalate` (→ ask); sticky session-allow and escalate-as-grant
  remain behind their own future gates (ticket §9.1).
- Action-CLASS axis (Codex's 6-class taxonomy) is NOT duplicated — the assessor reuses the existing
  `ReviewKind` on `ctx.reviewKind` (ticket §9.4).
- `GuardianDeniedAction` operator post-hoc override (ticket §9.5) is a follow-up — it needs a
  deny-memory mutation surface.
- Composition-root wiring (selecting `createSubagentBackedGuardianAssess` when the knob is on in
  `optional-ports.ts` / `index.ts` / `reviewer-policy.ts`) is the documented live-wire follow-up; the
  seam (pure types + collapse + adapter + dispatch branch) ships fully tested and OFF.
