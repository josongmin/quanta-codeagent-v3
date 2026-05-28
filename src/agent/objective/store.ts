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

/** Derive the public status from the immutable rule. blockers win, then a
 *  fully-met (non-empty) criteria set completes, else the explicit value. */
const deriveStatus = (cell: Cell): ObjectiveStatus => {
  if (cell.blockers.length > 0) return "blocked"
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
 *  read can ever observe a status that contradicts blockers/criteria. */
const toObjective = (cell: Cell): Objective =>
  Object.freeze({
    threadId: cell.threadId,
    goal: cell.goal,
    successCriteria: Object.freeze(cell.criteria.map((c) => Object.freeze({ ...c }))),
    status: deriveStatus(cell),
    budget: buildBudget(cell),
    blockers: Object.freeze(cell.blockers.map((b) => Object.freeze({ ...b }))),
    nextActions: Object.freeze([...cell.nextActions]),
    createdAt: cell.createdAt,
    updatedAt: cell.updatedAt,
  })

const sanitizeCriteria = (raw: readonly string[] | undefined): SuccessCriterion[] => {
  if (!Array.isArray(raw)) return []
  const out: SuccessCriterion[] = []
  for (const entry of raw) {
    if (typeof entry !== "string") continue
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

export const createObjectiveStore = (opts?: { now?: () => number }): ObjectivePort => {
  const now = opts?.now ?? Date.now
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
      return toObjective(cell)
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
          return toObjective(emptyCell(threadId, clockNow()))
        }
        const cell = cellFromInit(threadId, init, clockNow())
        cells.set(threadId, cell)
        return toObjective(cell)
      } catch {
        return toObjective(emptyCell(threadId, Date.now()))
      }
    },

    get(threadId): Objective | null {
      try {
        if (!isNonEmptyString(threadId)) return null
        const cell = cells.get(threadId)
        return cell === undefined ? null : toObjective(cell)
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
        return Object.freeze([...cells.values()].map(toObjective))
      } catch {
        return Object.freeze([])
      }
    },

    toSnapshot(): ObjectiveSnapshot {
      try {
        return Object.freeze({
          objectives: Object.freeze([...cells.values()].map(toObjective)),
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

const rebuildCriteria = (raw: unknown): SuccessCriterion[] =>
  Array.isArray(raw)
    ? raw
        .filter((c): c is SuccessCriterion => c !== null && typeof c === "object")
        .map((c) => ({
          id: isNonEmptyString(c.id) ? c.id : randomUUID(),
          text: typeof c.text === "string" ? c.text : "",
          met: c.met === true,
        }))
    : []

const rebuildBlockers = (raw: unknown): Blocker[] =>
  Array.isArray(raw)
    ? raw
        .filter((b): b is Blocker => b !== null && typeof b === "object")
        .map((b) => ({
          id: isNonEmptyString(b.id) ? b.id : randomUUID(),
          reason: typeof b.reason === "string" ? b.reason : "",
          waitingOn: b.waitingOn,
          since: finiteOrZero(b.since),
        }))
    : []

/** Reconstruct a mutable cell from a (possibly hostile) public Objective. */
function cellFromObjective(o: unknown): Cell | null {
  if (o === null || typeof o !== "object") return null
  const rec = o as Partial<Objective>
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
    explicitStatus: rec.status === "completed" ? "completed" : "active",
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    tokensUsed: finiteNonNegInt(budget.tokensUsed) ?? 0,
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    turnsUsed: finiteNonNegInt(budget.turnsUsed) ?? 0,
    createdAt: finiteOrZero(rec.createdAt),
    updatedAt: finiteOrZero(rec.updatedAt),
  }
}
