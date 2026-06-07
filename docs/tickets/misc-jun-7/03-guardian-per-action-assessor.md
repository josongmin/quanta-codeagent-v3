# Ticket — Guardian / reviewer per-action TYPED assessment (binary verdict → discriminated assessment)

**Date:** 2026-06-07
**Status:** Design (NOT implementation). This ticket proposes seams; it ships no code.
**Gap:** `docs/backlog/jun-7-gap-other-agent.md` §3.1 (P3) — verified jun-07 src grep (`GuardianAssessmentAction`/`AssessmentAction`/`action_class`/`decision_source` grep **0** in `src/agent/` + `src/permission/`).
**Slice:** `@/agent` reviewer seam (`reviewer-port.ts` + `tier1/reviewer-subagent.ts`) consumed by `@/permission` (`reviewer.ts` dispatch, `outcome.ts` matrix) and the `@/agent/admissibility-gate` deny/steer/HITL surface. No new slice required; an ADDITIVE optional method on the existing port + a pure mapping module in `@/permission`.
**Candidate ADR:** next free (≥ 0497) — `docs/decisions/` tops out at `0496` as of jun-07.
**Default posture:** OFF, byte-identical. Absent the knob, the reviewer port surface stays the EXACT binary `ApprovalDecision` it is today — `reviewer-subagent.ts` keeps emitting `{outcome: "guardian_approved"|"guardian_denied", …}` and `reviewer.ts`/`outcome.ts`/`admissibility-gate.ts` keep consuming the 8-state `ApprovalOutcome` unchanged. The typed `ActionAssessment` is an ADDITIVE optional output (a new optional port method, OR a separately-selected richer port impl at the composition root) that **collapses to the existing `ApprovalDecision`** before it reaches any current consumer. Legacy consumers never see the new type; the collapse is byte-identical for the OFF path.
**Competitor source:** Codex 0.135 (`.extracted_source/codex/_codex-rs-0.135-symbols.txt`).
**ROI:** cost 중, impact 중-고. Turns the guardian from a veto into a steering wheel. `jun-07-gap-other-agent-audit` flags this P3 as 비용 중 / 보안 고.

---

## 1. Problem

quanta's guardian/reviewer is **binary**: every reviewer tier ultimately collapses to *approve* or *deny*. The guardian subagent's own contract is literally a two-value enum (`reviewer-subagent.ts:18` — `outcome: z.enum(["guardian_approved", "guardian_denied"])`), and the only way it can "steer" is a denial that piggybacks a `reject_and_tell` verb. The reviewer can **veto** but it cannot:

1. **allow-with-modification** — "this is fine if you change `--force` to `--force-with-lease`" / "write to `./out` not `/etc`". Today the guardian must DENY and hope the agent re-proposes; it cannot hand back a corrected input.
2. **ask-the-human** — the guardian has no first-class "I'm not sure, escalate to the operator" outcome. AUTO escalates to USER structurally, but the *guardian* tier can only approve or deny; an uncertain guardian must pick one, and the conservative pick (deny) wastes a turn.
3. **deny-with-actionable-reason** — denial reasons are free prose threaded through `reject_and_tell.message`; there is no typed, machine-classifiable refusal axis on the guardian path (the `StructuredDenyReason` layer exists at the GATE, but the guardian's own emitted shape carries only `rationale` + optional `steer` string).
4. **escalate** — "this needs a sandbox grant / a permission amendment, not a yes/no" — the guardian cannot request a *capability change*; it can only judge the action as-proposed.

The binary cap is the whole limitation: a reviewer that can only veto forces every nuanced judgement into approve-or-deny, which loses the signal the model needs to self-correct and forces avoidable human round-trips. Codex 0.135 structures every action into a typed, per-action-class assessment with a richer decision set; quanta has one opaque approve/deny dimension.

---

## 2. Current state (src-verified)

**The exact current verdict type — `reviewer-port.ts` + `permission/types.ts`.** The reviewer port's three methods all return `Promise<ApprovalDecision>` (`permission/types.ts:161-165`):

```ts
export interface ReviewerPort {
  autoReview(action: ToolActionKeyed, ctx: ReviewContext): Promise<ApprovalDecision>
  guardianReview(action: ToolActionKeyed, ctx: ReviewContext): Promise<ApprovalDecision>
  userReview(action: ToolActionKeyed, ctx: ReviewContext): Promise<ApprovalDecision>
}
```

`ApprovalDecision` (`permission/types.ts:115-130`) is value-only:

```ts
export interface ApprovalDecision {
  readonly reviewer: ReviewerTier          // "user" | "auto_review" | "guardian_subagent"
  readonly outcome: ApprovalOutcome        // the 8-state union below
  readonly riskLevel: "low" | "medium" | "high"
  readonly rationale: string
  readonly decidedAt: number
  readonly verb?: ReviewDecision           // ADR-0070 OPTIONAL richer verb
}
```

`ApprovalOutcome` (`permission/types.ts:102-110`) is the **8-state** union, but functionally **binary on the allow axis** — `outcome.ts:77-94` `isAllowed()` partitions it into exactly allow `{not_needed, config_allowed, guardian_approved, user_approved, user_approved_for_session}` vs deny `{guardian_denied, user_denied, user_aborted}`:

```
"not_needed" | "config_allowed" | "guardian_approved" | "guardian_denied"
| "user_approved" | "user_approved_for_session" | "user_denied" | "user_aborted"
```

**What `reviewer-subagent.ts` actually emits (the guardian tier).** `reviewer-subagent.ts:16-23` — the wire schema the guardian LLM must satisfy is a **two-value** outcome:

```ts
const guardianReplySchema = z.object({
  outcome: z.enum(["guardian_approved", "guardian_denied"]),
  rationale: z.string().min(1),
  steer: z.string().min(1).optional(),
  riskLevel: z.enum(["low", "medium", "high"]).optional(),
}).strict()
```

`riskLevel` is also coarse on the AUTO/USER adapters: `reviewer-port.ts:40-41` `riskLevelFor()` is literally `action.isReadOnly ? "low" : "high"`. The guardian denial+steer is mapped to `verb: {verb: "reject_and_tell", message: steer}` (`reviewer-subagent.ts:64, 89-91`). Malformed/failed child output → `fallbackDecision()` (`reviewer-subagent.ts:54-65`) which is a fail-closed `guardian_denied`.

**Every consumer of the verdict (enumerated — what a richer type touches):**

- **`permission/reviewer.ts`** — `reviewAction()` (`:216-233`) dispatches on `ctx.configReviewer` to `port.userReview` / `port.autoReview` / `port.guardianReview` and returns the `ApprovalDecision`; `pickStickyDenial` (`:101`) + `buildDecision` (`:131,139,168`) enforce the (reviewer × outcome) matrix.
- **`permission/outcome.ts`** — the truth tables every downstream reads without re-validating: `isTerminal` (`:56`), `isAllowed` (`:77`), `requiresUserConfirmation` (`:99`), the `ADMISSIBLE` matrix (`:128-142`), and `buildDecision` (`:158-190`) which **throws `OutcomeInvariantError`** on any (reviewer, outcome) the matrix forbids. This is the load-bearing invariant gate.
- **`agent/admissibility-gate.ts`** — the real consumer. `reviewAction` is awaited (`:569-570`) and `isAllowed(dec.outcome)` decides approve vs deny (`:570, 610`); the verb is validated against the reviewKind via `isDecisionLegalFor` (`:438, 602-606`); `reject_and_tell` is routed into `{decision: "deny_and_steer", steer}` → `DispatchResult.steerInjection` (`:457-470, 802, 848`); `user_aborted` / `guardian_denied` get categorical `denyReason({layer:"reviewer", safeReason: …})` (`:470, 480, 488, 495`). The gate already has an `onInputMutation(updatedInput)` sink (`:148, 664-666`) and an `onConfirm`/HITL path (`:857-882`).
- **`agent/reviewer-port.ts`** — the concrete adapters: `createOnConfirmReviewerPort` (USER tier via `onConfirm`, `:91-135`), `createClassifierBackedAutoReview` (`:53-85`), and the `unavailable()` fail-closed stubs for absent tiers (`:43-48, 132-133`).
- **`agent/optional-ports.ts`**, **`agent/index.ts`**, **`apps/cli/repl/reviewer-policy.ts:47-53`** — composition-root wiring (when `guardian_subagent` is selected: on-request + workspace-write only).

So a richer type touches: the port interface, the guardian subagent schema, the `reviewer.ts` dispatch, the `outcome.ts` matrix + truth tables, and the gate's allow/deny/steer/HITL routing. The collapse boundary must sit at exactly ONE of these so the rest stay byte-identical.

---

## 3. Competitor mechanism (verified — `_codex-rs-0.135-symbols.txt`)

Codex 0.135's guardian is a **per-action-class assessor** with two orthogonal typed axes (the audit's "6-variant typed" conflates them — both are real):

### 3.1 Action-class axis — `GuardianAssessmentAction` (6 variants)

The assessor first STRUCTURES the action into one of six typed classes (verified — `_codex-rs-0.135-symbols.txt:48205` `struct variant GuardianApprovalReviewAction::{McpToolCall, Command, RequestPermissions, NetworkAccess, Execve, ApplyPatch}`):

- `Execve` (4 fields: program/…) — a raw process exec.
- `Command` (3 fields) — a shell command.
- `ApplyPatch` (2 fields: files/…) — a file mutation.
- `McpToolCall` (5 fields: `tool_name`/`connector_id`/`connector_name`/`tool_title`/…) — an MCP invocation.
- `NetworkAccess` (4 fields) — network egress.
- `RequestPermissions` (2 fields: `target`/`permissions`) — a capability/permission request.

This is the "6-variant" the prior audit cited — it is the **action TAXONOMY**, the discriminant the assessor reasons over, NOT the decision. (quanta's nearest equivalent is `ReviewKind` in `review-kind.ts:45-52` — `edit|delete|terminal|mcp|web_fetch|web_search|plan`.)

### 3.2 Decision axis — the per-action assessment OUTCOME

The assessment EVENT carries a typed decision, not a bool. `GuardianAssessmentEvent` is an **11-element** struct (`:47742, 47789` "GuardianAssessmentEvent with 11 elements") whose decision-relevant fields are verbatim: `target_item_id`, **`risk_level`**, **`user_authorization`**, `rationale`, **`decision_source`**. The exec-approval decision set itself (`type ReviewDecision`, `_codex-rs-0.135-symbols.txt:7690`, and the concatenated variant blob at `:47742, :48203, :63374`) is, verbatim:

```
approved_exec [+ policy_amendment]      // allow (optionally amend the sandbox/permission policy)
proposed_exec [+ policy_amendment]      // allow-with-modification: counter-propose a different exec/policy
approved_for_session                    // allow + remember for the session (sticky)
network_policy_amendment                // escalate: amend the network policy rather than yes/no
denied                                  // deny
abort                                   // deny + halt the turn
timed_out                               // no human answer in time → fail-closed lifecycle state
```

Lifecycle is separately typed — `GuardianApprovalReviewStatus` (`:48190`) is `pending | approved | timedOut | aborted` (verbatim doc: "[UNSTABLE] Lifecycle state for an approval auto-review"), and `decision_source` / `AutoReviewDecisionSource` (`:3798, 48182`, "Source that produced a terminal approval auto-review decision") records WHO/WHAT produced the verdict. There is also a `GuardianDeniedAction` override path — a denied guardian action can be re-approved by the operator (`:1881-1882, 47341` "ignoring approval for non-denied Guardian assessment", `ThreadApproveGuardianDeniedActionParams` `:4414`).

**How each variant routes (verbatim mapping from the source):**
- `approved_exec` → run the action as-proposed.
- `approved_exec + policy_amendment` / `network_policy_amendment` → run AND apply a sandbox/network policy change (the **escalate** lane — a capability grant, not a yes/no).
- `proposed_exec + policy_amendment` → **allow-with-modification**: a counter-proposal the user/loop can accept (the modified exec/policy is threaded, not the original).
- `approved_for_session` → allow + sticky-remember (quanta's `user_approved_for_session`).
- `denied` → reject this action; `abort` → reject AND halt the turn (quanta's `user_denied` vs `user_aborted`).
- `timed_out` → fail-closed lifecycle terminal (no human answer).

This is a **strict superset** of quanta's binary: every Codex variant has a quanta home, but quanta has no `proposed_exec` (allow-with-mod) and no `*_policy_amendment` (escalate-as-capability-change) equivalent on the guardian path.

---

## 4. Design

A typed `ActionAssessment` discriminated union emitted by an OPT-IN richer assessor, which **collapses to the existing `ApprovalDecision`** before any current consumer. The new type is a STRICT SUPERSET: every variant maps to an existing `ApprovalOutcome` (+ existing seams), so OFF/legacy consumers see an unchanged collapsed verdict.

### 4.a The typed `ActionAssessment` (new, pure — `@/permission`)

A discriminated union on `kind`, carrying ONLY value data (loggable/serializable, parity with `ApprovalDecision`). We adopt the subset of Codex variants that have a clean quanta home **now** (see Open Questions §9 for deferred ones):

| `ActionAssessment.kind`      | Carries                                   | Collapses to `ApprovalOutcome` | Existing seam reused |
|------------------------------|-------------------------------------------|--------------------------------|----------------------|
| `allow`                      | `rationale`, `riskLevel`                  | `guardian_approved`            | (none new)           |
| `allow_for_session`          | `rationale`                               | `user_approved_for_session`†   | sticky-approval path |
| `allow_with_edit`            | `rationale`, **`updatedInput`**           | `guardian_denied` + steer ‡    | `onInputMutation(updatedInput)` (`admissibility-gate.ts:148,664`) + `updatedInput` plumbing |
| `ask`                        | `rationale`                               | (forced HITL → onConfirm)      | `onConfirm`/HITL (`admissibility-gate.ts:857-882`) |
| `deny`                       | **`StructuredDenyReason`**, `rationale`   | `guardian_denied`              | `structuredDenyReason({layer:"reviewer", pillar, safeReason})` (`deny-reason.ts:152`) |
| `deny_and_steer`             | `StructuredDenyReason`, **`steer`**       | `guardian_denied` + `verb:{verb:"reject_and_tell", message}` | existing `reject_and_tell` → `steerInjection` (`admissibility-gate.ts:457-470`) |
| `escalate`                   | `rationale`, `escalation` (sandbox/HITL)  | `ask` → HITL or sandbox-grant  | sandbox-escalation OR `onConfirm` HITL |

† `allow_for_session` collapsing to `guardian_approved` (the conservative one-shot) is the **OFF-safe** default; sticky session-allow is itself knob-gated because it widens authority — see §5. ‡ `allow_with_edit` deliberately collapses to a **deny** (never a silent allow) when the updatedInput plumbing is OFF or the consumer can't accept the edit — the original action does NOT run. See §5.

**The discriminant** mirrors `review-kind.ts`'s closed-union convention: union-of-literals + an `ALL_ASSESSMENT_KINDS` runtime tuple + exhaustive switches with a `never` default (parity with `ALL_OUTCOMES` `outcome.ts:19`, `ALL_REVIEW_DECISION_VERBS` `review-kind.ts:171`).

### 4.b Closed-port extension (composition-root selected)

Two options; **prefer (1)** for minimum blast radius:

1. **Optional richer method on `ReviewerPort`.** Add `guardianAssess?(action, ctx): Promise<ActionAssessment>` (optional). The dispatch (`reviewer.ts:216`) checks: if the active reviewer is `guardian_subagent` AND `port.guardianAssess` is present AND the knob is ON → call it and `collapseAssessment(assessment)` → `ApprovalDecision`; else fall through to the existing `port.guardianReview` verbatim. Absent the method (every current impl), the existing path is byte-identical.
2. **Separate `AssessorPort` selected at the composition root.** A new port `{ assess(action, ctx): Promise<ActionAssessment> }` wired ONLY when the knob is on; `optional-ports.ts`/`index.ts` choose binary-reviewer vs assessor at wire time. Heavier; keeps the binary port pristine.

Either way the **collapse is the single boundary**: `collapseAssessment(a: ActionAssessment): ApprovalDecision` is the one pure function the rest of the system flows through. Everything downstream of the collapse (`outcome.ts` matrix, `admissibility-gate.ts` routing) is UNCHANGED.

### 4.c How the loop / admissibility-gate consumes each variant (post-collapse)

The collapse produces a normal `ApprovalDecision` (+ optionally sets `verb`/`updatedInput`/forces an `ask`), so the gate's existing routing handles it with **no new branches in the allow/deny logic** — only the new seams it already has:

- **`allow` / `allow_for_session`** → `guardian_approved` / `…_for_session` → `isAllowed` true → existing approve path (`admissibility-gate.ts:610`).
- **`allow_with_edit`** → collapse threads `updatedInput` through the EXISTING `onInputMutation` sink (`admissibility-gate.ts:148, 664-666`) — the same Cursor-parity plumbing a `pre_tool_use` hook already uses — and the action runs with the edited input. If that sink is absent/OFF → collapse degrades to `deny_and_steer` (the edit becomes a steering suggestion; original does NOT run). **No new plumbing if the updatedInput path is reused** (Open Question §9.2).
- **`ask`** → forced `onConfirm` HITL (`admissibility-gate.ts:857-882`), the canonical `ask → onConfirm` handshake.
- **`deny`** → `guardian_denied` + `denyReason({layer:"reviewer", pillar, safeReason})` — reuse `structuredDenyReason()` (`deny-reason.ts:152`); `safeReason` stays categorical (the C6 no-leak boundary, `deny-reason.ts:20-31`).
- **`deny_and_steer`** → `guardian_denied` + `verb:{verb:"reject_and_tell", message: steer}` → existing `steerInjection` (`admissibility-gate.ts:457-470`).
- **`escalate`** → either a forced `ask` (HITL — conservative default) OR, if a sandbox-escalation seam is wired, a capability-grant request. Default collapse = `ask` (never auto-grant).

**Default-OFF byte-identity:** with the knob OFF, `guardianAssess` is never called, the collapse function is never reached, and `guardianReview` returns the exact current binary `ApprovalDecision`. The gate, matrix, and truth tables run the identical code path they run today. This is a ratchet assertion (§7).

### 4.d Reuse, don't reinvent

- `StructuredDenyReason` / `structuredDenyReason()` / `DenyLayer:"reviewer"` / `DenyPillar` (`deny-reason.ts:63-70, 93, 152`) for `deny`/`deny_and_steer`/`escalate` refusals — categorical `safeReason` only.
- `onConfirm`/HITL handshake (`admissibility-gate.ts:857-882`) for `ask` + `escalate`.
- `updatedInput` / `onInputMutation` (`admissibility-gate.ts:148, 664-666`) for `allow_with_edit`.
- `reject_and_tell` → `steerInjection` (`review-kind.ts:160-166`, `admissibility-gate.ts:457-470`) for `deny_and_steer`.
- The action-CLASS axis (§3.1) maps onto the existing `ReviewKind` (`review-kind.ts:45-52`) — no new taxonomy; the assessor just gets `ctx.reviewKind`.

---

## 5. Risk (honest)

**A richer type is more surface to get wrong, and collapse-correctness is the load-bearing invariant.** A typed assessor that mis-collapses could silently weaken a deny — the single worst failure mode here.

- **The variant→outcome mapping must be TOTAL and CONSERVATIVE.** `collapseAssessment` is an exhaustive switch with a `never` default (compile-time totality, parity with `outcome.ts:67-72`). But compile-time totality is not enough: an **unknown/future variant** reaching the collapse at runtime (e.g. a malformed assessor reply that parses to a kind we didn't expect, or a version skew) MUST fall to the **most-restrictive** outcome — `guardian_denied` (fail-closed), exactly like `fallbackDecision()` does today (`reviewer-subagent.ts:54-65`). Never `allow`.
- **`allow_with_edit` is the trap.** Collapsing it wrong could run the ORIGINAL (un-edited) input under an "allow" — silently executing the thing the guardian wanted modified. Rule: `allow_with_edit` collapses to **`guardian_denied` + steer** UNLESS the `updatedInput` actually reaches the executor via `onInputMutation` AND is the input run. If there is ANY doubt the edit took effect, it is a deny. "Allow-with-edit" never degrades to "allow-original."
- **`allow_for_session` widens authority.** Sticky session-allow from a *machine* assessor is a strictly bigger grant than one-shot. Default collapse = one-shot `guardian_approved`; the sticky form is a separate, stricter opt-in (Open Question §9.1). A machine assessor must not silently make session-wide grants.
- **`escalate` must never auto-grant.** Default collapse = forced `ask` (HITL). A sandbox/policy auto-grant is opt-in and itself gated; absent that, escalate = ask-the-human.
- **The matrix (`outcome.ts:128-142`) still governs.** The collapse output is fed through `buildDecision`, so any (reviewer, outcome) the collapse produces that violates the `ADMISSIBLE` matrix THROWS `OutcomeInvariantError` — the existing invariant catches a mis-collapse rather than letting it through. This is a feature: the matrix is the second line of defense behind the collapse switch.
- **More LLM surface to get the assessor's own output wrong.** The guardian subagent's reply schema grows from 2 outcomes to ~7 kinds; a fuzzier schema = more malformed replies = more fail-closed denies (acceptable — fail-closed is the safe direction, but it can degrade UX if the assessor prompt is sloppy). Calibration, not correctness, is the cost here.

Net: the typed assessor adds expressive power on the SAFE side only. Every ambiguity, parse failure, unknown variant, or unwired seam resolves to **at least `ask`, and by default `deny`** — never a silent allow.

---

## 6. Files to touch

- `src/permission/types.ts` — add the `ActionAssessment` discriminated union + `ALL_ASSESSMENT_KINDS` tuple; add the OPTIONAL `guardianAssess?` method to `ReviewerPort` (or a new `AssessorPort` — §4.b). Pure types; no behavior change.
- `src/permission/outcome.ts` (or a new `assessment-collapse.ts` sibling) — `collapseAssessment(a): ApprovalDecision`, the single conservative-total mapping; routes through `buildDecision` so the matrix still gates it. Unknown/future kind ⇒ `guardian_denied` fail-closed.
- `src/permission/reviewer.ts` — `reviewAction` (`:216-233`): when guardian tier + assessor present + knob ON, call `guardianAssess` → `collapseAssessment`; else verbatim existing dispatch. One knob-gated branch.
- `src/agent/tier1/reviewer-subagent.ts` — a richer assessor reply schema (`:16-23`) behind the knob: extend `guardianReplySchema` to the ~7-kind variant set; `decodeGuardianDecision`/`fallbackDecision` (`:54-93`) emit `ActionAssessment` (fallback ⇒ `deny`). The OFF path keeps the exact 2-value schema. A new `createSubagentBackedGuardianAssess` adapter sibling to `createSubagentBackedGuardianReview` (`:126-157`).
- `src/agent/reviewer-port.ts` — optional `guardianAssess` wiring on `createOnConfirmReviewerPort`/composition; the `unavailable()` stub gains an assessor sibling (fail-closed `deny`).
- `src/agent/admissibility-gate.ts` — **NO new allow/deny branches**; only confirm the post-collapse `updatedInput`/`onConfirm`/`reject_and_tell` seams already in place (`:148, 457-470, 664-666, 857-882`) carry the collapsed variants. (If `allow_with_edit` needs new plumbing → Open Question §9.2.)
- `src/permission/deny-reason.ts` — no type change; `layer:"reviewer"` + `pillar:"approval"` already cover the new deny sites. Optionally an `escalate` categorical tag (additive only).
- Knob in `src/shared/runtime-config.ts` — `QUANTA_GUARDIAN_ASSESS` (default-OFF) + the surface/SSOT manifest entry (`src/tool/surface/manifest.ts`).
- `fc` catalog (`tools/feature-catalog/`, baseline `baseline.json`) — register the feature.
- Composition: `src/agent/optional-ports.ts`, `src/agent/index.ts`, `src/apps/cli/repl/reviewer-policy.ts:47-53` — select the assessor variant when the knob is on.

---

## 7. Test / hellgate plan

- **Per-variant routing:** each `ActionAssessment.kind` collapses to the correct gate outcome — `allow`→approve, `allow_for_session`→sticky-or-one-shot (per §9.1 decision), `allow_with_edit`→edited-input-runs (and original does NOT), `ask`→`onConfirm` HITL, `deny`→`guardian_denied`+`StructuredDenyReason`, `deny_and_steer`→`guardian_denied`+`steerInjection`, `escalate`→forced `ask` (default). Assert against the existing gate decision shapes.
- **OFF ⇒ byte-identical (ratchet):** knob OFF ⇒ `guardianAssess` never called, `collapseAssessment` never reached; `reviewer-subagent.ts` emits the exact 2-value `guardian_approved|guardian_denied` schema and `reviewAction`/gate produce the identical `ApprovalDecision` they do today. Snapshot/ratchet the OFF assembled verdict.
- **Collapse is conservative (the security claim):** property test — for EVERY assessment variant, the collapsed outcome is allow ONLY for `allow`/`allow_for_session` and (conditionally) `allow_with_edit`-when-edit-applied. Any non-allow variant ⇒ at least `ask`, never a silent allow. `allow_with_edit` with the `updatedInput` seam OFF ⇒ collapses to `deny`/`deny_and_steer`, original input NOT executed (red-on-injection).
- **Unknown/future variant ⇒ most-restrictive fallback (red-on-injection):** feed the collapse (and the subagent decoder) a malformed/unexpected kind ⇒ `guardian_denied` (fail-closed), never approve. Mirror `fallbackDecision` semantics. Hellgate this — it's the load-bearing safety property.
- **Matrix second-line:** a deliberately mis-collapsed (reviewer, outcome) pair ⇒ `buildDecision` throws `OutcomeInvariantError` (the matrix catches it). Assert the throw.
- **No-leak boundary:** `deny`/`escalate` `safeReason` stays categorical (never the action input / command / matched rule), parity with C6 (`deny-reason.ts:20-31`).
- **`allow_for_session` authority guard:** a machine assessor's `allow_for_session` does NOT produce a session-wide grant unless the sticky-opt-in knob is also on (default ⇒ one-shot).

---

## 8. ROI / cost

- **Cost: 중.** The types + collapse function are cheap and pure (one exhaustive switch + a totality test). The spend is (a) the guardian subagent's richer reply schema + prompt (more variants = more careful prompt + more fail-closed handling) and (b) wiring `allow_with_edit` through the `updatedInput` path correctly (the one place real plumbing might be needed). Most LOC is types and tests, not logic.
- **Impact: 중-고.** Turns the guardian from a **veto** into a **steering wheel**. `allow_with_edit` lets the guardian correct an action instead of bouncing it (fewer wasted turns, less human ping-pong); `deny_with_actionable_reason` gives the model a machine-classifiable refusal to branch on (kills the retry-thrash failure C6 targets); `ask` gives an uncertain guardian a first-class escalation instead of a coin-flip; `escalate` opens the capability-grant lane Codex has. These materially improve autonomy QUALITY, not just safety. P3 is 보안-고 in `jun-07-gap-other-agent-audit`.

---

## 9. Open questions (calibrate — no magic)

1. **Variant set to adopt now vs later.** §4.a proposes 7 kinds. Do we ship the full set, or start with the 4 highest-value (`allow`, `ask`, `deny_and_steer`, `allow_with_edit`) and defer `allow_for_session` + `escalate`? `allow_for_session` widens authority (machine sticky-allow — §5) and `escalate`'s capability-grant lane needs a sandbox-amendment seam quanta may not have wired. **Recommendation: ship `allow`/`ask`/`deny`/`deny_and_steer`/`allow_with_edit`; defer `allow_for_session` (sticky) and `escalate`-as-grant behind their own gates.** Do not invent variants beyond the verified Codex set (§3.2).
2. **`allow_with_edit` plumbing — reuse `updatedInput` or new?** The gate already has `onInputMutation(updatedInput)` (`admissibility-gate.ts:148, 664-666`) used by `pre_tool_use` hooks. Can the collapse thread a guardian's edit through that exact sink, or does the reviewer path bypass the hook stage (so the edit never reaches the executor)? **Needs a trace of the gate ordering: does the reviewer verdict come before or after the `updatedInput` sink fires?** If after, `allow_with_edit` needs a new (small) plumbing hop; if before, it's free. Verify before scoping (this is the one place "no new plumbing" might be false).
3. **Per-action assessor cost — extra LLM pass + budget.** The guardian assessor (like today's `guardianReview`) runs a subagent (`reviewer-subagent.ts:99-122`, `REVIEWER_MAX_TURNS = 4`). A richer assessment does NOT add a pass — it's the SAME guardian call with a richer reply schema — so no extra LLM round-trip vs today's binary guardian. BUT: does the richer schema raise the guardian's own turn count / token use (more reasoning to pick among 7 kinds)? And is the assessor gated to the same on-request+workspace-write trigger (`reviewer-policy.ts:47-53`) so it doesn't fire on every action? **Confirm the assessor inherits the existing guardian trigger + budget; do NOT introduce a new per-action LLM pass.** Measure token delta on real transcripts before widening the prompt (per `no-heuristics-only-validated`).
4. **Action-CLASS axis (§3.1) — adopt or skip?** Codex structures the action into 6 typed classes (`Execve`/`Command`/`ApplyPatch`/`McpToolCall`/`NetworkAccess`/`RequestPermissions`) BEFORE assessing. quanta's `ReviewKind` (`review-kind.ts:45-52`) is the near-equivalent and already on `ctx.reviewKind`. Do we need a separate assessment-action taxonomy, or does threading `reviewKind` into the assessor prompt suffice? **Recommendation: reuse `ReviewKind`; do not add a parallel 6-class enum unless a per-class field set (e.g. McpToolCall's `connector_id`/`tool_title`) proves load-bearing for the assessor's decision.**
5. **`GuardianDeniedAction` override.** Codex lets the operator re-approve a denied guardian action post-hoc (`ThreadApproveGuardianDeniedActionParams`, `:4414`). Is the override path in scope, or is it a separate follow-up (it needs a deny-memory mutation surface, tie-in with `DenialMemory` `types.ts:137-143`)? Likely follow-up — confirm before scoping.
