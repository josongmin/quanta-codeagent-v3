/**
 * Permission-slice telemetry recorder (default-OFF emitter seam for the
 * declared `quanta.permission.*` OTel vocabulary).
 *
 * Why this module exists
 * ----------------------
 * `src/observability/vocabulary.ts` declared 12 `quanta.permission.*`
 * attribute keys (ADR-0029 trio + ADR-0046 stack-axis + ADR-0046 post-denial
 * + decidedBy) but every decision site in this slice returned a verdict
 * without ever emitting an attribute or counter. The vocabulary was dead.
 *
 * This file activates the vocabulary via a thin {@link PermissionRecorder}
 * port (two methods, one per emit shape) plus a module-level setter
 * ({@link setPermissionRecorder}) that mirrors `SpanSink`. The recorder's
 * input shape is **slice-local** — every field is a categorical / hashed
 * primitive declared in this file — so the permission slice retains its
 * RFC 3.1 isolation (no `@/observability` import here). A cross-slice wiring
 * adapter (built by `@/agent` or a host-layer composition root) translates
 * each callback into the canonical `permissionAttrs(...)` / `postDenialAttrs`
 * bag and routes it to the actual OTel sink.
 *
 * Default-OFF guarantee
 * ---------------------
 *   - No registered recorder ⇒ every helper is a zero-allocation no-op.
 *     The slice's hot path stays byte-identical to its pre-emit form.
 *   - Exceptions thrown FROM the recorder are caught + swallowed here.
 *     Observability bugs MUST NOT abort a permission decision — a thrown
 *     emitter cannot deny an otherwise-allowable action, nor allow an
 *     otherwise-denied one.
 *
 * Security invariants
 * -------------------
 *   - The {@link PermissionDecisionRecord} carries **only** categorical /
 *     pre-hashed primitives:
 *       · `outcome`        — closed {@link PermissionOutcomeLabel} union.
 *       · `reviewerTier`   — enum string.
 *       · `riskLevel`      — `"low" | "medium" | "high"`.
 *       · `stackSource`    — pre-categorized axis name (NEVER a regex source).
 *       · `stackVerdict`   — the verdict literal.
 *       · `actionSignature` — 32-hex hash from `computeActionSignature()`.
 *       · `threadId` / `hostId` — opaque IDs (NOT raw command text).
 *       · `decidedBy`      — coarse decision-layer label.
 *   - **No** field carries raw `action.input`, `shellCommand`, `rationale`,
 *     or any matched HARD_DENY rule source. A field-by-field audit at every
 *     emit site is the structural enforcement.
 *
 * Slice rules: this module imports NOTHING beyond TypeScript built-ins.
 * Slice isolation (biome's noRestrictedImports) is preserved.
 *
 * Related: ADR-0029 (reviewer 3-tier), ADR-0032 (vocabulary), ADR-0046
 * (permission stack + post-denial).
 */

// ---------------------------------------------------------------------------
// Public types — entirely slice-local. The cross-slice adapter MAPS these
// to canonical `quanta.permission.*` attribute keys in @/observability.
// ---------------------------------------------------------------------------

/**
 * Closed set of decision counter labels.
 *
 *   - `"allow"`  — gate cleared without operator intervention.
 *   - `"deny"`   — gate refused (HARD_DENY / policy / abort / guardian_denied).
 *   - `"prompt"` — `kind === "ask"` surfaces to the operator (UI rendering).
 *   - `"trust"`  — explicit operator override (post-denial-override OR a
 *                  user_approved / user_approved_for_session reviewer outcome).
 *                  Distinct from `"allow"` so dashboards can surface override
 *                  usage without inflating the allow counter.
 *
 * Adding a label requires an ADR amendment + a new counter row downstream. */
export type PermissionOutcomeLabel = "allow" | "deny" | "prompt" | "trust"

/** Post-denial state-transition kind — the operator-funnel events from
 *  ADR-0046's denied → risk-seen → user-override sequence. */
export type PostDenialEventKind = "denied" | "risk-seen" | "user-override"

/** Risk classification surfaced to the recorder. Mirrors the canonical
 *  `gen_ai.*`-free 3-tier scale; kept here as a slice-local literal so
 *  the permission module owns its own vocabulary. */
export type PermissionRiskLevel = "low" | "medium" | "high"

/** Pre-categorized stack axis that produced the verdict (ADR-0046). The
 *  enum values are byte-identical to the canonical
 *  `quanta.permission.stack.source` literal set; the adapter passes them
 *  through unchanged. */
export type PermissionStackSource =
  | "hard-deny"
  | "read-only-bypass"
  | "post-denial-override"
  | "per-thread"
  | "per-host"
  | "global-default"

/** Deny-capable subset of {@link PermissionStackSource}. Allow-only axes are
 *  excluded so a typed deny can never claim an impossible source. */
export const PERMISSION_DENY_SOURCES = [
  "hard-deny",
  "per-thread",
  "per-host",
  "global-default",
] as const satisfies ReadonlyArray<PermissionStackSource>

export type PermissionDenySource = (typeof PERMISSION_DENY_SOURCES)[number]

/** Coarse decision-layer label — which subsystem owned the final verdict.
 *  Matches the canonical `quanta.permission.decided_by` enum. */
export type PermissionDecidedBy = "reviewer" | "stack" | "hitl" | "hook"

/** The full decision record handed to {@link PermissionRecorder.onDecision}.
 *
 *  Audit it field-by-field at each emit site: every value MUST be a
 *  categorical primitive or a pre-hashed identifier — NEVER raw args /
 *  command text / regex sources. */
export interface PermissionDecisionRecord {
  /** The 4-state counter label. */
  readonly outcome: PermissionOutcomeLabel
  /** Which reviewer tier produced the decision (`"auto_review"` for the
   *  synchronous policy path; one of the {@link ReviewerTier} literals for
   *  the reviewer-tier path). */
  readonly reviewerTier: string
  /** Coarse risk tier; HARD_DENY ⇒ "high", ask ⇒ "medium", allow ⇒ "low". */
  readonly riskLevel: PermissionRiskLevel
  /** Decision-layer label. */
  readonly decidedBy: PermissionDecidedBy
  /** Verdict literal (mirrors `PermissionDecision.kind` for the stack path;
   *  omitted for reviewer-path emits where `outcome` carries the truth). */
  readonly stackVerdict?: "allow" | "deny" | "ask"
  /** Which stack axis fired (when known). Reviewer-path emits omit this. */
  readonly stackSource?: PermissionStackSource
  /** 32-hex actionSignature from `computeActionSignature`. */
  readonly actionSignature?: string
  /** Permission-slice thread anchor (sessionId at gate time). */
  readonly threadId?: string
  /** Host id from `resolveHostId()`. */
  readonly hostId?: string
}

/** The post-denial-event record handed to
 *  {@link PermissionRecorder.onPostDenialEvent}. The hashed `actionSignature`
 *  is the only per-action identifier. */
export interface PostDenialEventRecord {
  readonly event: PostDenialEventKind
  readonly actionSignature: string
  readonly threadId: string
  readonly decidedBy: PermissionDecidedBy
}

/** Implement this to receive permission-slice telemetry. Constructed by the
 *  host (CLI / web surface / test harness) and wired in via
 *  {@link setPermissionRecorder}. Absent ⇒ all decision-site emits are
 *  no-ops (default). */
export interface PermissionRecorder {
  /** Record one permission-decision outcome. */
  onDecision: (record: PermissionDecisionRecord) => void
  /** Record one post-denial state transition. */
  onPostDenialEvent: (record: PostDenialEventRecord) => void
}

// ---------------------------------------------------------------------------
// Module-level mutable sink (setter-only export; readers go through helpers)
// ---------------------------------------------------------------------------

let activeRecorder: PermissionRecorder | null = null

/** Register a {@link PermissionRecorder}. Pass `null` to clear. Tests + hosts
 *  use this; the slice's own decision sites only ever read via the helpers
 *  below.
 *
 *  Intentionally NOT a stack — only one recorder active at a time. A multi-
 *  fanout host wraps two recorders into one composite at registration. */
export const setPermissionRecorder = (recorder: PermissionRecorder | null): void => {
  activeRecorder = recorder
}

/** Read-only accessor for the active recorder. Exposed for diagnostics +
 *  tests; feature code MUST NOT branch on this directly — call one of the
 *  `emit*` helpers below and let it no-op. */
export const getPermissionRecorder = (): PermissionRecorder | null => activeRecorder

/** Test-only: forcibly clear the registered recorder. Production code MUST
 *  NOT call this — use {@link setPermissionRecorder}(null) instead, which is
 *  identical but reads as an intentional clear rather than a reset. */
export const __resetPermissionRecorder = (): void => {
  activeRecorder = null
}

// ---------------------------------------------------------------------------
// Emit helpers — the only API the decision sites should touch
// ---------------------------------------------------------------------------

/** Emit one permission-decision outcome. No-op when no recorder is
 *  registered. Exceptions thrown by the recorder are caught and swallowed:
 *  an observability bug MUST NOT corrupt a permission verdict. */
export const emitPermissionDecision = (record: PermissionDecisionRecord): void => {
  const r = activeRecorder
  if (r === null) return
  try {
    r.onDecision(record)
  } catch {
    // Swallow — observability bugs must not change the gate's behavior.
  }
}

/** Emit one post-denial state-transition event. No-op when no recorder is
 *  registered. Exceptions caught + swallowed (same rationale). */
export const emitPostDenialEvent = (record: PostDenialEventRecord): void => {
  const r = activeRecorder
  if (r === null) return
  try {
    r.onPostDenialEvent(record)
  } catch {
    // Swallow.
  }
}
