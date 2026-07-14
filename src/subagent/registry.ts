import { redactValue } from "@/shared"
import type { SubagentResult } from "./types"

export type TaskStatus = "running" | "completed" | "failed" | "stopped"

/** SUBSTRATE — max chars a UI-crossing preview string carries. Bounded FIRST
 *  (defense against a giant final-text), then secret-scrubbed. */
const PREVIEW_CAP = 240

/** SUBSTRATE — bound + secret-scrub a string before it crosses to a UI. The
 *  bound is applied first so a huge final-text never inflates the event; the
 *  `@/shared` `redactValue` (the OBSERVE SoT) then masks any API-key/token/PEM
 *  material. Whole-string masking is intentional for a security-first preview.
 *  `undefined` in ⇒ `undefined` out (the field is omitted from the event). */
const boundedRedact = (s: string | undefined): string | undefined => {
  if (s === undefined) return undefined
  const bounded = s.length > PREVIEW_CAP ? s.slice(0, PREVIEW_CAP) : s
  const scrubbed = redactValue(bounded)
  return typeof scrubbed === "string" ? scrubbed : bounded
}

/**
 * S17 — Unforgeable per-task capability token. `register()` returns this
 * alongside the task id; the spawner stashes the token and surrenders it
 * back to `stop(id, ownerToken)`. Without the matching token, `stop()`
 * refuses — a sibling subagent that learns another's `id` cannot DoS-cancel
 * it. Generated via `crypto.randomUUID()` so the token is 128-bit unguessable.
 */
export type TaskOwnerToken = string & { readonly __taskOwner: unique symbol }

export interface TaskRecord {
  id: string
  description: string
  agentType?: string
  status: TaskStatus
  /** Set once the task settles (completed/failed/stopped). */
  result?: SubagentResult
  /** Failure message when status === "failed". */
  error?: string
  startedAt: number
  endedAt?: number
  /** Multi-agent-panel SUBSTRATE (lineage edge). The registry TASK ID of the
   *  agent that spawned THIS task. `undefined` ⇒ this is a ROOT-LEVEL task
   *  (spawned directly by the root session agent, which is itself not a task).
   *  Populated by the runner from the spawning parent's `spawnedAsTaskId`
   *  (`AgentConfig.spawnedAsTaskId`), so `list()` reconstructs a real
   *  parent→child TREE — NOT a flat list. Absent on the legacy/foreground path
   *  that predates lineage wiring (byte-identical). */
  parentTaskId?: string
  /** SUBSTRATE — the child's spawn depth from `childDepthOf(parent)` (root's
   *  direct child = 1). Present on every record registered through the runner.
   *  Defaults to 0 when a caller registers directly without a depth (legacy). */
  depth: number
  /** SUBSTRATE — the deterministic mailbox label of the spawned agent
   *  (`parentLabel/ordinal`, e.g. `root/0`), when the runner minted one. Absent
   *  on the legacy/foreground path (byte-identical). Surfaced to the panel so a
   *  node can show its stable address. */
  mailboxLabel?: string
}

/**
 * SUBSTRATE — subagent lifecycle event the registry emits at each TRANSITION,
 * consumed by BOTH the CLI `/agents --tree` and the web Sub-Agents panel (later
 * waves) via the `@/protocol/subagent` projection. Structurally MIRRORS the
 * `subagent_spawn` / `subagent_status` arms of `@/stream`'s `AgentEvent` union
 * — the slice may NOT import `@/stream` (leaf isolation), so the shape is
 * duck-declared here and pinned byte-identical by the stream-side drift guard.
 * REDACTION happens at emit time (bounded + secret-scrubbed) since this crosses
 * to a UI.
 */
export type SubagentLifecycleEvent =
  | {
      type: "subagent_spawn"
      taskId: string
      parentTaskId?: string
      depth: number
      description: string
      agentType?: string
      at: number
    }
  | {
      type: "subagent_status"
      taskId: string
      status: TaskStatus
      at: number
      turns?: number
      finalTextPreview?: string
      error?: string
    }

/** SUBSTRATE — the registry's optional emit sink. When wired (from
 *  `AgentConfig.onSubagentEvent`, mirroring `onAgentState`), the registry hands
 *  each redacted transition here. Absent ⇒ NO emit (byte-identical OFF). */
export type SubagentEventEmitter = (event: SubagentLifecycleEvent) => void

/** Default cap on retained SETTLED records before LRU eviction kicks in.
 *  Running tasks are never evicted regardless of count — only settled ones are
 *  reclaimed, oldest `endedAt` first. 256 fits typical long sessions without
 *  unbounded growth; override via constructor for tests or extreme workloads. */
const DEFAULT_MAX_RETAINED = 256

export interface TaskRegistryOptions {
  /** Upper bound on retained SETTLED records (default 256). Running tasks
   *  never count toward the cap and are never evicted. When the settled
   *  count exceeds the cap, oldest-by-`endedAt` are dropped. */
  maxRetained?: number
}

/**
 * In-memory registry of background subagent tasks (v2's `taskRegistry`). The
 * Agent tool registers a task here when launched in background mode and
 * resolves it when the forked runner settles; `TaskOutput`/`TaskStop` observe
 * and cancel by id. Lives for the process — not persisted.
 *
 * Three seams the tools rely on:
 *   1. `register()` returns the per-task {@link AbortController}. Callers
 *      MUST plumb its `.signal` into the runner's request (via
 *      `SubagentRequest.signal`) so `stop(id)` actually unwinds the child.
 *      Discarding the controller is the historical bug class this fixed.
 *   2. `waitForSettle(id)` returns a Promise that resolves the instant the
 *      task transitions to a terminal status — event-driven, no busy poll.
 *   3. `pendingIds()` enumerates currently-running task ids — the session
 *      cleanup path uses this to stop+await all in-flight children on
 *      graceful shutdown.
 *
 * Settled-record GC: bounded by `maxRetained` (default 256). When the settled
 * count exceeds the cap, oldest-`endedAt`-first eviction reclaims space.
 * Running tasks are never evicted.
 */
export class TaskRegistry {
  private readonly tasks = new Map<string, TaskRecord>()
  private readonly aborters = new Map<string, AbortController>()
  private readonly settlers = new Map<string, { promise: Promise<void>; resolve: () => void }>()
  /** S17: per-task owner token. The map IS the capability table — only the
   *  caller of `register()` knows the token, so only that caller can
   *  successfully stop the task. Tokens are deleted on settle. */
  private readonly owners = new Map<string, TaskOwnerToken>()
  /** Live fire-and-forget child-runner promises. A spawn site registers its
   *  `runner(req).then(complete).catch(fail)` chain here so session cleanup can
   *  AWAIT the actual runner unwind — not just the settler, which `forceStop`
   *  resolves synchronously while the runner promise is still in flight. A
   *  tracked promise removes itself once it settles, so the set self-trims. */
  private readonly runnerPromises = new Set<Promise<void>>()
  private readonly maxRetained: number
  /** SUBSTRATE — optional lifecycle emit sink. Wired from
   *  `AgentConfig.onSubagentEvent` (mirror of `onAgentState`) via the runner.
   *  Absent ⇒ NO emit at any transition (byte-identical OFF). */
  private emitter: SubagentEventEmitter | undefined

  constructor(opts: TaskRegistryOptions = {}) {
    this.maxRetained = opts.maxRetained ?? DEFAULT_MAX_RETAINED
  }

  /** SUBSTRATE — install (or clear) the lifecycle emit sink. Idempotent; the
   *  runner calls this once per session when the host wired `onSubagentEvent`.
   *  A throwing sink never breaks a transition — every emit is guarded. */
  setEmitter(emitter: SubagentEventEmitter | undefined): void {
    this.emitter = emitter
  }

  /** Fan a lifecycle event to the wired sink, swallowing any throw (a
   *  misbehaving UI forwarder must never corrupt a spawn/settle transition). */
  private emit(event: SubagentLifecycleEvent): void {
    if (this.emitter === undefined) return
    try {
      this.emitter(event)
    } catch {
      // observation-only channel — never propagate into the registry mutation.
    }
  }

  /** SUBSTRATE — emit a `subagent_status` transition for a task that has just
   *  settled. `finalTextPreview` is sourced from the settled record's result
   *  (when present) and `error` from its error; both are bounded + secret-
   *  scrubbed via {@link boundedRedact}. `turns` rides from the result. */
  private emitStatus(t: TaskRecord, at: number): void {
    if (this.emitter === undefined) return
    const preview = boundedRedact(t.result?.finalText)
    const err = boundedRedact(t.error)
    this.emit({
      type: "subagent_status",
      taskId: t.id,
      status: t.status,
      at,
      ...(t.result?.turns !== undefined ? { turns: t.result.turns } : {}),
      ...(preview !== undefined ? { finalTextPreview: preview } : {}),
      ...(err !== undefined ? { error: err } : {}),
    })
  }

  /** Mint a fresh, unique task id. Uses `crypto.randomUUID()` (Bun + Node
   *  ≥19): collision-resistant regardless of clock granularity. The
   *  `task_<uuid>` shape keeps log lines greppable. */
  newId(): string {
    return `task_${crypto.randomUUID()}`
  }

  /** Registration returns `{abort, ownerToken}`. The caller MUST surface the
   *  token back to whatever entity is allowed to cancel the task (e.g. the
   *  LLM, by including it in the `task_run` tool result). Without the
   *  matching token, `stop()` refuses. */
  register(rec: Omit<TaskRecord, "status" | "startedAt" | "depth"> & { depth?: number }): {
    abort: AbortController
    ownerToken: TaskOwnerToken
  } {
    const ac = new AbortController()
    // SUBSTRATE — `depth` defaults to 0 (a caller that predates lineage wiring
    // registers a root-level record). `parentTaskId`/`mailboxLabel` ride
    // through the spread when the runner supplied them.
    const startedAt = Date.now()
    const depth = rec.depth ?? 0
    this.tasks.set(rec.id, { ...rec, depth, status: "running", startedAt })
    this.aborters.set(rec.id, ac)
    let resolve!: () => void
    const promise = new Promise<void>((r) => {
      resolve = r
    })
    this.settlers.set(rec.id, { promise, resolve })
    const ownerToken = crypto.randomUUID() as TaskOwnerToken
    this.owners.set(rec.id, ownerToken)
    // SUBSTRATE — spawn transition. `description` is bounded + secret-scrubbed
    // HERE (`boundedRedact`) since this crosses to a UI. Absent emitter ⇒ no-op
    // (byte-identical).
    this.emit({
      type: "subagent_spawn",
      taskId: rec.id,
      ...(rec.parentTaskId !== undefined ? { parentTaskId: rec.parentTaskId } : {}),
      depth,
      description: boundedRedact(rec.description) ?? "",
      ...(rec.agentType !== undefined ? { agentType: rec.agentType } : {}),
      at: startedAt,
    })
    return { abort: ac, ownerToken }
  }

  get(id: string): TaskRecord | undefined {
    return this.tasks.get(id)
  }

  list(): TaskRecord[] {
    return [...this.tasks.values()]
  }

  /** Ids of tasks currently in the "running" state. Stable snapshot — caller
   *  may mutate via `stop()` while iterating the returned array. */
  pendingIds(): string[] {
    const out: string[] = []
    for (const t of this.tasks.values()) {
      if (t.status === "running") out.push(t.id)
    }
    return out
  }

  complete(id: string, result: SubagentResult): void {
    const t = this.tasks.get(id)
    if (!t || t.status !== "running") return
    t.status = result.ok ? "completed" : "failed"
    t.result = result
    if (!result.ok) t.error = result.finalText
    t.endedAt = Date.now()
    this.aborters.delete(id)
    this.settlers.get(id)?.resolve()
    this.settlers.delete(id)
    this.owners.delete(id)
    // SUBSTRATE — status transition (completed OR failed). Emitted BEFORE the
    // GC pass so an evict-on-cap never suppresses the terminal event.
    this.emitStatus(t, t.endedAt)
    this.evictIfOverCap()
  }

  fail(id: string, error: string): void {
    const t = this.tasks.get(id)
    if (!t || t.status !== "running") return
    t.status = "failed"
    t.error = error
    t.endedAt = Date.now()
    this.emitStatus(t, t.endedAt)
    this.aborters.delete(id)
    this.settlers.get(id)?.resolve()
    this.settlers.delete(id)
    this.owners.delete(id)
    this.evictIfOverCap()
  }

  /** Cancel a running task — REQUIRES the owner token returned by
   *  `register()`. A sibling agent that learns the `id` cannot cancel the
   *  task without the matching token. Returns one of:
   *    - "stopped"      — task was running AND the token matched
   *    - "denied"       — task exists but the supplied token is wrong/missing
   *    - "not-found"    — id unknown or task already settled
   *
   *  This is the structural fix for the task_stop DoS surface: capability
   *  control, not "any caller can stop any id". */
  stop(id: string, ownerToken: string): "stopped" | "denied" | "not-found" {
    const t = this.tasks.get(id)
    if (!t || t.status !== "running") return "not-found"
    const expected = this.owners.get(id)
    if (expected === undefined || ownerToken !== expected) return "denied"
    this.aborters.get(id)?.abort()
    t.status = "stopped"
    t.endedAt = Date.now()
    this.aborters.delete(id)
    this.settlers.get(id)?.resolve()
    this.settlers.delete(id)
    this.owners.delete(id)
    this.emitStatus(t, t.endedAt)
    this.evictIfOverCap()
    return "stopped"
  }

  /** Force-cancel a running task without an owner token. ONLY callable by
   *  the session-lifecycle owner (e.g. agent shutdown `cleanupSession`) —
   *  the public LLM-facing `task_stop` tool MUST go through {@link stop}.
   *
   *  This separation is the structural distinction: capability for the LLM
   *  (token-gated), authority for the host (named method, not name-gated). */
  forceStop(id: string): boolean {
    const t = this.tasks.get(id)
    if (!t || t.status !== "running") return false
    this.aborters.get(id)?.abort()
    t.status = "stopped"
    t.endedAt = Date.now()
    this.aborters.delete(id)
    this.settlers.get(id)?.resolve()
    this.settlers.delete(id)
    this.owners.delete(id)
    this.emitStatus(t, t.endedAt)
    this.evictIfOverCap()
    return true
  }

  /** Track a spawn site's fire-and-forget child-runner promise so {@link
   *  drainRunners} can await its full unwind at session shutdown. The supplied
   *  promise MUST already be terminal-safe (i.e. the spawn site has attached its
   *  own `.then(complete).catch(fail)`); this method swallows any rejection of
   *  the tracked chain so a late child error can never surface as an
   *  unhandledRejection here. The promise self-removes once it settles. */
  trackRunner(p: Promise<unknown>): void {
    // Normalize to a never-rejecting `Promise<void>` so the set only holds
    // settle markers — drain awaits completion, never failure.
    const marker: Promise<void> = p.then(
      () => undefined,
      () => undefined,
    )
    this.runnerPromises.add(marker)
    void marker.then(() => {
      this.runnerPromises.delete(marker)
    })
  }

  /** Await every currently-tracked child-runner promise. Snapshot-then-await so
   *  a runner that spawns another during unwind doesn't extend this drain
   *  unboundedly. Resolves immediately when nothing is in flight. Never rejects
   *  (each tracked marker is rejection-swallowed in {@link trackRunner}). */
  drainRunners(): Promise<void> {
    if (this.runnerPromises.size === 0) return Promise.resolve()
    return Promise.all([...this.runnerPromises]).then(() => undefined)
  }

  /** Event-driven settle notifier. Returns a Promise that resolves the
   *  instant `complete`/`fail`/`stop` is called for `id`. If the task is
   *  unknown or already settled, resolves immediately. No timer; the caller
   *  composes timeout via `Promise.race`. */
  waitForSettle(id: string): Promise<void> {
    const t = this.tasks.get(id)
    if (!t || t.status !== "running") return Promise.resolve()
    return this.settlers.get(id)?.promise ?? Promise.resolve()
  }

  /** Drop oldest-`endedAt` settled records until the settled count is under
   *  the cap. Running tasks are never evicted. O(N log N) on overflow, O(1)
   *  on the common path (no overflow). */
  private evictIfOverCap(): void {
    const settled: TaskRecord[] = []
    for (const t of this.tasks.values()) {
      if (t.status !== "running") settled.push(t)
    }
    if (settled.length <= this.maxRetained) return
    settled.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
    const drop = settled.length - this.maxRetained
    for (let i = 0; i < drop; i++) {
      const t = settled[i]
      if (t) this.tasks.delete(t.id)
    }
  }
}
