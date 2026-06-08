import type { HITLTier } from "@/shared"
import type { ClassifierPort } from "./classifier"
import type { StructuredDenyReason } from "./deny-reason"
import type { ReviewDecision, ReviewKind } from "./review-kind"

export type PermissionDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "ask"; reason: string }

export interface ToolAction {
  tool: string
  input: unknown
  isReadOnly: boolean
  /** S16: shell-equivalent command string when the tool's input represents
   *  one. Populated by the dispatch seam from the tool's
   *  `extractShellCommand` method. Permission policy applies HARD_DENY rules
   *  whenever this is a non-null string, REGARDLESS of `tool` name — so
   *  bash, future `shell`/`exec`/MCP `run`, etc. all share one gate.
   *
   *  `null` ⇒ the tool does not represent a shell command (no gate applied);
   *  the legacy `tool === "bash"` fallback is intentionally removed so a new
   *  shell-equivalent tool that forgets to wire `extractShellCommand` simply
   *  fails the gate-coverage unit test (in tests/unit) rather than silently
   *  bypassing the denylist. */
  shellCommand?: string | null
  /** ADR-0512 — present ONLY when this confirm is a skill-scope ESCALATION (the
   *  tool is outside the active skill's `allowed-tools`), not a normal action
   *  confirm. A surface renders a distinct "outside skill scope" card from it
   *  (the active skill + why the tool is out of scope); a surface that ignores
   *  it sees a plain confirm. Absent ⇒ byte-identical for every pre-ADR-0512
   *  caller (the field is never set on the legacy always-confirm path). */
  scopeContext?: { activeSkill: string; reason: string }
}

/**
 * Codex HITL 4-tier taxonomy (hitl-audit.md). Re-exported from the canonical
 * `@/shared` declaration so the literal union can never drift between slices.
 * `@/tool` and `@/agent` re-export the SAME type from `@/shared`; biome's
 * import-direction rule permits this because `@/shared` is the leaf layer.
 * See {@link import("@/shared").HITLTier} for the full tier semantics.
 */
export type { HITLTier }

/** `auto` = use an injected model classifier (AutoModeClassifier) to decide
 *  allow/deny in place of an interactive prompt (AFK / long-running tasks).
 *  Absent `classify` port ⇒ "auto" degrades safely to "ask". */
export type PermissionMode = "default" | "acceptEdits" | "bypass" | "auto"

export interface PermissionContext {
  mode: PermissionMode
  /** Optional injected intelligence port for "auto" mode. The permission
   *  slice never imports @/llm or @/agent — the real impl is wired by the
   *  main thread. When absent, "auto" mode degrades to "ask". */
  classify?: ClassifierPort
}

/* ------------------------------------------------------------------------- *
 * ADR-0029 — Codex 3-tier reviewer enum + 8-state approval outcome.
 *
 * `ReviewerTier` is ORTHOGONAL to `HITLTier` (ADR-0020): HITLTier classifies
 * the action's intrinsic risk shape ("always-confirm vs pre-approval-ok ..."),
 * whereas `ReviewerTier` selects WHO renders the decision when a confirmation
 * is required. Both axes coexist; the reviewer module never mutates HITLTier
 * semantics and is opt-in (absent ReviewerPort ⇒ legacy callback path is
 * byte-identical, see ADR-0029 §Migration).
 *
 * Naming follows Codex Desktop build 2867 (`codex-desktop-build-2867-round-2`
 * R3-3): the discriminants are LITERAL strings shared with Codex telemetry so
 * trajectory exports can interoperate without translation. Adding or renaming
 * a discriminant requires an ADR amendment.
 * ------------------------------------------------------------------------- */

/** Who is authorized to render the approval decision for an action.
 *
 *  - `user`              — explicit interactive prompt; only a human can
 *                          unblock. Used when an action is intrinsically
 *                          irreversible/high-blast-radius and the operator
 *                          must consciously assume the risk.
 *  - `auto_review`       — deterministic in-process check (classifier +
 *                          policy); designed to clear low-risk actions
 *                          without operator interruption.
 *  - `guardian_subagent` — heavier secondary review by a dedicated subagent
 *                          (MCP elicitation / second-opinion model). The
 *                          guardian's decision has sticky precedence
 *                          (see DenialMemory) for the remainder of the
 *                          session on the same actionKey. */
export type ReviewerTier = "user" | "auto_review" | "guardian_subagent"

/** Closed terminal-state set for an approval decision. Eight discriminants
 *  cover every path the decision can take; any pair (`reviewer`, `outcome`)
 *  must satisfy the invariants enforced by `buildDecision` in
 *  `src/permission/outcome.ts`.
 *
 *   - `not_needed`                 — risk so low no review was required
 *                                    (read-only or HITL "none"); reviewer
 *                                    may be any tier (typically auto_review).
 *   - `config_allowed`             — auto_review cleared via policy/config.
 *   - `guardian_approved`          — guardian subagent approved.
 *   - `guardian_denied`            — guardian subagent denied; sticky.
 *   - `user_approved`              — user approved THIS action only.
 *   - `user_approved_for_session`  — user approved THIS action + future
 *                                    structurally-equivalent invocations
 *                                    (same actionKey) for the session.
 *   - `user_denied`                — user denied THIS action.
 *   - `user_aborted`               — user aborted the entire turn (Ctrl-C /
 *                                    cancel button); stronger than `denied`
 *                                    and short-circuits subsequent reviews
 *                                    in the same turn. */
export type ApprovalOutcome =
  | "not_needed"
  | "config_allowed"
  | "guardian_approved"
  | "guardian_denied"
  | "user_approved"
  | "user_approved_for_session"
  | "user_denied"
  | "user_aborted"

/** Discriminated record produced by `reviewAction` / `buildDecision`. The
 *  shape is value-only (no functions, no live refs) so it is safe to log,
 *  serialize for trajectory replay, and compare structurally. */
export interface ApprovalDecision {
  readonly reviewer: ReviewerTier
  readonly outcome: ApprovalOutcome
  readonly riskLevel: "low" | "medium" | "high"
  readonly rationale: string
  /** Caller-provided ms-since-epoch. Pure logic never reads the wall clock;
   *  tests and trajectory replay supply a deterministic value. */
  readonly decidedAt: number
  /** ADR-0070 review-kind matrix (L3→L4) — OPTIONAL richer decision verb the
   *  reviewer port may attach. When set, the gate validates the verb against
   *  the `ReviewContext.reviewKind` via `isDecisionLegalFor` and routes the
   *  `reject_and_tell.message` into the steering seam (becomes
   *  `DispatchResult.steerInjection`). Absent ⇒ legacy `outcome`-only path
   *  (byte-identical for every existing ReviewerPort impl). */
  readonly verb?: ReviewDecision
}

/** Sticky post-denial precedence record — once an actionKey has been denied
 *  by `guardian_subagent` (or aborted by the `user`), the decision is binding
 *  for the rest of the session and short-circuits future reviews. Stored by
 *  the caller (admissibility gate, in a future PR) and passed back into
 *  `reviewAction` via `ReviewContext.priorDenials`. */
export interface DenialMemory {
  readonly sessionId: string
  readonly actionKey: string
  readonly reviewer: ReviewerTier
  readonly outcome: ApprovalOutcome
  readonly deniedAt: number
}

/** Stable composite key the reviewer uses to compare two actions for
 *  "structural equivalence" (session-wide approval / sticky denial). The
 *  caller is responsible for choosing a representation that strips
 *  uninteresting variability (e.g. timestamps in arguments) — the reviewer
 *  treats `actionKey` as an opaque string. */
export interface ToolActionKeyed {
  readonly tool: string
  readonly input: unknown
  readonly isReadOnly: boolean
  readonly actionKey: string
}

/* ------------------------------------------------------------------------- *
 * jun-7-misc 03 — Guardian per-action TYPED assessment (ADR-0497).
 *
 * Codex 0.135's guardian is a per-action ASSESSOR that emits a typed decision
 * (`approved_exec` / `proposed_exec` / `network_policy_amendment` / `denied` /
 * `abort` / `timed_out`), not a bool. quanta's guardian is binary today
 * (`guardian_approved | guardian_denied`). `ActionAssessment` is the OPT-IN
 * richer output that COLLAPSES to the existing 8-state `ApprovalOutcome` before
 * any current consumer sees it (`collapseAssessment` in `assessment-collapse.ts`
 * is the single boundary). The collapse is a STRICT SUPERSET: every variant maps
 * onto an existing `ApprovalOutcome` + existing gate seam, so OFF/legacy
 * consumers observe an unchanged `ApprovalDecision`.
 *
 * SAFETY (the load-bearing invariant): the collapse is TOTAL and CONSERVATIVE.
 * Only `allow` / `allow_for_session` collapse to an allow; every other variant —
 * AND any unknown/future/parse-failure kind — collapses to AT LEAST `ask`, and
 * by default `guardian_denied` (fail-closed). `allow_with_edit` NEVER degrades
 * to "allow-original": absent the input-mutation seam it collapses to a steered
 * DENY (the original input is never executed). See `assessment-collapse.ts`.
 * ------------------------------------------------------------------------- */

/** A guardian's sandbox/permission escalation request (the Codex
 *  `*_policy_amendment` lane). VALUE-ONLY and CATEGORICAL — it names the axis
 *  the guardian wants widened, NEVER the raw action/command. The default
 *  collapse of an `escalate` is a forced `ask` (HITL); a sandbox auto-grant is a
 *  separately-gated opt-in (deferred — see ticket §9). */
export type AssessmentEscalation =
  | { readonly axis: "sandbox" }
  | { readonly axis: "network" }
  | { readonly axis: "permission" }

/** The typed per-action assessment a richer guardian assessor emits. A
 *  discriminated union on `kind`, value-only (loggable/serializable, parity with
 *  {@link ApprovalDecision}). Every variant has an existing quanta home; the
 *  variant set is the verified Codex 0.135 subset (ticket §3.2) — do NOT invent
 *  variants beyond it.
 *
 *  Collapse targets (see `collapseAssessment`):
 *   - `allow`            ⇒ `guardian_approved`              (one-shot allow)
 *   - `allow_for_session`⇒ `guardian_approved`              (conservative one-shot;
 *                          sticky session-allow is a stricter separate opt-in —
 *                          a MACHINE assessor never silently widens to session)
 *   - `allow_with_edit`  ⇒ `guardian_denied` + steer        (counter-proposal;
 *                          ORIGINAL never runs — never an allow-original)
 *   - `ask`              ⇒ forced HITL (escalate to user reviewer)
 *   - `deny`             ⇒ `guardian_denied` + StructuredDenyReason
 *   - `deny_and_steer`   ⇒ `guardian_denied` + reject_and_tell steer
 *   - `escalate`         ⇒ forced HITL (ask-the-human; never auto-grant) */
export type ActionAssessment =
  | {
      readonly kind: "allow"
      readonly rationale: string
      readonly riskLevel: ApprovalDecision["riskLevel"]
    }
  | { readonly kind: "allow_for_session"; readonly rationale: string }
  | {
      readonly kind: "allow_with_edit"
      readonly rationale: string
      /** The guardian's corrected tool input — a counter-proposal. Carried for
       *  audit/telemetry, BUT the conservative collapse does NOT execute it: it
       *  becomes the steer message of a DENY. The original input never runs. */
      readonly updatedInput: unknown
      /** Concise human-readable description of the correction, fed back to the
       *  model as steering when the edit collapses to a steered deny. */
      readonly steer: string
    }
  | { readonly kind: "ask"; readonly rationale: string }
  | { readonly kind: "deny"; readonly rationale: string; readonly denyReason: StructuredDenyReason }
  | {
      readonly kind: "deny_and_steer"
      readonly rationale: string
      readonly denyReason: StructuredDenyReason
      readonly steer: string
    }
  | {
      readonly kind: "escalate"
      readonly rationale: string
      readonly escalation: AssessmentEscalation
    }

/** Discriminant literal of {@link ActionAssessment}. */
export type AssessmentKind = ActionAssessment["kind"]

/** All assessment kinds enumerated as a runtime tuple — exhaustive-coverage
 *  helper for tests/mapping (parity with `ALL_OUTCOMES` / `ALL_REVIEW_KINDS`).
 *  Declared here next to the union so the two can never drift.
 *
 *  EXHAUSTIVENESS GUARD (R1 hardening): the `as const satisfies` clause pins the
 *  element TYPES, but `satisfies ReadonlyArray<AssessmentKind>` alone does NOT
 *  catch a MISSING member — a new union kind that is never listed here would
 *  silently slip past the conservative-property test (which iterates THIS tuple).
 *  The `AssertNoMissingKind` type below closes that: if a kind is added to
 *  {@link ActionAssessment} but not to this tuple, `_assessmentKindsExhaustive`
 *  fails to TYPECHECK (the uncovered kind is reported as not assignable to
 *  `never`). This is the SECURITY-relevant guard — a silently-untested new
 *  allow-ish variant is exactly the drift this prevents. */
export const ALL_ASSESSMENT_KINDS = [
  "allow",
  "allow_for_session",
  "allow_with_edit",
  "ask",
  "deny",
  "deny_and_steer",
  "escalate",
] as const satisfies ReadonlyArray<AssessmentKind>

/** Compile-time exhaustiveness: any {@link AssessmentKind} NOT present in
 *  {@link ALL_ASSESSMENT_KINDS} surfaces here as a type error (it resolves to a
 *  non-`never` type, which is not assignable to `never`). Pure type machinery —
 *  zero runtime cost, erased at build. */
type MissingAssessmentKind = Exclude<AssessmentKind, (typeof ALL_ASSESSMENT_KINDS)[number]>
const _assessmentKindsExhaustive: MissingAssessmentKind extends never ? true : never = true
void _assessmentKindsExhaustive

/** Injected reviewer port — one method per `ReviewerTier`. The reviewer
 *  module owns dispatch and invariant enforcement; the port owns the actual
 *  IO (prompt UX, classifier call, subagent fan-out). Real implementations
 *  live in `@/agent` (future PR per ADR-0029 §Integration seam). */
export interface ReviewerPort {
  autoReview(action: ToolActionKeyed, ctx: ReviewContext): Promise<ApprovalDecision>
  guardianReview(action: ToolActionKeyed, ctx: ReviewContext): Promise<ApprovalDecision>
  userReview(action: ToolActionKeyed, ctx: ReviewContext): Promise<ApprovalDecision>
  /** jun-7-misc 03 (ADR-0497) — OPTIONAL richer per-action assessor for the
   *  guardian tier. ADDITIVE: absent on every current impl, so the OFF path is
   *  byte-identical. When present AND the `QUANTA_GUARDIAN_ASSESSOR` knob is on,
   *  `reviewAction` calls this instead of `guardianReview`, then
   *  `collapseAssessment` reduces the typed assessment to the standard
   *  `ApprovalDecision` BEFORE any downstream consumer. The collapse is the
   *  single boundary; everything past it is unchanged. Fail-closed: any reject /
   *  parse failure inside the impl MUST yield `{kind:"deny", …}`. */
  guardianAssess?(action: ToolActionKeyed, ctx: ReviewContext): Promise<ActionAssessment>
}

/** Per-action review context. Pure data — no callbacks. */
export interface ReviewContext {
  readonly sessionId: string
  readonly turnId: string
  /** Sticky precedence inputs (`guardian_denied` / `user_aborted` short-
   *  circuit any further review for the same `actionKey`). */
  readonly priorDenials: ReadonlyArray<DenialMemory>
  /** Policy-default reviewer. Codex `workspace-write` / `on-request` profile
   *  defaults to `guardian_subagent`; everything else defaults to
   *  `auto_review` unless escalation is requested. */
  readonly configReviewer: ReviewerTier
  /** Caller-provided clock for deterministic decisions. */
  readonly decidedAt: number
  /** ADR-0070 review-kind matrix (L3→L4) — OPTIONAL "what is being reviewed"
   *  axis. When set, the port may render the prompt with a kind-typed UI
   *  (`edit` vs `terminal` vs `web_fetch` …) AND attach a richer
   *  {@link ApprovalDecision.verb} the gate validates against this kind via
   *  `isDecisionLegalFor`. The gate computes this via {@link inferReviewKind}
   *  before invoking the port. Absent ⇒ port renders the legacy generic
   *  confirm prompt (byte-identical). */
  readonly reviewKind?: ReviewKind
}
