/**
 * ADR-0279 — Automation engine composition-root wire.
 *
 * Single helper `assembleAutomation(env, deps)` that constructs the
 * `AutomationEngineSlot` consumed by `AgentConfig.automationEngine`
 * (ADR-0215 engine seam + ADR-0240 loop-helper ticker arm/disarm).
 *
 * Default-OFF: `QUANTA_AUTOMATION !== "on"` ⇒ returns `null`. The caller's
 * spread-conditional in `apps/agent/index.ts` OMITS the slot — the legacy
 * byte-identical path is preserved (RFC §1.2).
 *
 * NO-THROW: invalid env (bad interval ms, etc.) ⇒ `null` + `logger.warn`.
 * The handler closure rethrows AgentLoopPort errors so `tickScheduler` can
 * mark the run as `errored` — `tickScheduler` itself is no-throw by contract.
 *
 * Slice: `@/scheduler` (additive helper; existing files unchanged).
 */

import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { logger, quantaHomePath, writeStderr } from "@/shared"
import {
  type AutomationEnginePort,
  type AutomationHandler,
  inMemoryAutomationEngine,
  sqliteAutomationEngine,
  type TickEligibilityVerdict,
  type TickOutcome,
} from "./automation-engine"
import type { AgentLoopPort } from "./types"

/** ENV gate — strict `"on"` enables the wire. Absent / any other value
 *  ⇒ `null` slot (default-OFF). Mirrors {@link SCHEDULER_ENV_FLAG}'s
 *  intentional-only-canonical-value posture. */
export const AUTOMATION_ENV_FLAG = "QUANTA_AUTOMATION" as const

/** ENV knob — tick interval in ms. Absent ⇒ {@link DEFAULT_AUTOMATION_INTERVAL_MS}.
 *  Invalid (NaN / ≤ 0 / non-numeric) ⇒ `null` slot + `logger.warn`. */
export const AUTOMATION_INTERVAL_ENV = "QUANTA_AUTOMATION_INTERVAL_MS" as const

/** ENV knob — durable store selector. The EXACT value `"sqlite"` swaps the
 *  in-memory engine for the SQLite-backed durable adapter (rows survive a
 *  restart). Absent / any other value ⇒ in-memory (default-OFF byte-identical
 *  — the legacy path). */
export const AUTOMATION_STORE_ENV = "QUANTA_AUTOMATION_STORE" as const

/** Canonical value of {@link AUTOMATION_STORE_ENV} that enables persistence. */
export const AUTOMATION_STORE_SQLITE = "sqlite" as const

/** Default on-disk path for the durable automations DB. Under the unified
 *  Quanta home (`~/.quanta/sqlite/automations.db`); a subsystem override is
 *  out of scope for v1. */
export const defaultAutomationDbPath = (): string => quantaHomePath("sqlite", "automations.db")

/** Default tick cadence — one minute, matching Codex `automation-schedule`'s
 *  ONE_MINUTE refetch. Aligned with `DEFAULT_TICK_INTERVAL_MS` (sibling). */
export const DEFAULT_AUTOMATION_INTERVAL_MS = 60_000

/** Shape consumed by the composition root — spread into
 *  `AgentConfig.automationEngine`. The ADR-0240 helper
 *  `startAutomationEngineTicker` reads exactly these fields. */
export interface AutomationEngineSlot {
  readonly engine: AutomationEnginePort
  readonly handler: AutomationHandler
  readonly tickIntervalMs: number
  readonly onTick: (outcome: TickOutcome) => void
  readonly now?: () => number
  /** ADR-0453 — OPTIONAL autorun-eligibility gate threaded into `tickScheduler`
   *  (the scheduler-path 4th guard). Absent ⇒ ticks are byte-identical to the
   *  pre-ADR-0453 path. Built at the composition root over the pure
   *  `evaluateAutorunEligibility` (closed `QUANTA_AUTORUN_POLICY` knob). */
  readonly eligibility?: () => TickEligibilityVerdict
}

/** Deps for the helper — pure DI. The composition root injects an
 *  `AgentLoopPort` so the handler closure can dispatch the automation
 *  prompt; tests inject fakes for both. */
export interface AssembleAutomationDeps {
  /** Required: the agent-loop seam the handler dispatches to. */
  readonly agentLoop: AgentLoopPort
  /** Optional engine override (tests inject; takes precedence over the
   *  env-driven store selector). When present the engine-select branch is
   *  bypassed entirely. */
  readonly engine?: AutomationEnginePort
  /** OPTIONAL sqlite-engine factory (test seam). Invoked ONLY when
   *  `deps.engine` is absent AND `QUANTA_AUTOMATION_STORE=sqlite`. Default opens
   *  a `Database` at {@link defaultAutomationDbPath} (creating the parent dir).
   *  Tests inject a `:memory:` factory so no disk is touched. */
  readonly sqliteEngineFactory?: () => AutomationEnginePort
  /** Optional clock injection. Default `Date.now`. */
  readonly now?: () => number
  /** Optional stderr writer (test injection). Default `process.stderr.write`.
   *  Used by the onTick observer to emit `errored` lines without polluting
   *  stdout (banner discipline — see ADR-0280). */
  readonly stderr?: (s: string) => void
  /** ADR-0453 — OPTIONAL autorun-eligibility gate forwarded onto the slot (and
   *  thence into `tickScheduler`). Absent ⇒ no gate (byte-identical). */
  readonly eligibility?: () => TickEligibilityVerdict
}

/** Minimal env reader port. Matches `EnvPort` in shape but kept local so
 *  this helper imports nothing else from the scheduler types barrel. */
export interface EnvReader {
  get(name: string): string | undefined
}

/**
 * Construct the automation slot from env + deps. Returns `null` when
 * disabled OR when env is malformed (logged + null).
 *
 * Composition-root call site (single touchpoint):
 *
 *   const slot = assembleAutomation(env, { agentLoop })
 *   return { ...base, ...(slot !== null ? { automationEngine: slot } : {}) }
 *
 * The slot's `handler` closes over `deps.agentLoop.enqueueUserMessage` — a
 * fire dispatches the automation's `prompt` exactly the same way the
 * reactor's `manual_resume` does (ADR-0132 voice-match). NO-THROW: the
 * closure rethrows so `tickScheduler` catches and marks `errored`.
 */
export const assembleAutomation = (
  env: EnvReader,
  deps: AssembleAutomationDeps,
): AutomationEngineSlot | null => {
  const flag = env.get(AUTOMATION_ENV_FLAG)
  if (flag !== "on") return null

  const intervalRaw = env.get(AUTOMATION_INTERVAL_ENV)
  const tickIntervalMs = parseInterval(intervalRaw)
  if (tickIntervalMs === null) {
    logger.warn(
      `${AUTOMATION_ENV_FLAG}=on but ${AUTOMATION_INTERVAL_ENV}='${intervalRaw}' is invalid; ` +
        `automation engine disabled. Set a positive integer (default ${DEFAULT_AUTOMATION_INTERVAL_MS}).`,
    )
    return null
  }

  const engine = selectEngine(env, deps)
  const stderrWrite = deps.stderr ?? writeStderr

  // Handler: dispatch the automation's prompt onto the agent loop. The
  // contract with tickScheduler is that any throw here surfaces as
  // `outcome:"errored"` + `kind:"errored"` — we don't swallow.
  const handler: AutomationHandler = async (a) => {
    await deps.agentLoop.enqueueUserMessage(a.prompt)
  }

  // onTick: surface telemetry. Errors go to stderr; idle / fired / engine-
  // error stay silent (the engine's inbox/runs tables already record).
  const onTick = (outcome: TickOutcome): void => {
    if (outcome.kind === "errored") {
      stderrWrite(
        `[automation] errored: id=${outcome.automationId} message=${outcome.errorMessage}\n`,
      )
    }
  }

  const slot: AutomationEngineSlot = {
    engine,
    handler,
    tickIntervalMs,
    onTick,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    // ADR-0453 — forward the optional autorun-eligibility gate onto the slot so
    // the ticker consults it before each fire. Absent ⇒ slot omits it ⇒ tick
    // byte-identical.
    ...(deps.eligibility !== undefined ? { eligibility: deps.eligibility } : {}),
  }
  return slot
}

/**
 * Choose the engine adapter. Precedence:
 *   1. `deps.engine` (explicit override — tests / a host that pre-built one).
 *   2. `QUANTA_AUTOMATION_STORE === "sqlite"` ⇒ the durable SQLite adapter
 *      (via `deps.sqliteEngineFactory` when injected, else the default disk DB).
 *   3. otherwise ⇒ in-memory (default-OFF byte-identical — the legacy path).
 *
 * ONLY the exact canonical value `"sqlite"` flips the store; any other value
 * (unset / "off" / "postgres") falls through to in-memory, so a typo never
 * silently changes durability.
 */
const selectEngine = (env: EnvReader, deps: AssembleAutomationDeps): AutomationEnginePort => {
  if (deps.engine !== undefined) return deps.engine
  if (env.get(AUTOMATION_STORE_ENV) === AUTOMATION_STORE_SQLITE) {
    return (deps.sqliteEngineFactory ?? defaultSqliteEngineFactory)()
  }
  return inMemoryAutomationEngine()
}

/** Default durable-engine factory: open (creating the parent dir) the on-disk
 *  automations DB and build the SQLite adapter over it. */
const defaultSqliteEngineFactory = (): AutomationEnginePort => {
  // A top-level `import { Database }` opens NO connection — only `new Database()`
  // does, and that is reached ONLY here (STORE=sqlite). Default-OFF: this factory
  // is never invoked when the store selector is unset, so importing this module
  // touches no disk.
  const path = defaultAutomationDbPath()
  mkdirSync(dirname(path), { recursive: true })
  return sqliteAutomationEngine(new Database(path))
}

/** Parse the interval env var. Returns the ms when valid (positive, finite,
 *  integer-ish); `null` when explicitly invalid; the default when absent. */
const parseInterval = (raw: string | undefined): number | null => {
  if (raw === undefined || raw === "") return DEFAULT_AUTOMATION_INTERVAL_MS
  const n = Number(raw)
  if (!Number.isFinite(n)) return null
  if (n <= 0) return null
  return Math.floor(n)
}
