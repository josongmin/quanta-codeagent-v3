import type { HITLTier } from "@/shared"
import type { ClassifierPort } from "./classifier"
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

/** Injected reviewer port — one method per `ReviewerTier`. The reviewer
 *  module owns dispatch and invariant enforcement; the port owns the actual
 *  IO (prompt UX, classifier call, subagent fan-out). Real implementations
 *  live in `@/agent` (future PR per ADR-0029 §Integration seam). */
export interface ReviewerPort {
  autoReview(action: ToolActionKeyed, ctx: ReviewContext): Promise<ApprovalDecision>
  guardianReview(action: ToolActionKeyed, ctx: ReviewContext): Promise<ApprovalDecision>
  userReview(action: ToolActionKeyed, ctx: ReviewContext): Promise<ApprovalDecision>
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
