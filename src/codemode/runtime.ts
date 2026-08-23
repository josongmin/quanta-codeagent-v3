/**
 * `@/codemode/runtime` — the QuickJS-WASM sandbox (RFC §4.1, §5.1).
 *
 * Runs ONE model-authored code cell in an isolated WASM heap whose global
 * object contains ONLY a `tools` binding (every method routed to the injected
 * {@link CodeCellDispatchPort}) + a capped `console`. NO `require`, NO `fetch`,
 * NO `process`, NO `Bun`, NO FS/network surface — QuickJS gives none and we add
 * none (RFC §6.2). Hard caps: WASM memory limit, deadline interrupt, abort
 * interrupt, per-cell tool-call cap (RFC §4.4).
 *
 * The async bridge (RFC §8.2 — RESOLVED jun-07): each in-cell `await
 * tools.X(args)` is a PLAIN host function (NOT asyncify) that returns a QuickJS
 * NATIVE promise handle (`ctx.newPromise()`). The real host `dispatch(...)` runs
 * out-of-band; when it settles the host resolves/rejects the deferred and pumps
 * the job queue (`executePendingJobs`). The host drives the cell to completion by
 * draining pending jobs + awaiting a real macrotask + re-reading the top-level
 * cell promise state, until it settles OR the deadline fires. This SYNC variant
 * has NO asyncify suspension, so arbitrary in-cell nesting depth is safe (no WASM
 * out-of-bounds fault, no arg-marshalling hack). Args pass NORMALLY — the cell's
 * call argument is dumped directly in the host function.
 *
 * Handle discipline (RFC §8.2): EVERY `QuickJSHandle` created here is disposed —
 * the eval/promise/state handles in `finally`, the binding handles right after
 * install, the per-resolve marshalled value AFTER it is handed to `resolve`/
 * `reject`, the deferred itself when the host work settles. A leak fails the
 * handle-disposal hellgate.
 *
 * The WASM module is LAZILY imported (`await import("quickjs-emscripten")`) so
 * the default-OFF binary never instantiates it (RFC §5.2).
 */

import { errMessage } from "@/shared"
import { wrapExecMain } from "./exec-main"
import { redactAndCap } from "./limits"
import type {
  CellToolCallRecord,
  CodeCellResult,
  CodeCellStatus,
  RunCodeCellOptions,
} from "./types"

/** Bound list of tool names exposed inside the cell as `tools.<name>` (Phase 1
 *  surface — RFC §8). The DEFAULT surface when `RunCodeCellOptions.surfaceTools`
 *  is absent — so every legacy caller is byte-identical. The binding marshals
 *  each to the host port; a name NOT in the active surface is simply absent from
 *  the cell's `tools` object (the cell cannot widen its own surface — RFC §4.2).
 *  Phase 2 (full surface) passes the agent's ACTUAL `registry.toolNames()` so a
 *  cell can call ANY tool the agent has — each STILL re-gated through the port. */
export const PHASE1_CELL_TOOLS: readonly string[] = ["read", "grep", "write"]

/** A tool name is bindable as `tools.<name>` (dot access) iff it is a valid bare
 *  JS identifier. Snake_case names (`gh_pr_view`) qualify and map directly to
 *  `tools.gh_pr_view` (RFC §4.2 name→identifier mapping). A non-identifier name
 *  (e.g. one with a `-`) is still bound via bracket access (`tools["x-y"]`) but
 *  never dot-reachable — it cannot crash the setup. We bind EVERY name via the
 *  object-key path below, so this predicate is documentation of the dot-access
 *  contract, used by the unit test, not a gate. */
export const isCellToolIdentifier = (name: string): boolean =>
  /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)

/** Internal: reason a run terminated abnormally, surfaced as the status. */
type AbnormalReason = "timeout" | "memory" | "cap" | "aborted"

/** Mutable per-run drive state shared between the bridge + the drive loop. */
interface DriveState {
  /** Host dispatches currently awaiting their REAL async result (the host
   *  `dispatch(...)` promise has not yet resolved/rejected the in-VM deferred).
   *  The drive loop must keep pumping while this is > 0 even when the VM job
   *  queue is momentarily empty — the cell promise cannot settle until these
   *  out-of-band resolves land. */
  inFlight: number
  /** Set by the interrupt handler / bridge cap on abnormal termination. */
  abnormal: AbnormalReason | undefined
  /** Set when a VM operation raised an error that we CONTAINED (the run is
   *  surfaced as a typed `error` rather than crashing the host). */
  faulted: boolean
}

type Ctx = import("quickjs-emscripten").QuickJSContext
type Handle = import("quickjs-emscripten").QuickJSHandle

/** Read the runtime's CURRENT heap usage (`computeMemoryUsage().memory_used_size`,
 *  quickjs-emscripten 0.32 — a real malloc-stats measurement, NOT an error-string
 *  heuristic). Returns the live byte count, or `undefined` if the probe itself
 *  could not run (e.g. the runtime is already at the malloc limit so the probe's
 *  own allocation fails — handled as "cannot measure", the hard cap then applies).
 *  The transient handle is disposed immediately so the poll leaks nothing.
 *
 *  Called ONCE on the TERMINAL fault path (POST-FAULT probe — RFC §4.4, jun-07
 *  structural fix), NOT per interrupt tick: the audit proved a per-tick probe
 *  (a) adds ~26% overhead to every cell, and (b) still MISLABELS the common bulk
 *  allocation (`new Array(N).fill`, `JSON.parse(huge)`, `"x".repeat(N)`) — those
 *  fire the interrupt handler ~once then hard-OOM BEFORE any 0.9-fraction is
 *  observed. After the OOM fault the cell has stopped growing, so a single probe
 *  reads the genuinely-breached heap (the audit confirmed the probe still
 *  succeeds post-OOM — the runtime is not torn down until `runCodeCell`'s
 *  finally). The transient handle is disposed in finally so the probe leaks
 *  nothing even on the OOM path. */
const readMemoryUsedBytes = (ctx: Ctx): number | undefined => {
  let handle: Handle | undefined
  try {
    handle = ctx.runtime.computeMemoryUsage()
    const usage = ctx.dump(handle) as { memory_used_size?: unknown }
    const used = usage.memory_used_size
    return typeof used === "number" ? used : undefined
  } catch {
    // The probe allocates; under extreme pressure that allocation can itself
    // trip the malloc limit. Treat as unmeasurable — the hard cap still bounds
    // the cell (it just surfaces as the generic OOM `error`, not `memory`).
    return undefined
  } finally {
    try {
      handle?.dispose()
    } catch {
      /* runtime torn down mid-probe — handle freed with it. */
    }
  }
}

/**
 * Run one code cell. NEVER throws — every failure path returns a typed
 * {@link CodeCellResult}.
 */
export const runCodeCell = async (opts: RunCodeCellOptions): Promise<CodeCellResult> => {
  const { code, dispatch, limits, signal, now } = opts
  // Phase 2 — the ACTIVE cell surface. Absent ⇒ the Phase-1 3-tool surface
  // (byte-identical for every legacy caller). Present ⇒ the host-supplied FULL
  // registered set. Either way each bound `tools.<name>` re-enters the SAME
  // injected port → the real `dispatchTool` (security identical; just more or
  // fewer names exposed). Deduped + frozen so a degenerate duplicate list does
  // not double-bind, and the in-VM wrapper sees a stable array.
  const surfaceTools: readonly string[] =
    opts.surfaceTools !== undefined ? [...new Set(opts.surfaceTools)] : PHASE1_CELL_TOOLS
  const ledger: CellToolCallRecord[] = []
  let callCount = 0
  const drive: DriveState = { inFlight: 0, abnormal: undefined, faulted: false }
  const deadline = now() + limits.timeoutMs

  // LAZY import — the OFF binary never pays the WASM cost (RFC §5.2). The SYNC
  // (non-asyncify) variant via the SHARED singleton module (`getQuickJS`): ONE
  // WASM module process-wide, but a FRESH runtime+context per cell
  // (`module.newContext()`) for full per-cell isolation, disposed cleanly when the
  // context is disposed. (Spawning a separate WASM module per cell —
  // `newQuickJSWASMModule()` — instead leaves N module instances that bun's
  // process-teardown finalizer trips over; the shared module avoids that.)
  const { getQuickJS } = await import("quickjs-emscripten")
  const mod = await getQuickJS()
  const ctx = mod.newContext()
  // Dispose-pending hook installed by the tools binding — disposes any deferred
  // promise still alive at teardown (set to a no-op until the binding installs).
  let disposePending: () => void = () => {}
  try {
    ctx.runtime.setMemoryLimit(limits.memoryBytes)
    // Interrupt handler (RFC §4.4): abort / deadline ONLY. Returning `true`
    // interrupts a SYNCHRONOUS run (a tight `while(true){}` loop is broken here —
    // the only place a sync-infinite cell can be stopped). The async drive loop
    // also has an outer deadline check, so a stalled (non-looping) cell is bounded
    // too.
    //
    // MEMORY is NOT checked here (jun-07 structural fix). QuickJS invokes the
    // interrupt handler at backward-jumps/calls, NOT on allocation — so a BULK
    // allocation (`new Array(N).fill`, `JSON.parse(huge)`, `"x".repeat(N)`,
    // `Array.from({length:N})`) fires the handler ~once then hard-OOMs BEFORE any
    // fraction-of-cap is observed, and a per-tick probe ALSO taxes every cell ~26%.
    // Instead, memory is classified ONCE on the terminal fault path
    // (`classifyMemoryFault` below): when the cell ends in a fault/uncaught throw
    // we probe `computeMemoryUsage().memory_used_size` and, if it reached the
    // configured cap, relabel the run `"memory"`. Zero per-tick cost; covers the
    // common bulk-OOM case the watchdog missed.
    ctx.runtime.setInterruptHandler(() => {
      if (signal.aborted) {
        drive.abnormal = "aborted"
        return true
      }
      if (now() >= deadline) {
        drive.abnormal = "timeout"
        return true
      }
      return false
    })

    installConsole(ctx)
    const binding = installToolsBinding(ctx, {
      dispatch,
      surfaceTools,
      maxCalls: limits.maxCalls,
      drive,
      onCall: (rec) => {
        callCount += 1
        ledger.push(rec)
      },
    })
    disposePending = binding.disposePending

    const collected = await evalAndDrive(ctx, code, drive, deadline, now)
    // POST-FAULT memory classification (RFC §4.4, jun-07 structural fix): if the
    // cell ended in a FAULT/uncaught throw (`collected.kind === "error"`) and no
    // other abnormal reason already won (timeout/abort/cap), probe the heap ONCE.
    // If usage reached the configured cap the fault was an OOM → relabel `"memory"`
    // (status AND message both flow from `drive.abnormal`, so they stay consistent
    // — no status="memory"/message="runtime fault" divergence). The probe runs
    // ONLY here → zero per-tick cost.
    classifyMemoryFault(ctx, collected, drive, limits.memoryBytes)
    return finalize(collected, {
      limits,
      ledger,
      callCount,
      abnormal: drive.abnormal,
    })
  } catch (e) {
    // Belt-and-braces: any unexpected host throw becomes a typed error result —
    // runCodeCell is NO-THROW by contract.
    return finalize(
      { kind: "error", message: errMessage(e) },
      { limits, ledger, callCount, abnormal: drive.abnormal },
    )
  } finally {
    // CRITICAL handle discipline: an early-terminated cell (timeout / abort / cap /
    // a dangling in-cell promise that never settled) leaves one or more deferred
    // promises ALIVE — their in-VM promise+resolve+reject handles are still owned
    // by `ctx`. Disposing the runtime with live objects ABORTS the WASM heap
    // (`list_empty(&rt->gc_obj_list)` assertion). So dispose every still-alive
    // deferred FIRST (idempotent — a settled deferred's `dispose` is a no-op),
    // THEN tear down the context. (mod has no `dispose` in this variant; the WASM
    // module is GC'd with the dropped reference.)
    try {
      disposePending()
    } catch {
      /* a deferred already freed by ctx teardown — nothing more to release. */
    }
    // Dispose the context unconditionally — no orphaned WASM heap even on
    // abort/throw (RFC §4.4). Swallow so disposal stays NO-THROW.
    try {
      ctx.dispose()
    } catch {
      /* VM already torn down — nothing more to release here. */
    }
  }
}

/** The raw collected outcome of the drive (before redact/cap/ledger shaping). An
 *  `error` carries `oom: true` when the fault was QuickJS's own out-of-memory
 *  exception (see {@link isQuickJsOom}) — the structural signal the post-fault
 *  memory classifier keys on. */
type Collected =
  | { kind: "value"; value: unknown }
  | { kind: "error"; message: string; oom?: boolean }

/** Is a faulted error QuickJS's OWN out-of-memory exception? QuickJS raises
 *  resource exhaustion as an `InternalError` whose canonical message is exactly
 *  `"out of memory"` (the `JS_ThrowOutOfMemory` path — the same identity for a
 *  bulk `new Array(N).fill`, `JSON.parse(huge)`, `"x".repeat(N)`,
 *  `Array.from({length:N})`, AND an incremental loop). This keys on the structured
 *  error TYPE (`name`), NOT a fragile substring search of arbitrary user message
 *  text: a plain `throw new Error("out of memory")` has `name === "Error"` and is
 *  NOT matched; a `RangeError`/`TypeError`/stack-overflow is NOT matched.
 *
 *  BEST-EFFORT (known + accepted, pinned by the spoof case in
 *  `code-mode-memory-fault-hellgate`): a cell CAN forge the engine's OOM identity
 *  — `throw Object.assign(new Error("out of memory"), { name: "InternalError" })`
 *  — to self-label its failure "memory". This is COSMETIC-ONLY: `status` only
 *  selects the model-visible diagnostic tag (`code_cell_memory` vs
 *  `code_cell_error`) and BOTH are `ok:false`; the forged label cannot escape the
 *  sandbox, widen the tool surface, or evade a cap, and it is shown back to the
 *  same model that authored the cell. The engine's REAL OOMs are always caught.
 *  We deliberately do NOT bolt on a counter-measure: a post-OOM heap probe reads
 *  LOW for both a real OOM (the over-cap allocation is refused atomically, leaving
 *  no residual heap) and a forged throw, so it cannot distinguish them — a guard
 *  that can't separate the cases would be exactly the fragile heuristic to avoid. */
const isQuickJsOom = (name: unknown, message: unknown): boolean =>
  name === "InternalError" && message === "out of memory"

/** POST-FAULT memory classification (RFC §4.4, jun-07 structural fix). Called
 *  ONCE after the drive loop, BEFORE `finalize` — ZERO per-tick cost (the audit
 *  proved a per-tick `computeMemoryUsage()` probe taxes every cell ~26% AND still
 *  misses the bulk-OOM shapes the interrupt handler never observes growing).
 *
 *  When the cell ended in a fault / uncaught throw (`collected.kind === "error"`)
 *  and no other abnormal reason already won (timeout/abort/cap), relabel
 *  `drive.abnormal = "memory"` (so status + message both flow from it, staying
 *  consistent) when EITHER:
 *    (1) the fault is QuickJS's typed out-of-memory exception (`collected.oom` —
 *        the deterministic signal that catches ALL bulk + incremental OOM shapes;
 *        a rejected bulk allocation leaves NO residual heap, so accounting alone
 *        cannot see it), OR
 *    (2) a single confirming heap probe shows usage REACHED the configured cap
 *        (`limits.memoryBytes` — the cap IS the threshold, no magic fraction);
 *        defense-in-depth for an incremental breach the engine surfaced
 *        differently.
 *  A non-OOM fault (a plain `throw`, a stack blowout below the cap) leaves
 *  `abnormal` unset → stays `"error"`. If the probe throws or cannot measure it
 *  returns `undefined` and we fall back to the `oom` flag (NO-THROW preserved). */
const classifyMemoryFault = (
  ctx: Ctx,
  collected: Collected,
  drive: DriveState,
  memoryBytes: number,
): void => {
  if (collected.kind !== "error") return
  if (drive.abnormal !== undefined) return
  if (collected.oom === true) {
    drive.abnormal = "memory"
    return
  }
  const used = readMemoryUsedBytes(ctx)
  if (used !== undefined && used >= memoryBytes) {
    drive.abnormal = "memory"
  }
}

/**
 * Eval the wrapped program (SYNCHRONOUSLY — `evalCode` returns the top-level cell
 * promise handle), then drive the native-promise event loop to completion. The
 * cell body runs inside an async IIFE whose promise we settle by draining the job
 * queue + awaiting real macrotasks (so out-of-band host resolves land) until the
 * cell promise settles. Returns the dumped return value (success) or a sanitized
 * error message (rejection / parse / interrupt).
 */
const evalAndDrive = async (
  ctx: Ctx,
  code: string,
  drive: DriveState,
  deadline: number,
  now: () => number,
): Promise<Collected> => {
  const wrapped = wrapExecMain(code)
  let evalResult: ReturnType<Ctx["evalCode"]>
  try {
    evalResult = ctx.evalCode(wrapped, "code_cell.js")
  } catch (e) {
    return { kind: "error", message: errMessage(e) }
  }
  if (evalResult.error) {
    // Synchronous parse error / top-level throw before the promise formed (a
    // sync bulk allocation can OOM here too — carry the `oom` flag through).
    const { message, oom } = dumpError(ctx, evalResult.error)
    evalResult.error.dispose()
    return { kind: "error", message, oom }
  }

  const promiseHandle = evalResult.value
  try {
    await driveToSettled(ctx, promiseHandle, drive, deadline, now)
    return collectPromise(ctx, promiseHandle, drive)
  } finally {
    try {
      promiseHandle.dispose()
    } catch {
      /* faulted VM — handle freed with the context teardown. */
    }
  }
}

/** Drive the VM until the cell promise settles, an interrupt fires, or the
 *  deadline passes. The SYNC variant has NO asyncify suspension, so we can touch
 *  the VM (`executePendingJobs` / `getPromiseState`) FREELY — there is no
 *  re-entrancy fault. Each round: pump the job queue, then (if still pending)
 *  yield a real macrotask so out-of-band host `dispatch(...)` resolves can run
 *  and queue their resolve jobs, then re-check. */
const driveToSettled = async (
  ctx: Ctx,
  promiseHandle: Handle,
  drive: DriveState,
  deadline: number,
  now: () => number,
): Promise<void> => {
  // Structural ceiling so a pathological re-queue can never spin forever even if
  // the deadline clock is coarse; the deadline is the primary brake.
  const MAX_ROUNDS = 5_000_000
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (driveRound(ctx, promiseHandle, drive, deadline, now)) return
    await macrotask()
  }
}

/** One drive round. Returns `true` when the loop should STOP (settled / aborted /
 *  timeout / faulted), `false` to continue after a macrotask yield. Extracted to
 *  keep `driveToSettled` under the cognitive-complexity cap.
 *
 *  CONTAINMENT: a VM touch here could in principle throw (e.g. a memory-limit hit
 *  surfaced from `executePendingJobs`); we catch it, mark the run faulted, and
 *  stop (the caller surfaces a typed error; the WASM heap is torn down in
 *  `runCodeCell`'s `finally`). */
const driveRound = (
  ctx: Ctx,
  promiseHandle: Handle,
  drive: DriveState,
  deadline: number,
  now: () => number,
): boolean => {
  if (drive.abnormal !== undefined) {
    // An interrupt fired (abort/timeout/cap). Pump once more so the cell promise
    // transitions to rejected, then stop.
    try {
      ctx.runtime.executePendingJobs()
    } catch {
      drive.faulted = true
    }
    return true
  }
  try {
    // Drain every job queued so far (resolve/reject continuations, microtasks).
    ctx.runtime.executePendingJobs()
    if (isSettled(ctx, promiseHandle)) return true
  } catch {
    drive.faulted = true
    return true
  }
  // Deadline backstop (a stalled cell / dangling promise becomes a typed timeout).
  if (now() >= deadline) {
    drive.abnormal = "timeout"
    return true
  }
  // Still pending: keep going. If nothing is in flight AND no jobs are pending,
  // the cell awaited a promise that will never resolve (a dangling promise) — the
  // deadline above is the backstop that ends it. We continue (yield a macrotask)
  // so any in-flight host dispatch can land its resolve job.
  return false
}

/** Read the SETTLED cell promise's value/rejection. Returns a dumped value or a
 *  sanitized error message. A still-pending promise (dangling) ⇒ "ended without a
 *  return value". */
const collectPromise = (ctx: Ctx, promiseHandle: Handle, drive: DriveState): Collected => {
  if (drive.faulted) {
    return {
      kind: "error",
      message:
        "code cell runtime fault (the embedded JS engine could not complete this program); " +
        "split the work into fewer in-cell tool calls or issue the calls directly",
    }
  }
  if (drive.abnormal !== undefined) {
    return { kind: "error", message: abnormalMessage(drive.abnormal) }
  }
  try {
    const state = ctx.getPromiseState(promiseHandle)
    if (state.type === "fulfilled") {
      const value = ctx.dump(state.value)
      state.value.dispose()
      return { kind: "value", value }
    }
    if (state.type === "rejected") {
      // A cell that OOMs inside the async IIFE rejects the cell promise with
      // QuickJS's `InternalError: out of memory` — carry the `oom` flag so the
      // post-fault classifier relabels it `"memory"` (this is the path the bulk
      // + incremental OOM shapes take).
      const { message, oom } = dumpError(ctx, state.error)
      state.error.dispose()
      return { kind: "error", message, oom }
    }
    return { kind: "value", value: undefined }
  } catch {
    drive.faulted = true
    return { kind: "error", message: "code cell runtime fault while reading the result" }
  }
}

/** Is the cell promise settled (fulfilled/rejected)? CRITICAL: for a SETTLED
 *  promise, `getPromiseState` allocates a FRESH heap value/error handle each call
 *  (quickjs-emscripten 0.32 `heapValueHandle`) — so we MUST dispose it here or
 *  every poll of a settled promise leaks one handle into the runtime's GC list
 *  (which aborts at `JS_FreeRuntime`). We only need `.type`, so dispose the
 *  value/error arm immediately. `collectPromise` re-reads the state to extract
 *  the actual value/message (a fresh, separately-disposed handle). */
const isSettled = (ctx: Ctx, promiseHandle: Handle): boolean => {
  const state = ctx.getPromiseState(promiseHandle)
  if (state.type === "fulfilled") {
    try {
      state.value.dispose()
    } catch {
      /* borrowed/static handle — nothing to free. */
    }
    return true
  }
  if (state.type === "rejected") {
    try {
      state.error.dispose()
    } catch {
      /* idem */
    }
    return true
  }
  return false
}

/** Yield one macrotask so an in-flight host `dispatch(...)` promise can resolve
 *  and queue its in-VM resolve job before the drive loop pumps the VM again. */
const macrotask = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** Shape the collected outcome into the typed model-facing {@link CodeCellResult}
 *  (status + redacted/capped output + ledger). */
const finalize = (
  collected: Collected,
  state: {
    limits: RunCodeCellOptions["limits"]
    ledger: CellToolCallRecord[]
    callCount: number
    abnormal: AbnormalReason | undefined
  },
): CodeCellResult => {
  const status: CodeCellStatus =
    state.abnormal !== undefined ? state.abnormal : collected.kind === "error" ? "error" : "ok"
  // Message precedence: an ABNORMAL reason (timeout/memory/cap/abort) ALWAYS wins
  // the message, even when `collected` is a fault `error` — so a post-fault
  // memory-classified run shows "memory limit exceeded", NOT the generic "runtime
  // fault" text (status="memory"/message="runtime fault" divergence, fixed jun-07).
  const raw =
    state.abnormal !== undefined
      ? abnormalMessage(state.abnormal)
      : collected.kind === "value"
        ? stringifyReturn(collected.value)
        : collected.message
  const { text, truncated } = redactAndCap(raw, state.limits.outputCap)
  return {
    status,
    output: text,
    toolCalls: state.ledger.slice(),
    callCount: state.callCount,
    truncated,
  }
}

/** Human message for an abnormal termination. */
const abnormalMessage = (reason: AbnormalReason | undefined): string => {
  switch (reason) {
    case "timeout":
      return "code cell interrupted: wall-clock deadline exceeded"
    case "memory":
      return "code cell interrupted: memory limit exceeded"
    case "cap":
      return "code cell stopped: per-cell tool-call cap exceeded"
    case "aborted":
      return "code cell aborted"
    default:
      return "code cell ended without a return value"
  }
}

/** JSON-stringify the cell's return value defensively. */
const stringifyReturn = (value: unknown): string => {
  if (value === undefined) return "undefined"
  try {
    const json = JSON.stringify(value)
    return json === undefined ? String(value) : json
  } catch {
    return String(value)
  }
}

/** Extract BOTH the sanitized `.message` AND whether the error is QuickJS's own
 *  out-of-memory exception (`oom`) from a thrown error handle. The `oom` flag
 *  keys on the structured error `name` (`InternalError`) + the canonical engine
 *  message via {@link isQuickJsOom} — used by the post-fault memory classifier so
 *  a bulk OOM (which leaves no residual heap to measure) is still labelled
 *  `"memory"`. Only the `.message` is surfaced to the model (cell-internal stack
 *  stays inside the VM, RFC §4.5). */
const dumpError = (ctx: Ctx, errHandle: Handle): { message: string; oom: boolean } => {
  try {
    const dumped = ctx.dump(errHandle)
    if (dumped !== null && typeof dumped === "object" && "message" in dumped) {
      const m = (dumped as { message?: unknown }).message
      const name = (dumped as { name?: unknown }).name
      const message = typeof m === "string" ? m : String(m)
      return { message, oom: isQuickJsOom(name, m) }
    }
    const message = typeof dumped === "string" ? dumped : JSON.stringify(dumped)
    return { message, oom: false }
  } catch {
    return { message: "code cell threw a non-introspectable error", oom: false }
  }
}

/** Install a capped `console` whose methods are no-ops on the host side (Phase 1
 *  does NOT pipe console output to the model — only the return value is
 *  surfaced). Keeping `console` defined avoids `ReferenceError` in cell programs. */
const installConsole = (ctx: Ctx): void => {
  const consoleHandle = ctx.newObject()
  for (const method of ["log", "info", "warn", "error", "debug"]) {
    const fn = ctx.newFunction(method, () => ctx.undefined)
    ctx.setProp(consoleHandle, method, fn)
    fn.dispose()
  }
  ctx.setProp(ctx.global, "console", consoleHandle)
  consoleHandle.dispose()
}

/**
 * Install the `tools` object: one native-promise-bridged method per Phase-1 tool
 * name. Each `tools.<name>(args)` is a PLAIN host function (no asyncify) that:
 *   1. dumps its single argument NORMALLY (args pass across the boundary cleanly),
 *   2. enforces the per-cell call cap BEFORE any dispatch,
 *   3. creates an in-VM native promise (`ctx.newPromise()`) and returns its
 *      handle SYNCHRONOUSLY, and
 *   4. kicks off the REAL host `dispatch(...)` out-of-band; when it settles the
 *      host resolves the deferred with the content string (ok) or REJECTS it with
 *      a typed in-VM Error (`{name, message}`) on a non-ok outcome (RFC §4.5),
 *      then pumps the job queue so the cell's `await` continuation runs.
 *
 * This handles ARBITRARY in-cell nesting depth (no asyncify suspension ⇒ no WASM
 * out-of-bounds fault). `drive.inFlight` tracks outstanding host dispatches so the
 * drive loop keeps pumping until every out-of-band resolve has landed.
 */
/**
 * Everything the tools binding installs: the per-tool proxies and the pending
 * registry they record into. Split out of `installToolsBinding`
 * (god-function burndown).
 */
const toolsBindingState = (
  ctx: Ctx,
  bind: {
    dispatch: RunCodeCellOptions["dispatch"]
    /** The ACTIVE cell surface (Phase 1 default OR the Phase-2 full registered
     *  set). Each name becomes `tools.<name>`; a name absent here is unreachable. */
    surfaceTools: readonly string[]
    maxCalls: number
    drive: DriveState
    onCall: (rec: CellToolCallRecord) => void
  },
) => {
  /** The factory's MUTABLE state. `let` bindings cannot cross a function
   *  boundary by value, so they live here and the groups mutate in place —
   *  observationally identical to the closure they replace. */
  const mut = {
    seq: 0,
    issued: 0,
    disposed: false,
  }

  // Every deferred we mint is tracked here until it settles AND its resolve/reject
  // job has been pumped — then it is removed. Any deferred STILL in this set at
  // teardown (early termination: timeout / abort / cap / a dangling in-cell
  // promise) is mut.disposed by `disposePending` BEFORE `ctx.dispose()` so the WASM
  // runtime is never freed with a live promise handle (the GC-list assertion).
  const live = new Set<import("quickjs-emscripten").QuickJSDeferredPromise>()
  // Once teardown begins (`disposePending`), NO out-of-band resolve may touch the
  // VM again: a late `dispatch().then()` firing after `ctx.dispose()` would call
  // `executePendingJobs` on a freed runtime, which `abort()`s the WASM heap
  // (UNCATCHABLE by a JS try/catch). This flag fences every post-teardown VM
  // touch — the deferred is already mut.disposed by `disposePending`, so a late
  // resolve has nothing legitimate to do.

  // ONE shared host bridge `__cmDispatch(toolName, args)` — a plain newFunction.
  // The in-VM `tools.*` wrapper (installed below) calls it with the tool name +
  // args; the host returns a native promise handle that settles out-of-band.
  const dispatchFn = ctx.newFunction("__cmDispatch", (nameH, argsH) => {
    const tool = nameH === undefined ? "unknown" : ctx.getString(nameH)
    // Args dump NORMALLY now (the asyncify arg-marshalling fault is gone).
    const input = argsH === undefined ? undefined : ctx.dump(argsH)

    const deferred = ctx.newPromise()
    live.add(deferred)

    // Settle helper: dispose the deferred (idempotent — frees promise/resolve/
    // reject handles), drop it from the live set, and pump so the cell's `await`
    // continuation runs. Guard: the VM may already be torn down (deadline/abort) —
    // swallow so a late host resolve never crashes the host.
    const settle = (apply: () => void): void => {
      // Teardown started: the VM is being / already freed. Do NOT touch it — the
      // deferred was mut.disposed by `disposePending`. (Uncatchable WASM abort guard.)
      if (mut.disposed) return
      try {
        apply()
      } finally {
        live.delete(deferred)
        try {
          deferred.dispose()
        } catch {
          /* already freed by ctx teardown */
        }
        if (!mut.disposed) {
          try {
            ctx.runtime.executePendingJobs()
          } catch {
            /* VM gone / faulted — the cell already terminated. */
          }
        }
      }
    }

    // Cap BEFORE dispatching — a runaway fan-out can never reach the host gate
    // more than `maxCalls` times (RFC §4.4 / §6.4). Reject the deferred with a
    // typed cap error; do NOT touch the host port.
    if (mut.issued >= bind.maxCalls) {
      bind.drive.abnormal = "cap"
      settle(() =>
        rejectWithError(
          ctx,
          deferred,
          "ToolCap",
          `per-cell tool-call cap (${bind.maxCalls}) exceeded`,
        ),
      )
      // The resolve job is queued; the drive loop pumps it. Return the handle.
      return deferred.handle
    }
    mut.issued += 1
    const thisSeq = mut.seq++
    bind.drive.inFlight += 1

    // Out-of-band: run the REAL gated dispatch, then resolve/reject the deferred.
    void bind
      .dispatch(tool, input)
      .then((result) => {
        bind.onCall({ seq: thisSeq, tool, outcome: result.ok ? "ok" : "denied" })
        settle(() => {
          if (result.ok) {
            resolveWithString(ctx, deferred, result.content)
          } else {
            rejectWithError(ctx, deferred, "ToolDenied", result.content)
          }
        })
      })
      .catch((e: unknown) => {
        bind.onCall({ seq: thisSeq, tool, outcome: "error" })
        settle(() => rejectWithError(ctx, deferred, "ToolError", errMessage(e)))
      })
      .finally(() => {
        bind.drive.inFlight -= 1
      })

    return deferred.handle
  })
  ctx.setProp(ctx.global, "__cmDispatch", dispatchFn)
  dispatchFn.dispose()

  // Install the in-VM `tools` wrapper. Each `tools.<name>(args)` calls the host
  // bridge with the tool name + args and `await`s the returned native promise;
  // the host resolves it with the content string or rejects with a typed Error
  // (already carrying the right `name`/`message`). NO JSON stash, NO `__cmReq`.
  // Phase 2 — the bound names come from the ACTIVE surface (`bind.surfaceTools`):
  // the agent's FULL registered set when the host passed it, else the Phase-1
  // 3-tool default. `tools[__t] = …` binds via the object key, so a valid-bare-
  // identifier name (e.g. `gh_pr_view`) is dot-reachable as `tools.gh_pr_view`
  // (RFC §4.2) AND a non-identifier name is still bracket-reachable — neither can
  // break the setup eval. The host port re-gates every call regardless of name.
  //
  // SURFACE-ESCAPE FENCE (cycle-2 audit): the raw bridge `__cmDispatch` accepts
  // ANY tool name — so leaving it on the cell's `globalThis` would let a cell call
  // `__cmDispatch("bash", …)` directly, WIDENING its surface past `surfaceTools`
  // (the documented "a name not in the surface is unreachable / the cell cannot
  // widen its own surface" invariant, RFC §4.2). The setup IIFE captures the
  // bridge into a LOCAL, builds the bound `tools.*` closures over that local, then
  // DELETES `__cmDispatch` from the global so the cell body (which runs AFTER this
  // setup) can reach the bridge ONLY through the surface-restricted `tools` object.
  const toolNames = JSON.stringify(bind.surfaceTools)
  const wrapper = `
    (() => {
      const __bridge = globalThis.__cmDispatch;
      const tools = {};
      for (const __t of ${toolNames}) {
        tools[__t] = (args) => __bridge(__t, args === undefined ? null : args);
      }
      globalThis.tools = tools;
      // Fence: drop the raw bridge so the cell can reach it ONLY via tools.*.
      try { delete globalThis.__cmDispatch; } catch (_e) {}
    })();
  `
  const setup = ctx.evalCode(wrapper, "cm_tools_setup.js")
  if (setup.error) {
    setup.error.dispose()
  } else {
    setup.value.dispose()
  }

  // Teardown hook: dispose every deferred STILL alive (an early-terminated cell
  // never `await`ed its rejected/dangling promise). Idempotent per deferred.
  return { ctx, bind, live, dispatchFn, toolNames, wrapper, setup, mut }
}

/** The state every operation group shares, inferred from {@link toolsBindingState} so it
 *  can never drift from what that function actually builds. */
type ToolsBindingCtx = ReturnType<typeof toolsBindingState>

/** Dispose whatever the binding still has in flight. */
const disposeOps = (
  sctx: ToolsBindingCtx,
): Pick<{ disposePending: () => void }, "disposePending"> => {
  const { live, mut } = sctx
  return {
    disposePending: () => {
      // Fence every future out-of-band resolve from touching the VM FIRST, then
      // dispose any deferred still alive (early-terminated cell never `await`ed
      // its rejected/dangling promise). Idempotent per deferred.
      mut.disposed = true
      for (const deferred of live) {
        try {
          deferred.dispose()
        } catch {
          /* already freed */
        }
      }
      live.clear()
    },
  }
}

const installToolsBinding = (
  ctx: Ctx,
  bind: {
    dispatch: RunCodeCellOptions["dispatch"]
    /** The ACTIVE cell surface (Phase 1 default OR the Phase-2 full registered
     *  set). Each name becomes `tools.<name>`; a name absent here is unreachable. */
    surfaceTools: readonly string[]
    maxCalls: number
    drive: DriveState
    onCall: (rec: CellToolCallRecord) => void
  },
): { disposePending: () => void } => {
  const sctx = toolsBindingState(ctx, bind)
  return {
    ...disposeOps(sctx),
  }
}

/** Resolve an in-VM deferred with a STRING value, disposing the marshalled handle
 *  after handing it to `resolve` (the deferred owns it thereafter). */
const resolveWithString = (
  ctx: Ctx,
  deferred: import("quickjs-emscripten").QuickJSDeferredPromise,
  content: string,
): void => {
  try {
    const v = ctx.newString(content)
    deferred.resolve(v)
    v.dispose()
  } catch {
    /* VM already torn down — nothing to resolve into. */
  }
}

/** Reject an in-VM deferred with a typed Error (`{name, message}`), disposing the
 *  marshalled error handle after handing it to `reject`. The in-cell `await` then
 *  throws this error (the model MAY try/catch it, but a caught deny does NOT make
 *  the underlying action happen — RFC §4.5). */
const rejectWithError = (
  ctx: Ctx,
  deferred: import("quickjs-emscripten").QuickJSDeferredPromise,
  name: string,
  message: string,
): void => {
  try {
    const errHandle = ctx.newError(message)
    const nameHandle = ctx.newString(name)
    ctx.setProp(errHandle, "name", nameHandle)
    nameHandle.dispose()
    deferred.reject(errHandle)
    errHandle.dispose()
  } catch {
    /* VM already torn down. */
  }
}
