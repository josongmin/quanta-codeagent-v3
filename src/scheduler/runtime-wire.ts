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

import { logger, writeStderr } from "@/shared"
import {
  type AutomationEnginePort,
  type AutomationHandler,
  inMemoryAutomationEngine,
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
}

/** Deps for the helper — pure DI. The composition root injects an
 *  `AgentLoopPort` so the handler closure can dispatch the automation
 *  prompt; tests inject fakes for both. */
export interface AssembleAutomationDeps {
  /** Required: the agent-loop seam the handler dispatches to. */
  readonly agentLoop: AgentLoopPort
  /** Optional engine override (tests inject; prod default = in-memory).
   *  A future sqlite path will read `QUANTA_AUTOMATION_STORE=sqlite` and
   *  open a Database here — out of scope for v1. */
  readonly engine?: AutomationEnginePort
  /** Optional clock injection. Default `Date.now`. */
  readonly now?: () => number
  /** Optional stderr writer (test injection). Default `process.stderr.write`.
   *  Used by the onTick observer to emit `errored` lines without polluting
   *  stdout (banner discipline — see ADR-0280). */
  readonly stderr?: (s: string) => void
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

  const engine = deps.engine ?? inMemoryAutomationEngine()
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
  }
  return slot
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
