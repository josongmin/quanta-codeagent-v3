/** MCP crash-detection + auto-restart supervisor (ADR-0435).
 *
 *  Absorbs Cursor's reconnect lifecycle (`mcpProcessMain.js`) as a *policy*
 *  layer: it detects a transport/process exit, schedules a backoff, re-spawns
 *  the client, re-runs `initialize` + `tools/list`, and swaps the live client
 *  behind a stable indirection so bridged tools keep working across restarts.
 *
 *  Closed-port: `now`/`setTimer`/`random`/`factory` are all injected. There are
 *  NO real timers and NO global RNG/clock here — every test runs on a fake
 *  clock. Default-OFF: the supervisor only exists when the CLI wire opts in
 *  (`QUANTA_MCP_AUTORESTART=1`); absent it, MCP behavior is byte-identical.
 *
 *  State machine (RFC §4.3):
 *    healthy → (onExit) crashed → backing-off → restarting → healthy
 *                                       ↑__________________|  (restart fails, cap not hit)
 *    cap exhausted (maxFastAttempts then maxPeriodicCycles) → degraded (give-up). */

import { errMessage } from "@/shared"
import { McpError } from "../client"
import type { McpProgressHandler } from "../progress"
import type {
  McpPrompt,
  McpPromptResult,
  McpResource,
  McpResourceContent,
  McpResult,
} from "../resources/port"
import type { McpCallResult, McpServerConfig, McpToolDef } from "../types"
import { type BackoffPolicy, backoffDelay } from "./policy"
import type { McpClientFactory, SupervisableMcpClient } from "./port"

export type SupervisorState = "healthy" | "crashed" | "backing-off" | "restarting" | "degraded"

/** Pending-call policy while the client is not HEALTHY (RFC §4.5). */
export type PendingPolicy = "fail-fast" | "queue"

export interface SupervisorDeps {
  /** Builds a fresh client on each (re)start. */
  readonly factory: McpClientFactory
  /** Backoff timing + storm caps. */
  readonly policy: BackoffPolicy
  /** Injected monotonic-ish clock (ms). */
  readonly now: () => number
  /** Injected timer; returns a cancel fn so backoff/queue waits leak nothing. */
  readonly setTimer: (fn: () => void, ms: number) => () => void
  /** Jitter source for {@link backoffDelay}. Default `Math.random` (only the
   *  CLI wire ever uses the default; tests always inject). */
  readonly random?: () => number
  /** Observe state transitions (logging / status pill). Side-effect-free wrt
   *  the supervisor; must not throw (defensive guard wraps it). */
  readonly onStateChange?: (s: SupervisorSnapshot) => void
  /** While not HEALTHY, fail immediately (default) or wait up to
   *  {@link queueWaitMaxMs} for recovery. */
  readonly pendingPolicy?: PendingPolicy
  /** Max wait for "queue" mode; 0 (default) ⇒ behaves as fail-fast. */
  readonly queueWaitMaxMs?: number
}

export interface SupervisorSnapshot {
  readonly serverName: string
  readonly state: SupervisorState
  readonly fastAttempt: number
  readonly periodicCycle: number
  /** Bumps on every restart attempt + on stop(). Cursor connectionGeneration
   *  absorbed: a late async `start()` whose epoch no longer matches is discarded. */
  readonly restartEpoch: number
  /** Last startup failure reason. Cursor lastStartupDiagnostic absorbed. */
  readonly lastDiagnostic?: string
  /** When BACKING_OFF, the scheduled delay until the next restart attempt. */
  readonly nextRetryInMs?: number
}

export class McpReconnectSupervisor {
  private readonly config: McpServerConfig
  private readonly deps: SupervisorDeps
  private readonly random: () => number
  private readonly pendingPolicy: PendingPolicy
  private readonly queueWaitMaxMs: number

  private client: SupervisableMcpClient
  private unsubscribeExit: (() => void) | null = null
  private state: SupervisorState = "healthy"
  private fastAttempt = 0
  private periodicCycle = 0
  private restartEpoch = 0
  private lastDiagnostic: string | undefined
  private nextRetryInMs: number | undefined
  private restartedAt: number
  private cancelTimer: (() => void) | null = null
  private stopped = false
  /** FIFO of callers parked in "queue" mode waiting for HEALTHY. */
  private readonly waiters = new Set<() => void>()

  private constructor(
    config: McpServerConfig,
    deps: SupervisorDeps,
    client: SupervisableMcpClient,
  ) {
    this.config = config
    this.deps = deps
    this.random = deps.random ?? Math.random
    this.pendingPolicy = deps.pendingPolicy ?? "fail-fast"
    this.queueWaitMaxMs = deps.queueWaitMaxMs ?? 0
    this.client = client
    this.restartedAt = deps.now()
  }

  /** Create + start the first client. A failed first start does NOT throw: the
   *  supervisor enters backoff and retries (RFC §7 "startup 즉사하는 서버"),
   *  matching the auto-restart contract. The caller still gets a started
   *  supervisor whose tools fail-fast until a restart succeeds. */
  static async create(
    config: McpServerConfig,
    deps: SupervisorDeps,
  ): Promise<McpReconnectSupervisor> {
    const client = deps.factory(config)
    const sup = new McpReconnectSupervisor(config, deps, client)
    sup.subscribeExit()
    try {
      await client.start()
      sup.toHealthy()
    } catch (e) {
      sup.lastDiagnostic = errMessage(e)
      // First start failed → treat like a restart failure and schedule backoff.
      sup.onStartFailure()
    }
    return sup
  }

  /** Always the current live client. */
  current(): SupervisableMcpClient {
    return this.client
  }

  snapshot(): SupervisorSnapshot {
    return {
      serverName: this.config.name,
      state: this.state,
      fastAttempt: this.fastAttempt,
      periodicCycle: this.periodicCycle,
      restartEpoch: this.restartEpoch,
      ...(this.lastDiagnostic !== undefined ? { lastDiagnostic: this.lastDiagnostic } : {}),
      ...(this.nextRetryInMs !== undefined ? { nextRetryInMs: this.nextRetryInMs } : {}),
    }
  }

  async listTools(): Promise<McpToolDef[]> {
    return this.client.listTools()
  }

  /** Indirection entry point for bridged tools. Applies the pending-call policy
   *  then delegates to the current live client. */
  async callTool(
    name: string,
    args: unknown,
    opts?: { onProgress?: McpProgressHandler },
  ): Promise<McpCallResult> {
    if (this.state !== "healthy") {
      await this.awaitHealthyOrFail()
    }
    // §19.4 — forward the per-call progress sink to the live client. Absent ⇒
    // byte-identical to the pre-progress delegate.
    return this.client.callTool(name, args, opts)
  }

  /** ADR-0435 follow-up — does the CURRENT live client's server advertise the
   *  `tasks/*` capability? Read per call (never captured) so a restart that
   *  swaps the live client re-evaluates against the new one. A client that does
   *  not expose `serverSupportsTasks` (e.g. the isolated client) ⇒ `false`,
   *  keeping the tasks surface absent (byte-identical default-OFF). */
  serverSupportsTasks(): boolean {
    return this.client.serverSupportsTasks?.() ?? false
  }

  /** ADR-0435 follow-up — outbound `tasks/*` dispatch. The indirection mirror of
   *  {@link callTool}: applies the pending-call policy, then dispatches through
   *  the CURRENT live client. Because it re-resolves `this.client` on every call,
   *  a `supervisedTasksToolsFor` handle bound to this supervisor never goes stale
   *  across a restart. Throws if the current client does not support `requestRaw`
   *  (same `is not running` McpError contract). */
  async requestRaw(method: string, params?: unknown): Promise<unknown> {
    if (this.state !== "healthy") {
      await this.awaitHealthyOrFail()
    }
    const fn = this.client.requestRaw
    if (fn === undefined) {
      throw new McpError(`mcp server "${this.config.name}" does not support tasks`)
    }
    return fn.call(this.client, method, params)
  }

  // --- jun-06 RFC: resources/prompts over the supervised path --------------

  /** Does the CURRENT live client's server advertise `resources/*`? Read per call
   *  (never captured) so a restart swap re-evaluates against the new client.
   *  Mirrors {@link serverSupportsTasks}: a client lacking the method ⇒ `false`
   *  (byte-identical default-OFF). */
  serverSupportsResources(): boolean {
    return this.client.serverSupportsResources?.() ?? false
  }

  /** Does the CURRENT live client's server advertise `prompts/*`? Read per call,
   *  mirroring {@link serverSupportsResources}. */
  serverSupportsPrompts(): boolean {
    return this.client.serverSupportsPrompts?.() ?? false
  }

  /** Proxy `resources/list` through the current live client. NO-THROW: during the
   *  reconnect gap (`backing-off`/`restarting`/`degraded`) the pending-call policy
   *  yields a typed `transport` failure instead of a bare throw, so the N3
   *  aggregate keeps its no-throw contract. Mirrors {@link callTool}/{@link requestRaw}. */
  async listResources(): Promise<McpResult<McpResource[]>> {
    return this.proxyResources((c) =>
      c.listResources
        ? () => (c.listResources as () => Promise<McpResult<McpResource[]>>)()
        : undefined,
    )
  }

  /** Proxy `resources/read` through the current live client. See {@link listResources}. */
  async readResource(uri: string): Promise<McpResult<McpResourceContent[]>> {
    return this.proxyResources((c) =>
      c.readResource
        ? () => (c.readResource as (u: string) => Promise<McpResult<McpResourceContent[]>>)(uri)
        : undefined,
    )
  }

  /** Proxy `prompts/list` through the current live client. See {@link listResources}. */
  async listPrompts(): Promise<McpResult<McpPrompt[]>> {
    return this.proxyResources((c) =>
      c.listPrompts ? () => (c.listPrompts as () => Promise<McpResult<McpPrompt[]>>)() : undefined,
    )
  }

  /** Proxy `prompts/get` through the current live client. See {@link listResources}. */
  async getPrompt(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<McpResult<McpPromptResult>> {
    return this.proxyResources((c) =>
      c.getPrompt
        ? () =>
            (
              c.getPrompt as (
                n: string,
                a?: Record<string, unknown>,
              ) => Promise<McpResult<McpPromptResult>>
            )(name, args)
        : undefined,
    )
  }

  /** The load-bearing reconnect-gap contract for every resources/prompts proxy.
   *  Three windows, all TYPED-FAILURE, NEVER-THROW:
   *   - `healthy` ⇒ delegate to the live client; its own no-throw `McpResult`
   *     is returned verbatim.
   *   - not-`healthy` ⇒ `awaitHealthyOrFail` applies the pending policy
   *     (fail-fast default throws `McpError`; queue parks up to `queueWaitMaxMs`);
   *     a throw is CAUGHT and mapped to a typed `transport` failure so the N3
   *     aggregate (no-throw by contract) never sees an exception.
   *   - the live client lacks the method ⇒ typed `unsupported` (mirrors
   *     `serverSupportsTasks` ⇒ false), never a null-deref.
   *  A `select` returning `undefined` means the method is absent on this client.
   *  The final delegate is also try/caught so a non-conforming client that throws
   *  can never leak into the aggregate. */
  private async proxyResources<T>(
    select: (c: SupervisableMcpClient) => (() => Promise<McpResult<T>>) | undefined,
  ): Promise<McpResult<T>> {
    if (this.state !== "healthy") {
      try {
        await this.awaitHealthyOrFail()
      } catch (e) {
        return { ok: false, reason: "transport", message: errMessage(e) }
      }
    }
    const fn = select(this.client)
    if (fn === undefined) {
      return {
        ok: false,
        reason: "unsupported",
        message: `mcp server "${this.config.name}" does not support resources/prompts`,
      }
    }
    try {
      return await fn()
    } catch (e) {
      return { ok: false, reason: "transport", message: errMessage(e) }
    }
  }

  /** Permanent stop. Cancels any backoff/queue timers, bumps the epoch so a
   *  late restart is discarded, and stops the live client. Idempotent. */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.restartEpoch += 1 // stale-guard: any in-flight restart is now orphaned
    this.cancelTimer?.()
    this.cancelTimer = null
    this.unsubscribeExit?.()
    this.unsubscribeExit = null
    this.releaseWaiters()
    await this.client.stop().catch(() => undefined)
  }

  // --- internals -----------------------------------------------------------

  private subscribeExit(): void {
    this.unsubscribeExit = this.client.onExit((reason) => this.onCrash(reason))
  }

  private onCrash(reason?: string): void {
    if (this.stopped) return
    // Only a HEALTHY client can crash into the lifecycle; an exit during
    // backing-off/restarting is from an old client we already abandoned.
    if (this.state !== "healthy") return
    // Stability reset (RFC §4.3, lazy): if the server stayed up at least
    // stabilityThresholdMs since its last (re)start, the next crash starts a
    // fresh fast-retry. Compared with `>=` so a non-advancing clock is safe.
    if (this.deps.now() - this.restartedAt >= this.deps.policy.stabilityThresholdMs) {
      this.fastAttempt = 0
      this.periodicCycle = 0
    }
    this.lastDiagnostic = reason
    this.transition("crashed")
    this.scheduleRestart()
  }

  private scheduleRestart(): void {
    if (this.stopped) return
    const { policy } = this.deps
    const inFastPhase = this.fastAttempt < policy.maxFastAttempts
    const attempt = inFastPhase ? this.fastAttempt : this.periodicCycle
    const baseMs = inFastPhase ? policy.fastRetryBaseMs : policy.periodicBaseMs
    const maxMs = inFastPhase ? policy.fastRetryMaxMs : policy.periodicMaxMs
    const delay = backoffDelay(attempt, baseMs, maxMs, this.random)
    this.nextRetryInMs = delay
    this.transition("backing-off")
    const epochAtSchedule = this.restartEpoch
    this.cancelTimer = this.deps.setTimer(() => {
      this.cancelTimer = null
      // Stale guard: if stop() (or another restart) bumped the epoch, abandon.
      if (this.stopped || this.restartEpoch !== epochAtSchedule) return
      void this.attemptRestart()
    }, delay)
  }

  private async attemptRestart(): Promise<void> {
    this.nextRetryInMs = undefined
    this.transition("restarting")
    this.restartEpoch += 1
    const epoch = this.restartEpoch
    const fresh = this.deps.factory(this.config)
    try {
      await fresh.start()
      // Re-run tools/list so a non-advertising server is detected as a failed
      // restart rather than a silent half-up client.
      await fresh.listTools()
    } catch (e) {
      this.lastDiagnostic = errMessage(e)
      // If stop() or a newer restart superseded us, discard this orphan client.
      if (this.stopped || this.restartEpoch !== epoch) {
        await fresh.stop().catch(() => undefined)
        return
      }
      await fresh.stop().catch(() => undefined)
      this.onStartFailure()
      return
    }
    // Success — but a concurrent stop()/restart may have superseded us.
    if (this.stopped || this.restartEpoch !== epoch) {
      await fresh.stop().catch(() => undefined)
      return
    }
    // Swap the live client behind the stable indirection.
    this.unsubscribeExit?.()
    this.client = fresh
    this.unsubscribeExit = fresh.onExit((reason) => this.onCrash(reason))
    this.toHealthy()
  }

  /** A (re)start attempt failed: advance the phase counters and either schedule
   *  another backoff or give up (DEGRADED). */
  private onStartFailure(): void {
    if (this.stopped) return
    const { policy } = this.deps
    if (this.fastAttempt < policy.maxFastAttempts) {
      // Still in the fast phase: count this failed attempt and re-schedule. The
      // next scheduleRestart() re-reads fastAttempt to pick fast vs periodic
      // base/max, so crossing the cap here naturally moves us to periodic.
      this.fastAttempt += 1
      this.scheduleRestart()
      return
    }
    // Periodic phase: count this cycle; give up permanently once the cap is hit.
    this.periodicCycle += 1
    if (this.periodicCycle >= policy.maxPeriodicCycles) {
      this.transition("degraded")
      this.releaseWaiters()
      return
    }
    this.scheduleRestart()
  }

  private toHealthy(): void {
    this.restartedAt = this.deps.now()
    this.nextRetryInMs = undefined
    this.transition("healthy")
    this.releaseWaiters()
  }

  private transition(state: SupervisorState): void {
    this.state = state
    const cb = this.deps.onStateChange
    if (cb === undefined) return
    try {
      cb(this.snapshot())
    } catch {
      // Observation must never break the lifecycle.
    }
  }

  /** Pending-call policy. fail-fast (default) throws the byte-identical
   *  "is not running" error today's callers already see. queue mode parks the
   *  caller up to queueWaitMaxMs for HEALTHY recovery (at-most-once: it waits
   *  BEFORE the call goes on the wire). DEGRADED fails immediately. */
  private async awaitHealthyOrFail(): Promise<void> {
    const notRunning = (): McpError =>
      new McpError(`mcp server "${this.config.name}" is not running`)
    if (this.state === "degraded") throw notRunning()
    if (this.pendingPolicy !== "queue" || this.queueWaitMaxMs <= 0) throw notRunning()

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const waiter = (): void => {
        if (settled) return
        settled = true
        this.waiters.delete(waiter)
        cancel()
        if (this.state === "healthy") resolve()
        else reject(notRunning())
      }
      const cancel = this.deps.setTimer(() => {
        if (settled) return
        settled = true
        this.waiters.delete(waiter)
        reject(notRunning())
      }, this.queueWaitMaxMs)
      this.waiters.add(waiter)
    })
    // Re-check after wake: HEALTHY ⇒ proceed; anything else ⇒ fail-fast.
    if (this.state !== "healthy") throw notRunning()
  }

  /** Wake every parked queue-waiter (on HEALTHY recovery, DEGRADED, or stop).
   *  Each waiter re-checks state and resolves or rejects accordingly. */
  private releaseWaiters(): void {
    const snapshot = Array.from(this.waiters)
    this.waiters.clear()
    for (const w of snapshot) w()
  }
}
