/**
 * ADR-0279 — Automation engine composition-root wire.
 *
 * Single helper `assembleAutomation(env, deps)` that constructs the
 * `AutomationEngineSlot` consumed by `AgentConfig.automationEngine`
 * (ADR-0215 engine seam + ADR-0240 loop-helper ticker arm/disarm).
 *
 * Default-OFF: `QUANTA_AUTOMATION` absent or falsy (`0`/`false`/`off`/`no`) ⇒
 * returns `null`; any canonical truthy token (`1`/`on`/`true`/`yes`) activates.
 * An unrecognized token fails CLOSED and warns. The caller's
 * spread-conditional in `apps/agent/index.ts` OMITS the slot — the legacy
 * byte-identical path is preserved (RFC §1.2).
 *
 * NO-THROW: invalid env (bad interval ms, etc.) ⇒ `null` + `logger.warn`.
 * The handler closure rethrows AgentLoopPort errors so `tickScheduler` can
 * mark the run as `errored` — `tickScheduler` itself is no-throw by contract.
 *
 * B2 per-task model reroute: the handler consults the automation's stored
 * `model` / `modelFallbacks` at FIRE time via {@link chooseModel} and dispatches
 * with the chosen model as `modelOverride`. A task with no `model` is
 * byte-identical to the pre-B2 handler (no override). An all-candidates-down
 * outcome throws (⇒ `tickScheduler` records `errored`) rather than silently
 * firing on the host default.
 *
 * Slice: `@/scheduler` (additive helper).
 */

import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { isFalsyToken, isTruthyToken, logger, quantaHomePath, writeStderr } from "@/shared"
import type { AgentEvent } from "@/stream"
import {
  type AutomationEnginePort,
  type AutomationHandler,
  type EngineAutomation,
  inMemoryAutomationEngine,
  sqliteAutomationEngine,
  type TickEligibilityVerdict,
  type TickOutcome,
} from "./automation-engine"
import { chooseModel, rerouteResultToRouteEvent } from "./model-reroute"
import type { AgentLoopPort, ModelAvailabilityPort } from "./types"

/** RFC11-2 — the thin fork seam the fire path drives to fork a bound base
 *  branch. STRUCTURALLY identical to RFC-06 `createPersistentWorktree`
 *  (`@/runtime/worktree-fork`) so the composition root passes that EXACT owner
 *  (the SAME persistent-worktree caller the interactive session-fork uses) with
 *  no adapter — this slice adds NO new git/worktree caller. Kept as a local
 *  structural port (not a value import) so the pure-leaf scheduler slice holds
 *  no runtime edge into `@/runtime`. */
export type WorktreeForkPort = (
  id: string,
  repoRoot: string,
  opts?: { branch?: string; baseRef?: string },
) => Promise<{ worktreePath: string; branch: string }>

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
  /** B2 — OPTIONAL model-availability probe used to reroute a fire onto the
   *  automation's per-task `model` / `modelFallbacks` (ADR-0161 `chooseModel`).
   *  ABSENT ⇒ every candidate is treated as available, so a task with a
   *  configured `model` fires on EXACTLY that model (its first choice); a task
   *  with NO `model` is byte-identical to the pre-B2 path (no override passed).
   *  When injected, the probe drives the fallback chain: the first available
   *  model wins, and an all-unavailable outcome fails the fire (recorded
   *  `errored` by `tickScheduler`) rather than silently running on the wrong
   *  model. */
  readonly modelAvailability?: ModelAvailabilityPort
  /** RFC11-2 — OPTIONAL persistent-worktree fork owner (RFC-06
   *  `createPersistentWorktree`). When wired AND a fired task carries a
   *  `baseBranch`, the handler forks a worktree from that base (via
   *  {@link worktreeRepoRoot}) BEFORE enqueuing the prompt — the SAME owner the
   *  interactive session-fork path uses. ABSENT ⇒ no fork is attempted even for
   *  a base-bound task (the composition root that wants forking injects the
   *  owner); a bindless task never reaches this path (byte-identical). */
  readonly worktreeFork?: WorktreeForkPort
  /** RFC11-2 — repo root the {@link worktreeFork} forks under. REQUIRED for a
   *  base-branch fork to happen; absent ⇒ the fork is skipped (the fire still
   *  succeeds detached). */
  readonly worktreeRepoRoot?: string
  /** Optional clock injection. Default `Date.now`. */
  readonly now?: () => number
  /** Optional stderr writer (test injection). Default `process.stderr.write`.
   *  Used by the onTick observer to emit `errored` lines without polluting
   *  stdout (banner discipline — see ADR-0280). */
  readonly stderr?: (s: string) => void
  /** ADR-0453 — OPTIONAL autorun-eligibility gate forwarded onto the slot (and
   *  thence into `tickScheduler`). Absent ⇒ no gate (byte-identical). */
  readonly eligibility?: () => TickEligibilityVerdict
  /** RFC02-3 (A8) — OPTIONAL model-route transition sink. When wired AND a fire
   *  actually REROUTES onto a fallback (the preference was unavailable), this
   *  scheduler caller PROJECTS its OWN `model_route_changed` AgentEvent
   *  (`routeKind:"scheduler_reroute"`, reason `preferred_unavailable`). Only the
   *  `fallback` arm is a transition — `preference-available` / `all-unavailable`
   *  emit nothing. Default-OFF: absent ⇒ no emit ⇒ byte-identical fire behavior.
   *  The scheduler OWNS the reason; `chooseModel` stays pure. */
  readonly onModelReroute?: (ev: AgentEvent) => void
}

/** Minimal env reader port. Matches `EnvPort` in shape but kept local so
 *  this helper imports nothing else from the scheduler types barrel. */
export interface EnvReader {
  get(name: string): string | undefined
}

/** The dispatch options a FIRED automation carries onto the agent loop.
 *
 *  A unit because every entry obeys one rule for one reason: omitted-when-absent,
 *  so an unbound, modelless, non-heartbeat automation dispatches BYTE-IDENTICALLY
 *  to the pre-B2 / pre-RFC11-2 fire (the caller then drops the whole object when
 *  it has no keys). The heartbeat pair is the part worth naming — a heartbeat
 *  contributes its target thread and inherited policy only when BOTH are
 *  present, never one without the other, because routing onto an existing thread
 *  without re-applying its policy would silently widen that thread's permissions. */
const buildDispatchOpts = (
  a: Parameters<AutomationHandler>[0],
  override: string | undefined,
): NonNullable<Parameters<AgentLoopPort["enqueueUserMessage"]>[1]> => ({
  ...(a.kind === "heartbeat" && a.targetThreadId !== undefined && a.inheritedPolicy !== undefined
    ? { targetThreadId: a.targetThreadId, inheritedPolicy: a.inheritedPolicy }
    : {}),
  ...(override !== undefined ? { modelOverride: override } : {}),
  // RFC11-2 — the fired run ADOPTS the bound role + carries the base it was
  // forked from. Omitted when unbound (byte-identical dispatch).
  ...(a.agentRole !== undefined ? { agentRole: a.agentRole } : {}),
  ...(a.baseBranch !== undefined ? { baseBranch: a.baseBranch } : {}),
})

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
  if (!isTruthyToken(flag)) {
    // P1-1 — activation rides the repo-wide bool vocabulary (`@/shared`
    // GATE_TRUTHY = 1|on|true|yes), not a private `=== "on"`. `/cron`,
    // `/schedule` and `/inbox` all print `hint: set QUANTA_AUTOMATION=1`, and
    // `=1` used to be REFUSED here — the surface named a value the runtime
    // rejected. `=1` is the token every gate accepts (the strict `=== "1"`
    // gates included), so the runtime moved onto the SSOT rather than the hint
    // moving off it.
    //
    // Fail-closed either way, but a token that is neither truthy nor falsy is
    // almost always a typo, and behaving silently like `off` is what makes it
    // expensive to find. Canonical falsy spellings stay silent.
    if (flag !== undefined && flag.trim() !== "" && !isFalsyToken(flag)) {
      logger.warn(
        `${AUTOMATION_ENV_FLAG}='${flag}' is not a recognized boolean; automation engine ` +
          `disabled (fail-closed). Use ${AUTOMATION_ENV_FLAG}=1 (also accepts on/true/yes).`,
      )
    }
    return null
  }

  const intervalRaw = env.get(AUTOMATION_INTERVAL_ENV)
  const tickIntervalMs = parseInterval(intervalRaw)
  if (tickIntervalMs === null) {
    logger.warn(
      `${AUTOMATION_ENV_FLAG}='${flag}' but ${AUTOMATION_INTERVAL_ENV}='${intervalRaw}' is invalid; ` +
        `automation engine disabled. Set a positive integer (default ${DEFAULT_AUTOMATION_INTERVAL_MS}).`,
    )
    return null
  }

  const engine = selectEngine(env, deps)
  const stderrWrite = deps.stderr ?? writeStderr

  // Always-available default: when no probe is injected, every model is
  // "available", so a configured per-task `model` is chosen verbatim (its first
  // choice) and passed as `modelOverride`. A modelless task never invokes this.
  const availability: ModelAvailabilityPort = deps.modelAvailability ?? ALWAYS_AVAILABLE

  // Handler: dispatch the automation's prompt onto the agent loop, rerouting
  // onto the per-task model when the automation carries one (B2). The contract
  // with tickScheduler is that any throw here surfaces as `outcome:"errored"` +
  // `kind:"errored"` — we don't swallow.
  const handler: AutomationHandler = async (a) => {
    const override = await resolveFireModel(a, availability, {
      ...(deps.onModelReroute !== undefined ? { onModelReroute: deps.onModelReroute } : {}),
      now: deps.now ?? Date.now,
    })
    // RFC11-2 — fork the bound git base branch via the REUSED RFC-06 owner
    // BEFORE enqueue. Only entered when the task carries a `baseBranch` AND the
    // fork owner + repo root are wired; otherwise skipped entirely (a bindless
    // task never reaches this — byte-identical). A fork throw surfaces as the
    // ticker's `errored` outcome (we don't swallow), so a failed base fork does
    // not silently fire on the wrong tree.
    await forkBaseBranch(a, {
      ...(deps.worktreeFork !== undefined ? { worktreeFork: deps.worktreeFork } : {}),
      ...(deps.worktreeRepoRoot !== undefined ? { worktreeRepoRoot: deps.worktreeRepoRoot } : {}),
    })
    const dispatchOpts = buildDispatchOpts(a, override)
    await deps.agentLoop.enqueueUserMessage(
      a.prompt,
      Object.keys(dispatchOpts).length > 0 ? dispatchOpts : undefined,
    )
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

/** Availability probe used when the composition root injects none: every model
 *  is available, so a configured per-task `model` is chosen verbatim. This is
 *  what makes the STORED per-task model actually REROUTE the live fire without
 *  requiring a real provider-availability adapter to exist yet. */
const ALWAYS_AVAILABLE: ModelAvailabilityPort = { isAvailable: () => Promise.resolve(true) }

/**
 * Resolve the model an automation should fire on (B2 per-task reroute).
 *
 *   - No per-task `model` ⇒ `undefined`: the fire passes NO `modelOverride`, so
 *     the host uses its global default (byte-identical to the pre-B2 handler).
 *   - A per-task `model` ⇒ probe `[model, ...modelFallbacks]` in order via
 *     {@link chooseModel}; the first available one is returned as the override.
 *   - All candidates unavailable ⇒ THROW so `tickScheduler` records the fire as
 *     `errored` (the task's configured models are down — running it on the
 *     host's default would silently violate the per-task routing contract).
 *
 * `chooseModel` is non-throwing; the throw here is the deliberate translation of
 * its `all-unavailable` arm into the ticker's errored path.
 */
const resolveFireModel = async (
  a: EngineAutomation,
  availability: ModelAvailabilityPort,
  route: { readonly onModelReroute?: (ev: AgentEvent) => void; readonly now: () => number },
): Promise<string | undefined> => {
  if (a.model === undefined) return undefined
  const chosen = await chooseModel({
    preference: a.model,
    fallbacks: a.modelFallbacks ?? [],
    availability,
  })
  if (chosen.reason === "all-unavailable") {
    throw new Error(
      `automation '${a.id}' has no available model (preference '${a.model}' and all fallbacks unavailable)`,
    )
  }
  // RFC02-3 (A8) — project the scheduler-owned route transition when (and only
  // when) the fire actually rerouted onto a fallback. `rerouteResultToRouteEvent`
  // returns `null` for the `preference-available` arm, so no sink call happens
  // unless a real transition occurred. Default-OFF: no `onModelReroute` sink ⇒
  // no emit ⇒ byte-identical. Observability only — never alters the override.
  if (route.onModelReroute !== undefined) {
    const ev = rerouteResultToRouteEvent(
      { preference: a.model, result: chosen },
      { at: route.now() },
    )
    if (ev !== null) route.onModelReroute(ev)
  }
  return chosen.chosen
}

/**
 * RFC11-2 — fork the automation's bound git base branch (if any) via the REUSED
 * RFC-06 `createPersistentWorktree` owner.
 *
 *   - No `baseBranch` on the row ⇒ NO-OP (the base-fork path is never entered;
 *     a bindless fire is byte-identical to the pre-RFC11-2 handler).
 *   - `baseBranch` present but the fork owner / repo root NOT wired ⇒ NO-OP
 *     (the composition root that wants forking injects the owner; a host that
 *     doesn't wire it still fires, detached — no crash).
 *   - `baseBranch` present AND wired ⇒ fork a persistent worktree from that base
 *     (`opts.baseRef = a.baseBranch`) under the automation's id, the SAME owner
 *     the interactive session-fork path uses. A fork throw PROPAGATES (⇒ the
 *     ticker records `errored`) — the fire never silently runs on the wrong
 *     tree.
 */
const forkBaseBranch = async (
  a: EngineAutomation,
  deps: { readonly worktreeFork?: WorktreeForkPort; readonly worktreeRepoRoot?: string },
): Promise<void> => {
  if (a.baseBranch === undefined) return
  if (deps.worktreeFork === undefined || deps.worktreeRepoRoot === undefined) return
  await deps.worktreeFork(a.id, deps.worktreeRepoRoot, { baseRef: a.baseBranch })
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
