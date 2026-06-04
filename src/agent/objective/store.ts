/**
 * ADR-0394 — In-memory `ObjectivePort` implementation.
 *
 * Zero-dep reference store. The single mutator of the `Objective` model.
 * Determinism:
 *   - frozen snapshots returned to callers (no post-return mutation leaks).
 *   - injected `now` clock seam (default `Date.now`) for stable timestamps.
 *
 * NO-THROW contract: every method wraps its body in a try/catch and degrades
 * to `null` (mutators / get) or an empty result (`list`) on ANY internal
 * error or malformed input. No method ever throws.
 *
 * Status is NEVER stored as the source of truth on its own. We persist the
 * caller's last EXPLICIT `updateStatus` value separately and DERIVE the
 * public `status` on every read/write from the derivation rule (see
 * `./types` doc + ADR-0394). This keeps the blocked/completed invariants
 * impossible to violate via field drift.
 *
 * exactOptional: budget `max*` keys are OMITTED when absent.
 */

import { randomUUID } from "node:crypto"
import { logger } from "@/shared"
import type {
  Blocker,
  Objective,
  ObjectiveBudget,
  ObjectivePort,
  ObjectiveSnapshot,
  ObjectiveStatus,
  SuccessCriterion,
  WaitingOn,
} from "./types"

/** Internal mutable cell. `explicitStatus` is the caller's last non-derived
 *  intent ("active" | "completed"); the public status is always DERIVED. */
interface Cell {
  threadId: string
  goal: string
  criteria: SuccessCriterion[]
  blockers: Blocker[]
  nextActions: string[]
  explicitStatus: "active" | "completed"
  maxTokens?: number
  tokensUsed: number
  maxTurns?: number
  turnsUsed: number
  createdAt: number
  updatedAt: number
}

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0

const finiteNonNegInt = (v: unknown): number | undefined => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return undefined
  return Math.floor(v)
}

/** H17 — exact (NOT heuristic) budget-exhaustion predicate. The objective has
 *  exceeded its envelope when a CONFIGURED cap is met by accumulated usage:
 *  `tokensUsed >= maxTokens` OR `turnsUsed >= maxTurns`. Comparison is `>=`
 *  (reaching the cap is exhaustion). A cap that is `undefined` never triggers;
 *  no caps at all ⇒ never exhausted. Pure function of the cell. */
const budgetExhausted = (cell: Cell): boolean =>
  (cell.maxTokens !== undefined && cell.tokensUsed >= cell.maxTokens) ||
  (cell.maxTurns !== undefined && cell.turnsUsed >= cell.maxTurns)

/** Derive the public status from the immutable rule. blockers win, then (when
 *  enforcement is enabled) a budget-exhausted cell limits, then a fully-met
 *  (non-empty) criteria set completes, else the explicit value.
 *
 *  `enforce` is the store-level H17 gate (default false). When false this is
 *  byte-identical to the ADR-0394 derivation (budget stays informational —
 *  `budget_limited` is never produced). Total function over the cell. */
const deriveStatus = (cell: Cell, enforce: boolean): ObjectiveStatus => {
  if (cell.blockers.length > 0) return "blocked"
  if (enforce && budgetExhausted(cell)) return "budget_limited"
  if (cell.criteria.length > 0 && cell.criteria.every((c) => c.met)) return "completed"
  return cell.explicitStatus
}

const buildBudget = (cell: Cell): ObjectiveBudget => {
  const base = { tokensUsed: cell.tokensUsed, turnsUsed: cell.turnsUsed }
  return Object.freeze({
    ...base,
    ...(cell.maxTokens !== undefined ? { maxTokens: cell.maxTokens } : {}),
    ...(cell.maxTurns !== undefined ? { maxTurns: cell.maxTurns } : {}),
  })
}

/** Project a cell to the frozen public `Objective`. Derives status here so no
 *  read can ever observe a status that contradicts blockers/criteria/budget. */
const toObjective = (cell: Cell, enforce: boolean): Objective =>
  Object.freeze({
    threadId: cell.threadId,
    goal: cell.goal,
    successCriteria: Object.freeze(cell.criteria.map((c) => Object.freeze({ ...c }))),
    status: deriveStatus(cell, enforce),
    budget: buildBudget(cell),
    blockers: Object.freeze(cell.blockers.map((b) => Object.freeze({ ...b }))),
    nextActions: Object.freeze([...cell.nextActions]),
    createdAt: cell.createdAt,
    updatedAt: cell.updatedAt,
  })

/**
 * SERDE fix — persist INTENT, not derivation.
 *
 * The public `Objective.status` is a DERIVED value (blockers/criteria win over
 * the caller's explicit intent). A snapshot that stored only that derived
 * `status` and restored `explicitStatus` from it would conflate auto-derived
 * completion ("all criteria met") with an explicit `updateStatus("completed")`.
 * After such a round-trip, unmarking a criterion would NOT revert to "active"
 * because the restored explicit intent had been silently upgraded to
 * "completed" — breaking the re-derivation invariant pinned by
 * objective-hellgate.test.ts:185.
 *
 * The cure is to serialize the underlying `explicitStatus` alongside the
 * derived view. `Objective` is a structural interface, so a snapshot entry that
 * carries one extra `explicitStatus` field is still assignable to it; the field
 * is read back verbatim on restore (never inferred from `status`). This keeps
 * the persist LOSSLESS — intent survives the round-trip — and keeps status
 * derivation a pure function of `explicitStatus + criteria + blockers`. */
interface SnapshotObjective extends Objective {
  /** The caller's last EXPLICIT intent — the ONLY status source on restore. */
  readonly explicitStatus: "active" | "completed"
}

const toSnapshotObjective = (cell: Cell, enforce: boolean): SnapshotObjective =>
  Object.freeze({
    threadId: cell.threadId,
    goal: cell.goal,
    successCriteria: Object.freeze(cell.criteria.map((c) => Object.freeze({ ...c }))),
    status: deriveStatus(cell, enforce),
    explicitStatus: cell.explicitStatus,
    budget: buildBudget(cell),
    blockers: Object.freeze(cell.blockers.map((b) => Object.freeze({ ...b }))),
    nextActions: Object.freeze([...cell.nextActions]),
    createdAt: cell.createdAt,
    updatedAt: cell.updatedAt,
  })

/** Audit R2 (F3) defensive caps. The agent populates its own threads, so the
 *  exploit surface is "agent misbehaves and floods its own state" — but a
 *  bounded cap is cheap and mirrors the mailbox/run-ledger/approval-LRU
 *  retention discipline. Tuned far above any realistic objective: 256 success
 *  criteria + 64 simultaneous blockers per thread are already absurd; the cap
 *  exists purely to bound pathological growth. */
const MAX_CRITERIA_PER_OBJECTIVE = 256
const MAX_BLOCKERS_PER_OBJECTIVE = 64

const sanitizeCriteria = (raw: readonly string[] | undefined): SuccessCriterion[] => {
  if (!Array.isArray(raw)) return []
  const out: SuccessCriterion[] = []
  for (const entry of raw) {
    if (typeof entry !== "string") continue
    if (out.length >= MAX_CRITERIA_PER_OBJECTIVE) break
    out.push({ id: randomUUID(), text: entry, met: false })
  }
  return out
}

/** A blank cell stamped at `t` — used when `set` receives malformed input but
 *  must still return a non-null `Objective` (the port contract). */
const emptyCell = (threadId: string, t: number): Cell => ({
  threadId: isNonEmptyString(threadId) ? threadId : "",
  goal: "",
  criteria: [],
  blockers: [],
  nextActions: [],
  explicitStatus: "active",
  tokensUsed: 0,
  turnsUsed: 0,
  createdAt: t,
  updatedAt: t,
})

/** Build a fresh cell from a well-formed `set` init payload. */
const cellFromInit = (
  threadId: string,
  init: {
    goal: string
    successCriteria?: readonly string[]
    budget?: { maxTokens?: number; maxTurns?: number }
  },
  t: number,
): Cell => {
  const maxTokens = finiteNonNegInt(init.budget?.maxTokens)
  const maxTurns = finiteNonNegInt(init.budget?.maxTurns)
  return {
    threadId,
    goal: typeof init.goal === "string" ? init.goal : "",
    criteria: sanitizeCriteria(init.successCriteria),
    blockers: [],
    nextActions: [],
    explicitStatus: "active",
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    tokensUsed: 0,
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    turnsUsed: 0,
    createdAt: t,
    updatedAt: t,
  }
}

export const createObjectiveStore = (opts?: {
  now?: () => number
  /** H17 — when true the public `status` derives `"budget_limited"` once a
   *  configured cap is reached (see `deriveStatus`/`budgetExhausted`). Default
   *  false ⇒ budget is purely informational and the status is byte-identical
   *  to ADR-0394 (this flag is the SSOT for whether the store enforces; the
   *  host wires it from `QUANTA_OBJECTIVE_BUDGET_ENFORCE`). */
  enforceBudget?: boolean
}): ObjectivePort => {
  const now = opts?.now ?? Date.now
  const enforce = opts?.enforceBudget === true
  const cells = new Map<string, Cell>()

  const clockNow = (): number => {
    try {
      const t = now()
      return Number.isFinite(t) ? t : Date.now()
    } catch {
      return Date.now()
    }
  }

  /** Resolve a cell by threadId, run `fn`, stamp updatedAt, return projection.
   *  Unknown thread ⇒ null. Any throw ⇒ null. */
  const mutate = (threadId: string, fn: (cell: Cell) => void): Objective | null => {
    try {
      if (!isNonEmptyString(threadId)) return null
      const cell = cells.get(threadId)
      if (cell === undefined) return null
      fn(cell)
      cell.updatedAt = clockNow()
      return toObjective(cell, enforce)
    } catch {
      return null
    }
  }

  return {
    set(threadId, init): Objective {
      try {
        // Malformed input still returns a non-null Objective (port contract):
        // degrade to a synthetic empty cell rather than throwing.
        if (!isNonEmptyString(threadId) || init === null || typeof init !== "object") {
          return toObjective(emptyCell(threadId, clockNow()), enforce)
        }
        const cell = cellFromInit(threadId, init, clockNow())
        cells.set(threadId, cell)
        return toObjective(cell, enforce)
      } catch {
        return toObjective(emptyCell(threadId, Date.now()), enforce)
      }
    },

    get(threadId): Objective | null {
      try {
        if (!isNonEmptyString(threadId)) return null
        const cell = cells.get(threadId)
        return cell === undefined ? null : toObjective(cell, enforce)
      } catch {
        return null
      }
    },

    updateStatus(threadId, status): Objective | null {
      return mutate(threadId, (cell) => {
        // Only "active"/"completed" are explicit intents; "blocked" is derived
        // exclusively from the blocker list and cannot be set directly.
        if (status === "active" || status === "completed") {
          cell.explicitStatus = status
        }
      })
    },

    addBlocker(threadId, blocker): Objective | null {
      return mutate(threadId, (cell) => {
        // Audit R2 (F3): bounded blocker count per objective. Silently dropping
        // is correct here — an agent that has hit 64 simultaneous unresolved
        // blockers on one thread is already in a pathological state; adding a
        // 65th would not help diagnosis.
        if (cell.blockers.length >= MAX_BLOCKERS_PER_OBJECTIVE) return
        const waitingOn: WaitingOn =
          blocker?.waitingOn === "user" ||
          blocker?.waitingOn === "tool" ||
          blocker?.waitingOn === "network" ||
          blocker?.waitingOn === "child_agent"
            ? blocker.waitingOn
            : "user"
        cell.blockers.push({
          id: randomUUID(),
          reason: typeof blocker?.reason === "string" ? blocker.reason : "",
          waitingOn,
          since: clockNow(),
        })
      })
    },

    clearBlocker(threadId, blockerId): Objective | null {
      return mutate(threadId, (cell) => {
        cell.blockers = cell.blockers.filter((b) => b.id !== blockerId)
      })
    },

    setNextActions(threadId, actions): Objective | null {
      return mutate(threadId, (cell) => {
        cell.nextActions = Array.isArray(actions)
          ? actions.filter((a): a is string => typeof a === "string")
          : []
      })
    },

    markCriterion(threadId, criterionId, met): Objective | null {
      return mutate(threadId, (cell) => {
        cell.criteria = cell.criteria.map((c) =>
          c.id === criterionId ? { ...c, met: met === true } : c,
        )
      })
    },

    recordUsage(threadId, used): Objective | null {
      return mutate(threadId, (cell) => {
        const dTokens = finiteNonNegInt(used?.tokens)
        const dTurns = finiteNonNegInt(used?.turns)
        if (dTokens !== undefined) cell.tokensUsed += dTokens
        if (dTurns !== undefined) cell.turnsUsed += dTurns
      })
    },

    list(): readonly Objective[] {
      try {
        return Object.freeze([...cells.values()].map((c) => toObjective(c, enforce)))
      } catch {
        return Object.freeze([])
      }
    },

    toSnapshot(): ObjectiveSnapshot {
      try {
        return Object.freeze({
          objectives: Object.freeze(
            [...cells.values()].map((c) => toSnapshotObjective(c, enforce)),
          ),
        })
      } catch {
        return Object.freeze({ objectives: Object.freeze([]) })
      }
    },

    fromSnapshot(snap): void {
      try {
        cells.clear()
        const objectives = (snap as ObjectiveSnapshot | undefined)?.objectives
        if (!Array.isArray(objectives)) return
        for (const o of objectives) {
          const cell = cellFromObjective(o)
          if (cell !== null) cells.set(cell.threadId, cell)
        }
      } catch {
        // leave whatever survived; never throw
      }
    },
  }
}

const finiteOrZero = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)

/** Re-apply the live `sanitizeCriteria` caps when rebuilding from a snapshot.
 *  R4 audit-M closure: without this, a hostile/corrupted snapshot could ship
 *  a 1M-entry `successCriteria` array and inflate the in-memory cell past the
 *  256-criterion live cap that `set()` enforces. Slice equally with the live
 *  path so byte-identical snapshot round-trip from a healthy run stays exact
 *  (every healthy snapshot is already ≤ MAX_CRITERIA_PER_OBJECTIVE).
 *
 *  R5 audit-H4 closure: emit a `logger.warn` when the cap is hit so the
 *  truncation is observable (silent truncation was invisible to operators
 *  inspecting why a snapshot lost data). Single line per rebuild — the
 *  label-keyed leaky bucket in `logger.ts` bounds the rate even under a
 *  pathological replay flood. */
const rebuildCriteria = (raw: unknown): SuccessCriterion[] => {
  if (!Array.isArray(raw)) return []
  const out: SuccessCriterion[] = []
  for (const c of raw) {
    if (c === null || typeof c !== "object") continue
    if (out.length >= MAX_CRITERIA_PER_OBJECTIVE) break
    out.push({
      id: isNonEmptyString(c.id) ? c.id : randomUUID(),
      text: typeof c.text === "string" ? c.text : "",
      met: c.met === true,
    })
  }
  if (raw.length > MAX_CRITERIA_PER_OBJECTIVE) {
    logger.warn(
      `objective.rebuild.truncate: criteria=${raw.length} capped to ${MAX_CRITERIA_PER_OBJECTIVE}`,
    )
  }
  return out
}

/** Mirror of `rebuildCriteria` for the 64-blocker live cap. Hostile snapshot
 *  could otherwise ship N blockers and stick the objective in `blocked` state
 *  forever (status derivation requires blockers.length === 0 to leave).
 *
 *  R5 audit-H4 closure: same observability discipline as `rebuildCriteria`. */
const rebuildBlockers = (raw: unknown): Blocker[] => {
  if (!Array.isArray(raw)) return []
  const out: Blocker[] = []
  for (const b of raw) {
    if (b === null || typeof b !== "object") continue
    if (out.length >= MAX_BLOCKERS_PER_OBJECTIVE) break
    out.push({
      id: isNonEmptyString(b.id) ? b.id : randomUUID(),
      reason: typeof b.reason === "string" ? b.reason : "",
      waitingOn: b.waitingOn,
      since: finiteOrZero(b.since),
    })
  }
  if (raw.length > MAX_BLOCKERS_PER_OBJECTIVE) {
    logger.warn(
      `objective.rebuild.truncate: blockers=${raw.length} capped to ${MAX_BLOCKERS_PER_OBJECTIVE}`,
    )
  }
  return out
}

/**
 * Recover the persisted EXPLICIT intent from a snapshot entry.
 *
 * SERDE fix: read ONLY the dedicated `explicitStatus` field — NEVER the derived
 * `status`. If the explicit field is absent (legacy snapshot written before the
 * field existed, or a hostile payload), we cannot know whether a `completed`
 * status was explicit intent or auto-derived from met criteria; the safe,
 * non-fabricating answer is `active`. Defaulting to `active` is correct rather
 * than a silent fallback: the public `status` is RE-DERIVED from criteria after
 * restore, so a genuinely-complete objective (all criteria met) still reports
 * `completed`, and only the explicit-vs-derived distinction is reset — exactly
 * the field whose legacy value is unknowable. This never UPGRADES a derived
 * completion to explicit intent (the bug), it only ever stays/declines. */
const explicitFromSnapshot = (rec: { explicitStatus?: unknown }): "active" | "completed" =>
  rec.explicitStatus === "completed" ? "completed" : "active"

/** Reconstruct a mutable cell from a (possibly hostile) snapshot entry. */
function cellFromObjective(o: unknown): Cell | null {
  if (o === null || typeof o !== "object") return null
  const rec = o as Partial<SnapshotObjective>
  if (!isNonEmptyString(rec.threadId)) return null
  const budget = (rec.budget ?? {}) as Partial<ObjectiveBudget>
  const maxTokens = finiteNonNegInt(budget.maxTokens)
  const maxTurns = finiteNonNegInt(budget.maxTurns)
  return {
    threadId: rec.threadId,
    goal: typeof rec.goal === "string" ? rec.goal : "",
    criteria: rebuildCriteria(rec.successCriteria),
    blockers: rebuildBlockers(rec.blockers),
    nextActions: Array.isArray(rec.nextActions)
      ? rec.nextActions.filter((a): a is string => typeof a === "string")
      : [],
    explicitStatus: explicitFromSnapshot(rec),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    tokensUsed: finiteNonNegInt(budget.tokensUsed) ?? 0,
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    turnsUsed: finiteNonNegInt(budget.turnsUsed) ?? 0,
    createdAt: finiteOrZero(rec.createdAt),
    updatedAt: finiteOrZero(rec.updatedAt),
  }
}
