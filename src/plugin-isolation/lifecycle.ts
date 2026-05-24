/**
 * Plugin lifecycle manager — crash-restart + heartbeat (ADR-0162 Phase D).
 *
 * Wraps a `(spawner, factory)` pair and keeps a {@link PluginHost} alive
 * under a rolling-window restart policy + a heartbeat-based liveness probe.
 *
 * State machine:
 *
 *   starting → running ──────────→ restarting ──→ running ...
 *                  │                    │
 *                  │ stop()             │ exceeded maxRestarts
 *                  ↓                    ↓
 *               stopped               dead
 *
 * Restart policy (rolling window):
 *  - Track crash timestamps in a deque trimmed to `restartWindowMs`.
 *  - If a crash would push the window count past `maxRestarts`, transition
 *    to `"dead"` and do NOT restart. Pending consumers of the lifecycle
 *    receive a typed error.
 *
 * Heartbeat:
 *  - On `heartbeatIntervalMs` cadence, send a `"$/ping"` notification.
 *  - If the child does not respond with `"$/pong"` within
 *    `heartbeatIntervalMs * heartbeatMissThreshold`, treat the child as
 *    dead and kill it (which triggers restart).
 *  - `heartbeatIntervalMs: 0` disables heartbeat entirely (opt-out).
 *
 * DI seams:
 *  - `clock`: function returning epoch-ms, default `Date.now`.
 *  - `setIntervalImpl` / `clearIntervalImpl`: optional, default `setInterval`/
 *    `clearInterval` (test can inject fake timers without monkey-patching
 *    globals).
 */

import { logger, QuantaError } from "@/shared"
import { PluginHost } from "./plugin-host"
import type { IsolatedProcessSpawnerPort, SpawnOpts } from "./types"

export const HEARTBEAT_PING_METHOD = "$/ping"
export const HEARTBEAT_PONG_METHOD = "$/pong"

export interface LifecyclePolicy {
  /** Max number of (re)starts allowed inside `restartWindowMs`. */
  readonly maxRestarts: number
  /** Rolling window for the restart counter. */
  readonly restartWindowMs: number
  /** Heartbeat ping cadence. `0` = disabled. */
  readonly heartbeatIntervalMs: number
  /** How many consecutive heartbeats may be missed before declaring the
   *  child dead. Effective deadline = `heartbeatIntervalMs * heartbeatMissThreshold`. */
  readonly heartbeatMissThreshold: number
}

export const DEFAULT_LIFECYCLE_POLICY: LifecyclePolicy = {
  maxRestarts: 3,
  restartWindowMs: 60_000,
  heartbeatIntervalMs: 10_000,
  heartbeatMissThreshold: 2,
}

export type LifecycleState = "starting" | "running" | "restarting" | "dead" | "stopped" | "idle"

export class LifecycleError extends QuantaError {
  readonly kind: "exceeded-restart-budget" | "stopped" | "spawn-failed"
  constructor(kind: "exceeded-restart-budget" | "stopped" | "spawn-failed", message: string) {
    super("plugin-lifecycle", message)
    this.kind = kind
  }
}

export interface LifecycleOpts {
  readonly policy?: Partial<LifecyclePolicy>
  readonly clock?: () => number
  readonly setIntervalImpl?: typeof setInterval
  readonly clearIntervalImpl?: typeof clearInterval
}

interface IntervalHandle {
  readonly cancel: () => void
}

/** Build / monitor / replace a {@link PluginHost} according to the policy. */
export class PluginLifecycleManager {
  private readonly spawner: IsolatedProcessSpawnerPort
  private readonly factory: () => SpawnOpts
  private readonly policy: LifecyclePolicy
  private readonly clock: () => number
  private readonly setIntervalImpl: typeof setInterval
  private readonly clearIntervalImpl: typeof clearInterval

  private _state: LifecycleState = "idle"
  private currentHost: PluginHost | null = null
  private currentHeartbeat: IntervalHandle | null = null
  private currentPongUnsub: (() => void) | null = null
  private lastPongAt = 0
  private readonly restartTimestamps: number[] = []
  private stopRequested = false

  constructor(
    spawner: IsolatedProcessSpawnerPort,
    factory: () => SpawnOpts,
    opts: LifecycleOpts = {},
  ) {
    this.spawner = spawner
    this.factory = factory
    this.policy = { ...DEFAULT_LIFECYCLE_POLICY, ...(opts.policy ?? {}) }
    this.clock = opts.clock ?? (() => Date.now())
    this.setIntervalImpl = opts.setIntervalImpl ?? setInterval
    this.clearIntervalImpl = opts.clearIntervalImpl ?? clearInterval
  }

  get state(): LifecycleState {
    return this._state
  }

  /** Spawn (or replace) the host. Always returns the active host on success. */
  async start(): Promise<PluginHost> {
    if (this.stopRequested) {
      throw new LifecycleError("stopped", "lifecycle has been stopped; start() rejected")
    }
    if (this._state === "running" && this.currentHost) return this.currentHost
    this._state = "starting"
    try {
      const host = await this.spawnAndAttach()
      this.currentHost = host
      this._state = "running"
      return host
    } catch (e) {
      this._state = "dead"
      throw new LifecycleError("spawn-failed", `lifecycle initial spawn failed: ${String(e)}`)
    }
  }

  /** Stop the lifecycle — politely kill the active host, do not restart. */
  async stop(): Promise<void> {
    this.stopRequested = true
    this._state = "stopped"
    this.teardownHeartbeat()
    const host = this.currentHost
    this.currentHost = null
    if (host) await host.stop()
  }

  // --- internals -----------------------------------------------------------

  private async spawnAndAttach(): Promise<PluginHost> {
    const opts = this.factory()
    const proc = await this.spawner.spawn(opts)
    const host = new PluginHost(proc)
    this.attachExitWatcher(host)
    this.attachHeartbeat(host)
    return host
  }

  private attachExitWatcher(host: PluginHost): void {
    void host.exitPromise.then(
      () => this.onChildExit(host),
      () => this.onChildExit(host),
    )
  }

  private attachHeartbeat(host: PluginHost): void {
    this.teardownHeartbeat()
    if (this.policy.heartbeatIntervalMs <= 0) return
    this.lastPongAt = this.clock()
    this.currentPongUnsub = host.onNotification(HEARTBEAT_PONG_METHOD, () => {
      this.lastPongAt = this.clock()
    })
    const interval = this.policy.heartbeatIntervalMs
    const deadline = interval * this.policy.heartbeatMissThreshold
    const timer = this.setIntervalImpl(() => {
      try {
        host.notify(HEARTBEAT_PING_METHOD, { t: this.clock() })
      } catch {
        // host already stopped
      }
      const silence = this.clock() - this.lastPongAt
      if (silence > deadline) {
        logger.warn("plugin-lifecycle: heartbeat-miss; killing child for restart", {
          silenceMs: silence,
          deadlineMs: deadline,
        })
        void host.stop().catch(() => undefined)
      }
    }, interval)
    // Don't pin the event loop on the heartbeat alone.
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      ;(timer as { unref?: () => void }).unref?.()
    }
    this.currentHeartbeat = {
      cancel: () => this.clearIntervalImpl(timer),
    }
  }

  private teardownHeartbeat(): void {
    if (this.currentHeartbeat) {
      this.currentHeartbeat.cancel()
      this.currentHeartbeat = null
    }
    if (this.currentPongUnsub) {
      this.currentPongUnsub()
      this.currentPongUnsub = null
    }
  }

  private onChildExit(host: PluginHost): void {
    // Ignore late notifications about a host we've already swapped out.
    if (this.currentHost !== host) return
    this.teardownHeartbeat()
    this.currentHost = null
    if (this.stopRequested || this._state === "stopped") return

    const now = this.clock()
    this.trimRestartWindow(now)
    if (this.restartTimestamps.length >= this.policy.maxRestarts) {
      this._state = "dead"
      logger.warn("plugin-lifecycle: restart budget exceeded; lifecycle is dead", {
        attempts: this.restartTimestamps.length,
        windowMs: this.policy.restartWindowMs,
      })
      return
    }
    this.restartTimestamps.push(now)
    this._state = "restarting"
    void this.spawnAndAttach()
      .then((next) => {
        if (this.stopRequested) {
          void next.stop().catch(() => undefined)
          return
        }
        this.currentHost = next
        this._state = "running"
      })
      .catch((e) => {
        logger.warn("plugin-lifecycle: restart spawn failed", { error: String(e) })
        this._state = "dead"
      })
  }

  private trimRestartWindow(now: number): void {
    const cutoff = now - this.policy.restartWindowMs
    while (this.restartTimestamps.length > 0) {
      const ts = this.restartTimestamps[0]
      if (ts !== undefined && ts < cutoff) {
        this.restartTimestamps.shift()
      } else {
        break
      }
    }
  }
}
