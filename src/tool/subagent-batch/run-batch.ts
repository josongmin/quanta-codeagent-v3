/**
 * RFC-02 §5.4–5.5 — the batch worker pool.
 *
 * A self-contained, one-shot blocking job built on the INJECTED runner +
 * an inline admission semaphore (no `p-limit` dependency, no real timers — the
 * per-item hang race uses the injected clock via a setTimeout that is the ONLY
 * timer and is unconditionally cleared). Concurrency is bounded by an explicit
 * cap; partial failures are isolated; `ctx.signal` cancellation unwinds
 * in-flight children and short-circuits not-yet-started ones.
 *
 * Determinism: per-item results are ALWAYS sorted by input index, never by
 * completion order.
 */

import { errMessage } from "@/shared"
import type {
  BatchItemResult,
  BatchRunResult,
  BatchSubagentRunner,
  BatchTimeoutPolicy,
  SubagentBatchDeps,
} from "./port"
import { clampBatchTimeout } from "./port"
import type { BatchItem } from "./template"
import { renderTemplate } from "./template"

export interface RunBatchArgs {
  readonly items: readonly BatchItem[]
  readonly promptTemplate: string
  readonly maxConcurrency?: number
  readonly perItemTimeoutMs?: number
  readonly idField?: string
  readonly maxTurns?: number
  /** Parent-side JSON-shape validation. When set, each worker's finalText is
   *  parsed as JSON and shallow-checked to be an object whose top-level keys
   *  cover every key declared here; violations mark JUST that item error. */
  readonly outputSchema?: Record<string, unknown>
}

export interface RunBatchDeps extends SubagentBatchDeps {
  /** Per-item progress callback (deterministic, called on each settle). The
   *  tool wraps this to emit `ToolEvent` progress. */
  readonly onProgress?: (done: number, total: number, failed: number) => void
}

/** Derive the stable item id: `id_field` value (object items) else String(index). */
const deriveId = (item: BatchItem, index: number, idField: string | undefined): string => {
  if (idField !== undefined && typeof item === "object" && item !== null) {
    const v = (item as Record<string, unknown>)[idField]
    if (v !== undefined && v !== null) return String(v)
  }
  return String(index)
}

/** Parse + shallow-validate a worker result against `outputSchema`. Returns the
 *  parsed object on success, or an error string. */
const validateOutput = (
  finalText: string,
  schema: Record<string, unknown>,
): { ok: true; parsed: Record<string, unknown> } | { ok: false; error: string } => {
  let parsed: unknown
  try {
    parsed = JSON.parse(finalText)
  } catch {
    return { ok: false, error: "output_schema violation: result is not valid JSON" }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "output_schema violation: result is not a JSON object" }
  }
  const obj = parsed as Record<string, unknown>
  const missing = Object.keys(schema).filter((k) => !Object.hasOwn(obj, k))
  if (missing.length > 0) {
    return { ok: false, error: `output_schema violation: missing field(s): ${missing.join(", ")}` }
  }
  return { ok: true, parsed: obj }
}

/** Inline FIFO admission semaphore. `acquire()` resolves immediately when a
 *  slot is free, else queues. `release()` hands the slot to the next waiter.
 *  No timer, no clock — pure promise plumbing. */
class Semaphore {
  private slots: number
  private readonly waiters: Array<() => void> = []
  constructor(permits: number) {
    this.slots = Math.max(1, permits)
  }
  acquire(): Promise<void> {
    if (this.slots > 0) {
      this.slots--
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve))
  }
  release(): void {
    const next = this.waiters.shift()
    if (next) {
      next()
      return
    }
    this.slots++
  }
}

/** Race a child run against a per-item timeout and the batch abort signal.
 *  The per-item AbortController is fired on timeout/cancellation so the child
 *  unwinds. The single timer is always cleared. Returns the terminal outcome. */
const runOneItem = async (
  runner: BatchSubagentRunner,
  prompt: string,
  depth: number,
  maxTurns: number | undefined,
  timeoutMs: number,
  batchSignal: AbortSignal,
): Promise<
  | { kind: "ok"; finalText: string; turns: number }
  | { kind: "worker-failed"; finalText: string; turns: number }
  | { kind: "timeout" }
  | { kind: "cancelled" }
> => {
  if (batchSignal.aborted) return { kind: "cancelled" }
  const ac = new AbortController()
  // Chain the batch-level signal into the per-item controller so a mid-flight
  // cancel unwinds the child.
  const onAbort = () => ac.abort()
  batchSignal.addEventListener("abort", onAbort, { once: true })

  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      timedOut = true
      ac.abort()
      resolve("timeout")
    }, timeoutMs)
  })

  try {
    const req = {
      prompt,
      depth,
      signal: ac.signal,
      ...(maxTurns !== undefined ? { budget: { maxTurns } } : {}),
    }
    const winner = await Promise.race([
      runner(req).then((r) => ({ tag: "done" as const, r })),
      timeout.then(() => ({ tag: "timeout" as const })),
    ])
    if (winner.tag === "timeout") return { kind: "timeout" }
    const r = winner.r
    if (r.ok) return { kind: "ok", finalText: r.finalText, turns: r.turns }
    return { kind: "worker-failed", finalText: r.finalText, turns: r.turns }
  } catch (e) {
    // Runner threw — if it was due to our abort (timeout/cancel) report that;
    // otherwise it's a worker failure.
    if (timedOut) return { kind: "timeout" }
    if (batchSignal.aborted) return { kind: "cancelled" }
    return { kind: "worker-failed", finalText: errMessage(e), turns: 0 }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    batchSignal.removeEventListener("abort", onAbort)
  }
}

/** Convert a single item's terminal outcome into a structured per-item result. */
const toItemResult = (
  index: number,
  id: string,
  outcome: Awaited<ReturnType<typeof runOneItem>>,
  outputSchema: Record<string, unknown> | undefined,
): BatchItemResult => {
  if (outcome.kind === "timeout") {
    return { index, id, status: "error", error: "worker timed out", turns: 0 }
  }
  if (outcome.kind === "cancelled") {
    return { index, id, status: "error", error: "cancelled", turns: 0 }
  }
  if (outcome.kind === "worker-failed") {
    return {
      index,
      id,
      status: "error",
      error: `worker failed: ${outcome.finalText}`,
      turns: outcome.turns,
    }
  }
  // ok
  if (outputSchema !== undefined) {
    const v = validateOutput(outcome.finalText, outputSchema)
    if (!v.ok) {
      return { index, id, status: "error", error: v.error, turns: outcome.turns }
    }
    return {
      index,
      id,
      status: "ok",
      output: outcome.finalText,
      parsed: v.parsed,
      turns: outcome.turns,
    }
  }
  return { index, id, status: "ok", output: outcome.finalText, turns: outcome.turns }
}

/** Effective concurrency = min(requested ?? cap, cap), floor 1. */
const effectiveConcurrency = (requested: number | undefined, cap: number): number => {
  const c = requested ?? cap
  return Math.max(1, Math.min(c, cap))
}

/**
 * Fan out `items` through the injected runner, bounded by an admission
 * semaphore. Partial failures are isolated. Returns the deterministic
 * (index-sorted) per-item array + an aggregate summary.
 */
export const runBatch = async (
  args: RunBatchArgs,
  deps: RunBatchDeps,
  signal: AbortSignal,
): Promise<BatchRunResult> => {
  const start = deps.clock()
  const total = args.items.length
  const results: BatchItemResult[] = new Array(total)
  const concurrency = effectiveConcurrency(args.maxConcurrency, deps.schedulerCap)
  const sem = new Semaphore(concurrency)
  const depth = (deps.parentDepth ?? 0) + 1
  const policy: BatchTimeoutPolicy = deps.timeoutPolicy
  const timeoutMs = clampBatchTimeout(policy, args.perItemTimeoutMs)

  let done = 0
  let failed = 0
  const reportProgress = () => deps.onProgress?.(done, total, failed)

  const tasks = args.items.map(async (item, index) => {
    const id = deriveId(item, index, args.idField)
    // 1) Template render (cheap, no slot needed). Missing placeholder ⇒ item
    //    error WITHOUT spawning a worker.
    const rendered = renderTemplate(args.promptTemplate, item)
    if (!rendered.ok) {
      results[index] = {
        index,
        id,
        status: "error",
        error: `template missing placeholder(s): ${rendered.missing.join(", ")}`,
        turns: 0,
      }
      done++
      failed++
      reportProgress()
      return
    }
    // 2) Admission. If the batch is already cancelled, short-circuit before
    //    taking a slot ("cancelled before start").
    if (signal.aborted) {
      results[index] = { index, id, status: "error", error: "cancelled before start", turns: 0 }
      done++
      failed++
      reportProgress()
      return
    }
    await sem.acquire()
    try {
      // Re-check after waiting for a slot — cancellation may have arrived.
      if (signal.aborted) {
        results[index] = { index, id, status: "error", error: "cancelled before start", turns: 0 }
        done++
        failed++
        reportProgress()
        return
      }
      const outcome = await runOneItem(
        deps.runner,
        rendered.prompt,
        depth,
        args.maxTurns,
        timeoutMs,
        signal,
      )
      const itemResult = toItemResult(index, id, outcome, args.outputSchema)
      results[index] = itemResult
      done++
      if (itemResult.status === "error") failed++
      reportProgress()
    } finally {
      sem.release()
    }
  })

  await Promise.all(tasks)

  const cancelled = results.filter(
    (r) =>
      r.status === "error" && (r.error === "cancelled" || r.error === "cancelled before start"),
  ).length
  const okCount = results.filter((r) => r.status === "ok").length
  const summary = {
    total,
    ok: okCount,
    failed: total - okCount,
    cancelled,
    durationMs: deps.clock() - start,
  }
  // Already index-keyed (assigned by index), so the array is in input order.
  return { items: results, summary }
}
