/**
 * WorkingState — Codex memory layer L3 (Codex `memory-model-audit.md` mirror).
 *
 * Per-turn, free-form scratchpad the LLM updates as it works: the current owner
 * shortlist, a working hypothesis, blockers, deferred validations, and the
 * next-step queue. The loop carries it across turns when the caller opts in via
 * `AgentConfig.workingState = { enabled: true }`; absent ⇒ no block is rendered
 * and the loop is byte-identical (default-OFF).
 *
 * Codex's key insight: this is L3, NOT durable storage. Durable state still
 * externalizes to artifacts (workspace files). WorkingState is the in-session
 * scratch that gives the agent a place to PLAN AHEAD without bloating chat.
 */

export interface OwnerCandidate {
  file: string
  reason: string
}

/** Where a {@link Blocker} manifests. Typed (not free-form string) so the
 *  surface is a routable category — the closeout-guard's four-truth-surface
 *  reminder (`type/owner/wire/test`) and the audit-mode posture both rely on
 *  these names being stable. `"build"` covers config/manifest/CI surfaces and
 *  `"other"` is a deliberate escape hatch for surfaces a new task posture may
 *  surface (adding a new tag is a typed change, NOT a silent rewrite). */
export type BlockerSurface = "type" | "owner" | "wire" | "test" | "runtime" | "build" | "other"

export interface Blocker {
  what: string
  surface: BlockerSurface
}

export interface NextStep {
  what: string
  deferred?: boolean
}

export interface DeferredValidation {
  /** Validation rail that was deferred, e.g. "pytest", "bun test", "tsc". */
  rail: string
  /** Why deferred — recorded so the agent (and reviewer) can revisit. */
  reason: string
}

/** Per-turn working state (Codex memory layer L3). Free-form; the LLM updates
 *  it via the `update_working_state` meta-tool. The loop carries it across
 *  turns when the caller opts in via `config.workingState = { enabled: true }`. */
export interface WorkingState {
  ownerShortlist: OwnerCandidate[]
  hypothesis?: string
  blockers: Blocker[]
  nextStepQueue: NextStep[]
  deferredValidation: DeferredValidation[]
}

export const emptyWorkingState = (): WorkingState => ({
  ownerShortlist: [],
  blockers: [],
  nextStepQueue: [],
  deferredValidation: [],
})

/** True when EVERY field is empty (no owners, no hypothesis, no blockers, no
 *  next steps, no deferred validation). Used to skip the per-turn block when
 *  there is nothing to carry — keeps the reminder uncluttered. */
const isEmpty = (s: WorkingState): boolean =>
  s.ownerShortlist.length === 0 &&
  (s.hypothesis === undefined || s.hypothesis.trim() === "") &&
  s.blockers.length === 0 &&
  s.nextStepQueue.length === 0 &&
  s.deferredValidation.length === 0

/** Session-scoped WorkingState handle (Codex memory L3). The agent loop builds
 *  ONE instance at session start (when `AgentConfig.workingState` is set), the
 *  `update_working_state` tool mutates it through the closure, and the per-turn
 *  reminder reads the current snapshot via {@link WorkingStateSession.snapshot}.
 *  Structurally compatible with `WorkingStateHandle` in `@/tool`. */
export interface WorkingStateSession {
  /** Apply a partial replacement to the current state. */
  mutate(patch: WorkingStatePatch): WorkingState
  /** Read-only snapshot of the current state. */
  snapshot(): WorkingState
}

/** Patch shape used by the `update_working_state` tool. Structurally
 *  compatible with `WorkingStatePatch` in `@/tool` — `| undefined` is spelled
 *  on every optional so a zod `.optional()` parse output (which is structurally
 *  `T | undefined`) flows through under `exactOptionalPropertyTypes: true`. */
export interface WorkingStatePatch {
  ownerShortlist?: OwnerCandidate[] | undefined
  hypothesis?: string | null | undefined
  blockers?: Blocker[] | undefined
  nextStepQueue?: NextStep[] | undefined
  deferredValidation?: DeferredValidation[] | undefined
}

/** Build a fresh session-scoped WorkingState handle. State starts empty; the
 *  LLM populates it via the `update_working_state` meta-tool. */
export const createWorkingStateSession = (): WorkingStateSession => {
  let state: WorkingState = emptyWorkingState()
  return {
    mutate(patch) {
      const next: WorkingState = { ...state }
      if (patch.ownerShortlist !== undefined) next.ownerShortlist = [...patch.ownerShortlist]
      if (patch.hypothesis !== undefined) {
        if (patch.hypothesis === null) delete next.hypothesis
        else next.hypothesis = patch.hypothesis
      }
      if (patch.blockers !== undefined) next.blockers = [...patch.blockers]
      if (patch.nextStepQueue !== undefined) next.nextStepQueue = [...patch.nextStepQueue]
      if (patch.deferredValidation !== undefined) {
        next.deferredValidation = [...patch.deferredValidation]
      }
      state = next
      return state
    },
    snapshot() {
      // Deep-copy: caller-visible "snapshot" must NOT alias live state, or
      // a subsequent `mutate(...)` (e.g. from a concurrent tool call earlier
      // in the same turn) would race a reader holding the snapshot. Inner
      // arrays carry caller-supplied object references — clone the entries
      // too so accidental `snap.blockers[0].what = "..."` cannot tamper with
      // session state. `mutate(patch)` itself is replacement-only so this is
      // the only seam where a live reference could escape.
      return {
        ownerShortlist: state.ownerShortlist.map((o) => ({ ...o })),
        blockers: state.blockers.map((b) => ({ ...b })),
        nextStepQueue: state.nextStepQueue.map((n) => ({ ...n })),
        deferredValidation: state.deferredValidation.map((d) => ({ ...d })),
        ...(state.hypothesis !== undefined ? { hypothesis: state.hypothesis } : {}),
      }
    },
  }
}

/** Render a non-empty list under a sub-header (e.g. "### Owner shortlist") via
 *  the provided item renderer. Returns `[]` when the list is empty so the
 *  caller's accumulator stays compact. Extracted to keep the public
 *  `renderWorkingStateBlock` under the project's cognitive-complexity budget. */
const renderSection = <T>(
  header: string,
  items: readonly T[],
  fmt: (item: T) => string,
): string[] => (items.length === 0 ? [] : ["", header, ...items.map(fmt)])

/** Render the hypothesis section, if any. */
const renderHypothesis = (hypothesis: string | undefined): string[] => {
  if (hypothesis === undefined || hypothesis.trim() === "") return []
  return ["", "### Hypothesis", hypothesis.trim()]
}

/** Render a WorkingState as a compact markdown block for the per-turn reminder.
 *  Returns `undefined` when the state is empty (no clutter when there is
 *  nothing to carry). Sub-headers are emitted only for non-empty fields so the
 *  block stays as small as possible. */
export const renderWorkingStateBlock = (state: WorkingState): string | undefined => {
  if (isEmpty(state)) return undefined
  const lines: string[] = ["## Working state"]
  lines.push(
    ...renderSection(
      "### Owner shortlist",
      state.ownerShortlist,
      (o) => `- ${o.file} — ${o.reason}`,
    ),
    ...renderHypothesis(state.hypothesis),
    ...renderSection("### Blockers", state.blockers, (b) => `- [${b.surface}] ${b.what}`),
    ...renderSection(
      "### Next steps",
      state.nextStepQueue,
      (n) => `- ${n.what}${n.deferred ? " (deferred)" : ""}`,
    ),
    ...renderSection(
      "### Deferred validation",
      state.deferredValidation,
      (d) => `- ${d.rail}: ${d.reason}`,
    ),
  )
  return lines.join("\n")
}
