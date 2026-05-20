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

export interface Blocker {
  what: string
  /** Where the blocker manifests: "type" | "wire" | "test" | "runtime" | etc. */
  surface: string
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
      return state
    },
  }
}

/** Render a WorkingState as a compact markdown block for the per-turn reminder.
 *  Returns `undefined` when the state is empty (no clutter when there is
 *  nothing to carry). Sub-headers are emitted only for non-empty fields so the
 *  block stays as small as possible. */
export const renderWorkingStateBlock = (state: WorkingState): string | undefined => {
  if (isEmpty(state)) return undefined
  const lines: string[] = ["## Working state"]
  if (state.ownerShortlist.length > 0) {
    lines.push("", "### Owner shortlist")
    for (const o of state.ownerShortlist) lines.push(`- ${o.file} — ${o.reason}`)
  }
  if (state.hypothesis !== undefined && state.hypothesis.trim() !== "") {
    lines.push("", "### Hypothesis", state.hypothesis.trim())
  }
  if (state.blockers.length > 0) {
    lines.push("", "### Blockers")
    for (const b of state.blockers) lines.push(`- [${b.surface}] ${b.what}`)
  }
  if (state.nextStepQueue.length > 0) {
    lines.push("", "### Next steps")
    for (const n of state.nextStepQueue) {
      lines.push(`- ${n.what}${n.deferred ? " (deferred)" : ""}`)
    }
  }
  if (state.deferredValidation.length > 0) {
    lines.push("", "### Deferred validation")
    for (const d of state.deferredValidation) lines.push(`- ${d.rail}: ${d.reason}`)
  }
  return lines.join("\n")
}
