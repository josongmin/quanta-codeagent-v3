/**
 * MODEL ROUTING CONTRACT (MR-00) — one owner for "which model runs, and which
 * model ran".
 *
 * # Why an authority and not a bag of fields
 *
 * The aug-27/28 campaign wired the model switch as three loose slots
 * (`stickyModelStore`, `modelCandidates`, `effectiveModel`) that every
 * composition root assembled for itself. Three roots re-implemented the same
 * five decisions — provider/mode key, explicit-pin precedence, persisted-pick
 * vetting, candidate-port seeding, session scoping — and a cross-surface audit
 * found EIGHT confirmed defects, all of the same shape: two roots disagreed
 * about one of those decisions. A helper that returns `{store, provider,
 * effectiveModel, candidates}` does not fix that: the fields come apart again at
 * the next assembly site. So the unit of reuse is the OWNER, not the fields.
 *
 * # The two model facts (this is the other root cause)
 *
 * `effectiveModelOf()` answered one question — "what model?" — for two different
 * questions, and every reporting defect in the audit came from that conflation:
 *
 *   - SELECTED  — what the NEXT request will run. A live, mutable choice. This is
 *                 what a picker marks, what a status line shows, what
 *                 `SessionHost.describe().modelSlug` publishes.
 *   - EXECUTED  — what a request ACTUALLY ran on. Immutable once captured. This is
 *                 what `llm_request.model`, `turn.completed.modelSlug`, token
 *                 accounting and cost attribution must use.
 *
 * They legitimately differ: switch the model mid-turn and the in-flight request
 * still ran the old one. Reporting the selected model as though it were executed
 * is not a rounding error — it misattributes spend to a model that never ran.
 * The type system now keeps them apart: {@link ModelSelectionView} is selected,
 * {@link ModelRequestSnapshot} is executed, and nothing converts one to the other.
 *
 * # Precedence (fixed; see `./precedence.ts` for the executable tables)
 *
 *   boot model          : explicit flag > QUANTA_MODEL > provider default
 *   initial selection   : explicit boot pin > runnable persisted pick > boot
 *   per request         : skill override > session selection > boot
 *
 * # Fixed decisions
 *
 *   - An explicit boot pin makes the session IGNORE a persisted pick (the pick is
 *     not erased; it just does not seed this session). Mid-session `/model` /
 *     `set_model` still work.
 *   - A selection becomes public ONLY after its durable write succeeds. No display
 *     may name a model that a later session will not find on disk.
 *   - `turn.completed.modelSlug` carries the EXECUTED model, never the selected one.
 *   - The boot model is never duplicated as a separate candidate port: resolving it
 *     yields the boot port by identity.
 *   - An explicit skill `model:` that resolves to no port FAILS CLOSED (see
 *     {@link UnroutableModelError}).
 */

import type { LLMPort, Provider } from "@/llm"
import { QuantaError } from "@/shared"
import type { AgentMode } from "../prompt"

/**
 * The mode axis of a selection.
 *
 * DELIBERATELY the PROMPT mode (`@/agent/prompt#AgentMode`, derived from
 * `AGENT_PROMPT_MODES`) — the repo has two other unrelated `AgentMode` unions
 * (`@/agent/subagent-typed/port` and `@/agent/run-mode/types`), and the sticky
 * key has always used this one. Naming it here so a future import cannot pick
 * the wrong union and produce keys nothing reads.
 */
export type ModelRoutingMode = AgentMode

/** Where a resolved model id came from. Reported, not inferred by the caller. */
export type ModelSelectionSource = "skill" | "session" | "boot"

/** One selectable model as a surface renders it. Metadata is OMITTED when the
 *  provider-metadata SSOT has no exact entry — never a placeholder, so a picker
 *  degrades to a bare id rather than printing a claim it cannot support. */
export interface ModelOption {
  readonly id: string
  /** True for the model this session booted on (the "recommended" anchor). */
  readonly isBootModel: boolean
  /** True for the model the NEXT request will run (the picker's `*` marker). */
  readonly isSelected: boolean
  readonly contextWindow?: number
  readonly maxOutput?: number
  readonly hint?: string
}

/**
 * What the NEXT request will run — the SELECTED model, never the executed one.
 *
 * Synchronous by contract: every consumer is a paint path (`describe()` is a sync
 * projection, a status line repaints per frame), and the async-only store is what
 * pushed four displays into keeping their own stale shadow copies.
 */
export interface ModelSelectionView {
  /** The model the next request resolves to, absent any skill override. */
  readonly modelId: string
  readonly provider: Provider
  readonly mode: ModelRoutingMode
  /** `"boot"` when nothing is selected — i.e. `modelId` IS the boot model. */
  readonly source: Exclude<ModelSelectionSource, "skill">
  /** Bumped on every accepted selection change. Lets a consumer tell "unchanged"
   *  from "changed back", which a bare id cannot express. */
  readonly revision: number
}

/** Outcome of a selection mutation. No-throw: an unknown id and a failed durable
 *  write are both typed results, because both are ordinary operator outcomes. */
export type ModelSelectionResult =
  | { readonly ok: true; readonly view: ModelSelectionView }
  | { readonly ok: false; readonly kind: "unknown-model"; readonly known: readonly string[] }
  | { readonly ok: false; readonly kind: "write-error"; readonly message: string }

/**
 * What ONE request actually ran on — the EXECUTED model. Immutable, captured
 * once at request start, and carried through streaming, events and accounting.
 *
 * Carrying the PORT (not just the id) is the point: a consumer that re-resolved
 * the id later would re-read a live selection and could stream one model while
 * reporting another. Everything downstream reads this snapshot.
 */
export interface ModelRequestSnapshot {
  readonly modelId: string
  readonly provider: Provider
  readonly port: LLMPort
  readonly mode: ModelRoutingMode
  readonly source: ModelSelectionSource
  /** The {@link ModelSelectionView.revision} this request was resolved against.
   *  A later selection bumps the authority's revision without changing this, so a
   *  completion event can be matched to the selection that produced it. */
  readonly selectionRevision: number
}

/**
 * Raised when a request names a model that resolves to no port.
 *
 * FAIL-CLOSED, and deliberately a throw rather than a typed result. A skill that
 * declares `model: some-model` is making a requirement, not a preference — the
 * measured prior behaviour silently ran the BASE model instead, with no warning
 * on any channel, so the skill's declared contract was quietly void. A
 * `{ok:false}` here would invite exactly that: a caller that ignores the failure
 * and proceeds on the boot model. The turn must stop instead.
 *
 * This is the ONE method on the authority that may reject; every mutation
 * (`select`/`clear`) stays no-throw.
 */
export class UnroutableModelError extends QuantaError {
  readonly modelId: string
  readonly known: readonly string[]
  constructor(modelId: string, known: readonly string[]) {
    super(
      "model_unroutable",
      `no port for model ${JSON.stringify(modelId)}` +
        (known.length > 0 ? ` — known: ${known.join(", ")}` : " — no candidates are wired"),
    )
    this.modelId = modelId
    this.known = known
  }
}

/**
 * THE owner of model routing for one session. Exactly one instance per session,
 * reached by every surface and by the loop.
 */
export interface ModelRoutingAuthority {
  /** The current SELECTED model. Sync — see {@link ModelSelectionView}. */
  view(): ModelSelectionView

  /** Every selectable model, for a picker. May await a lazy provider-catalog
   *  probe; no-throw (a rejected probe degrades to the seeded set). */
  list(): Promise<readonly ModelOption[]>

  /**
   * Choose the model for subsequent requests. Resolves only AFTER the durable
   * write settles — `view()` and `list()` reflect it on return, or the result is
   * `ok:false` and nothing moved.
   *
   * `mode` targets a posture OTHER than the live one (`/sticky-model <mode> <id>`,
   * the explicit-mode escape hatch). Omitted ⇒ the live mode, which is what
   * `/model` and `set_model` mean. It is a parameter rather than a second door
   * because a surface writing the store directly is how the authority ended up
   * with a second owner: `/model --clear` cleared the store while the authority's
   * own selection still held the pick, and the display kept reporting it.
   */
  select(modelId: string, mode?: ModelRoutingMode): Promise<ModelSelectionResult>

  /** Drop the selection and fall back to the boot model. Idempotent. `mode` as in
   *  {@link select}. */
  clear(mode?: ModelRoutingMode): Promise<ModelSelectionResult>

  /**
   * Capture the model for ONE request, at request start. The returned snapshot is
   * what streams and what every event/accounting consumer reports.
   *
   * @throws {UnroutableModelError} when `skillModel` names a model with no port.
   */
  resolveRequest(input: { readonly skillModel?: string }): Promise<ModelRequestSnapshot>
}
