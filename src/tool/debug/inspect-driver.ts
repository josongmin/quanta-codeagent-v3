/**
 * W5 DAP — the launch+inspect handshake driver.
 *
 * Drives the canonical DAP sequence to run a program under a debug adapter,
 * stop at the first breakpoint, and snapshot the stack + variables (and an
 * optional expression). This is the protocol choreography that the
 * `debug_inspect` tool exposes; it is kept separate (and testable against a
 * scripted fake adapter) so the tool stays a thin port+format wrapper.
 *
 * Canonical order (DAP spec §"Launch Sequencing"):
 *   initialize → (await `initialized` event) → setBreakpoints* →
 *   configurationDone → race(`stopped` | `terminated`). On `stopped`:
 *   threads → stackTrace → scopes → variables[*] → (optional evaluate) →
 *   terminate. A timeout guards every wait so a wedged adapter can never hang
 *   the tool.
 */
import { errMessage, logger } from "@/shared"
import type { DapClient, DapResponse } from "./dap-client"

export interface DapBreakpoint {
  readonly file: string
  readonly line: number
  /** Optional DAP conditional-breakpoint expression — the adapter only stops
   *  when it evaluates truthy in the program's context (e.g. `i == 3`). */
  readonly condition?: string
}

export interface InspectSpec {
  /** DAP adapterID (`python`, `node`, …) — informational for the adapter. */
  readonly adapterID: string
  /** Adapter-specific launch config (program, args, cwd, env, …). */
  readonly launch: Record<string, unknown>
  readonly breakpoints: readonly DapBreakpoint[]
  /** Optional expression to evaluate in the top frame once stopped. */
  readonly evaluate?: string
  /** DAP exception-breakpoint filters (e.g. `["uncaught","userUnhandled"]`).
   *  When set, the adapter ALSO stops at the throw site of a matching exception
   *  — so a failure with no precise line, or one thrown deep below the test
   *  frame, is caught AT the throw with its type+message (break-on-throw). */
  readonly exceptionFilters?: readonly string[]
}

export interface StackFrameInfo {
  readonly name: string
  readonly line: number
  readonly source?: string
}
/** One variable, with its DAP `type` and (for aggregates) a BOUNDED tree of
 *  children expanded one+ level deep — so a struct/dict/object surfaces its
 *  fields instead of an opaque `<Foo object at 0x…>` summary. */
export interface DapVariable {
  readonly name: string
  readonly value: string
  readonly type?: string
  readonly children?: readonly DapVariable[]
}
export interface ScopeVars {
  readonly scope: string
  readonly vars: readonly DapVariable[]
}
/** Scopes (Locals/Arguments/…) captured for ONE stack frame. The top K user
 *  frames are captured (not just frame 0) — the assertion often fails in a
 *  helper while the bug lives one frame up in the caller. */
export interface FrameScopes {
  readonly frame: string
  readonly line: number
  readonly source?: string
  readonly scopes: readonly ScopeVars[]
}
export type Inspection =
  | {
      readonly outcome: "stopped"
      readonly reason: string
      readonly stack: readonly StackFrameInfo[]
      /** Per-frame scopes for the top K frames. `frames[0]` is the stop frame. */
      readonly frames: readonly FrameScopes[]
      readonly evaluated?: { readonly expression: string; readonly result: string }
      /** Set when the stop was an EXCEPTION (reason "exception") and the adapter
       *  answered `exceptionInfo` — the throw's type + message. */
      readonly exception?: { readonly id: string; readonly description: string }
      /** The live threads at the stop (dlv reports goroutines here) — a
       *  concurrency dump. Bounded; empty/absent when the adapter doesn't answer. */
      readonly threads?: readonly { readonly id: number; readonly name: string }[]
    }
  | { readonly outcome: "exited"; readonly exitCode?: number; readonly breakpointsBound?: boolean }
  | { readonly outcome: "error"; readonly message: string }

export interface InspectOptions {
  /** Max wait for the stopped/terminated event after configurationDone. */
  readonly stopTimeoutMs?: number
  /** Turn-abort signal. When it fires the driver disposes the client (kills the
   *  spawned adapter+program) and returns an `error` outcome — so cancelling a
   *  turn never leaves a debug session alive until the stop timeout. */
  readonly signal?: AbortSignal
}

const DEFAULT_STOP_TIMEOUT_MS = 30_000

// ── Capture bounds ───────────────────────────────────────────────────────────
// These are RESOURCE caps (not behavioural heuristics): a real debugger lazy-
// loads the variable tree and never materializes an unbounded object graph. We
// bound the same three axes so a huge/cyclic structure can neither blow the
// packet size nor exhaust the per-query time budget.
//
/** Top frames whose scopes+locals are captured (frame 0 = the stop frame). */
const MAX_FRAMES_WITH_LOCALS = 3
/** How many levels of nested children to expand (scope vars are depth 1). */
const MAX_VAR_DEPTH = 2
/** Children expanded per aggregate node (breadth cap). */
const MAX_CHILDREN_PER_VAR = 16
/** Global budget on total variable nodes materialized across ALL frames. */
const MAX_TOTAL_VARS = 200
/** Cap on threads/goroutines surfaced in the concurrency dump. */
const MAX_THREADS = 50

const asObj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {})
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback)
const num = (v: unknown, fallback = 0): number => (typeof v === "number" ? v : fallback)

/** A timeout that resolves to a sentinel rather than rejecting (so the race is
 *  deterministic and never throws an unhandled rejection). */
const withTimeout = <T>(p: Promise<T>, ms: number, onTimeout: T): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout), ms)
  })
  return Promise.race([p.then((v) => { if (timer) clearTimeout(timer); return v }), timeout])
}

/** Mutable budget shared across an entire inspection's variable expansion. */
interface VarBudget {
  remaining: number
}

/** Recursively expand a `variablesReference` into a BOUNDED {@link DapVariable}
 *  tree. Depth-, breadth-, and total-node-capped; a `visited` ref set guards
 *  against cyclic / shared references re-expanding forever. Each `variables`
 *  call is timeout-guarded by the caller's `timed`, so a wedged adapter degrades
 *  rather than hanging. */
const expandVariables = async (
  timed: (command: string, args?: unknown) => Promise<DapResponse>,
  ref: number,
  depth: number,
  budget: VarBudget,
  visited: Set<number>,
  signal?: AbortSignal,
): Promise<DapVariable[]> => {
  // Honour the turn abort mid-expansion — a cancelled turn must not keep
  // round-tripping `variables` requests through a wedged adapter.
  if (signal?.aborted === true || ref <= 0 || depth > MAX_VAR_DEPTH || budget.remaining <= 0 || visited.has(ref)) return []
  visited.add(ref)
  const vRes = await timed("variables", { variablesReference: ref })
  const out: DapVariable[] = []
  for (const v of asArr(asObj(vRes.body).variables)) {
    if (budget.remaining <= 0 || out.length >= MAX_CHILDREN_PER_VAR) break
    const vo = asObj(v)
    const value = str(vo.value, "")
    // Drop debugpy presentation-group pseudo-entries ("special variables",
    // "function variables", "class variables") — they carry an empty scalar
    // `value` (lazy-expand UI nodes only). A real empty string renders as `''`
    // (quoted), a real empty list as `[]`, never "", so this filter is value-safe.
    if (value === "") continue
    budget.remaining--
    const childRef = num(vo.variablesReference)
    const type = str(vo.type, "")
    const children = childRef > 0 ? await expandVariables(timed, childRef, depth + 1, budget, visited, signal) : []
    out.push({
      name: str(vo.name, "?"),
      value,
      ...(type !== "" ? { type } : {}),
      ...(children.length > 0 ? { children } : {}),
    })
  }
  return out
}

export const inspectViaDap = async (
  client: DapClient,
  spec: InspectSpec,
  opts: InspectOptions = {},
): Promise<Inspection> => {
  const stopTimeoutMs = opts.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS
  // Abort sentinel — any wait below races this so a cancelled turn unblocks
  // immediately (and tears the adapter down) instead of lingering to the timeout.
  const ABORTED = Symbol("aborted")
  const abortP = new Promise<typeof ABORTED>((resolve) => {
    if (opts.signal === undefined) return
    if (opts.signal.aborted) resolve(ABORTED)
    else opts.signal.addEventListener("abort", () => resolve(ABORTED), { once: true })
  })
  if (opts.signal?.aborted === true) {
    client.dispose()
    return { outcome: "error", message: "aborted" }
  }
  // Read the signal through a closure for later checks: the `=== true` guard
  // above flow-narrows `opts.signal.aborted` to `false | undefined` for the rest
  // of this scope, so a direct re-check post-await would be (wrongly) flagged as
  // dead by TS — but the EXTERNAL signal genuinely can flip true across an await.
  const aborted = (): boolean => opts.signal?.aborted === true
  try {
    // Arm ALL async-event waiters BEFORE the first request. A fast (in-process)
    // adapter can emit `initialized` synchronously while it answers `initialize`;
    // arming after the await would MISS it and hang. `stopped`/`terminated` only
    // fire post-configurationDone, but arming early is harmless and race-proof.
    const initializedP = client.waitForEvent("initialized")
    const stoppedP = client.waitForEvent("stopped")
    const terminatedP = client.waitForEvent("terminated")

    const init = await client.request("initialize", {
      adapterID: spec.adapterID,
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: "path",
    })
    if (!init.success) return { outcome: "error", message: init.message ?? "initialize failed" }

    // DAP "Launch Sequencing": the `launch` response is DEFERRED by real
    // adapters (debugpy) until AFTER `configurationDone`. So we MUST NOT await
    // it here — doing so deadlocks (the client blocks on a response the adapter
    // will not send until we send configurationDone). Fire it, and fold a
    // launch FAILURE into the stop race below (a successful launch never
    // settles that race; only a failed one does).
    const launchP = client.request("launch", spec.launch)
    const launchFailP: Promise<{ kind: "launchfail"; message: string }> = launchP.then((r) =>
      r.success
        ? new Promise<{ kind: "launchfail"; message: string }>(() => {}) // success ⇒ never settles
        : { kind: "launchfail", message: r.message ?? "launch failed" },
    )

    // Wait for the adapter to be configuration-ready (triggered by launch).
    await withTimeout(initializedP, stopTimeoutMs, undefined)

    // Set breakpoints grouped per source file (preserving per-bp condition).
    const byFile = new Map<string, { line: number; condition?: string }[]>()
    for (const bp of spec.breakpoints) {
      const arr = byFile.get(bp.file) ?? []
      arr.push({ line: bp.line, ...(bp.condition !== undefined ? { condition: bp.condition } : {}) })
      byFile.set(bp.file, arr)
    }
    // Track whether ANY breakpoint actually bound — an adapter returns
    // `verified:false` when it can't map a {file,line} to real code (missing
    // debug info, or a source-path mismatch e.g. /tmp vs /private/tmp). If none
    // bind and the program then exits, that is the real reason — far more useful
    // than a bare "ran to completion".
    let anyRequested = false
    let anyVerified = false
    // Adversarial-audit fix: only TRUST a verified-verdict when EVERY
    // setBreakpoints call actually returned a real response. If any timed
    // out/errored, we can't conclude "couldn't bind" (the adapter, not the
    // binary, is at fault) — leave breakpointsBound undefined (no false NOTE).
    let allResponded = true
    for (const [file, bps] of byFile) {
      anyRequested = anyRequested || bps.length > 0
      const bpRes = await withTimeout<DapResponse>(
        client.request("setBreakpoints", { source: { path: file }, breakpoints: bps }),
        stopTimeoutMs,
        { success: false, message: "setBreakpoints timed out" },
      )
      if (!bpRes.success) {
        allResponded = false
        continue
      }
      if (asArr(asObj(bpRes.body).breakpoints).some((b) => asObj(b).verified === true)) anyVerified = true
    }
    // Break-on-throw: arm exception breakpoints (best-effort — an adapter that
    // doesn't support them just answers an error, which we ignore). MUST be in
    // the config phase, like setBreakpoints, before configurationDone.
    if (spec.exceptionFilters !== undefined && spec.exceptionFilters.length > 0) {
      await withTimeout<DapResponse>(
        client.request("setExceptionBreakpoints", { filters: [...spec.exceptionFilters] }),
        stopTimeoutMs,
        { success: false, message: "setExceptionBreakpoints timed out" },
      )
    }
    await client.request("configurationDone")

    // Race the breakpoint hit against the program terminating / launch failing.
    type StopRace =
      | { kind: "stopped"; body: unknown }
      | { kind: "terminated" }
      | { kind: "launchfail"; message: string }
      | { kind: "timeout" }
    const stopped = await withTimeout<StopRace | typeof ABORTED>(
      Promise.race<StopRace | typeof ABORTED>([
        stoppedP.then((b) => ({ kind: "stopped", body: b })),
        terminatedP.then(() => ({ kind: "terminated" })),
        launchFailP,
        abortP,
      ]),
      stopTimeoutMs,
      { kind: "timeout" },
    )
    if (stopped === ABORTED) {
      client.dispose()
      return { outcome: "error", message: "aborted" }
    }
    if (stopped.kind === "launchfail") {
      client.dispose()
      return { outcome: "error", message: stopped.message }
    }
    if (stopped.kind === "terminated")
      return {
        outcome: "exited",
        // Only claim a bind-verdict when breakpoints were requested AND every
        // setBreakpoints call genuinely responded (see allResponded above).
        ...(anyRequested && allResponded ? { breakpointsBound: anyVerified } : {}),
      }
    if (stopped.kind === "timeout") {
      client.dispose()
      return { outcome: "error", message: "timed out waiting for breakpoint" }
    }

    const reason = str(asObj(stopped.body).reason, "stopped")
    const threadId = num(asObj(stopped.body).threadId, 1)

    // Post-stop QUERIES must each be timeout-guarded: adapters differ in what
    // they answer while stopped (e.g. lldb-dap does NOT respond to `terminate`
    // at a breakpoint — an unguarded await would hang the tool forever). A timed
    // request degrades to a failure response instead of hanging.
    const queryTimeoutMs = Math.min(stopTimeoutMs, 15_000)
    const timed = (command: string, args?: unknown): Promise<DapResponse> =>
      withTimeout<DapResponse>(client.request(command, args), queryTimeoutMs, {
        success: false,
        message: `${command} timed out`,
      })

    const stRes = await timed("stackTrace", { threadId, startFrame: 0, levels: 20 })
    const rawFrames = asArr(asObj(stRes.body).stackFrames)
    const stack = rawFrames.map((f): StackFrameInfo => {
      const fo = asObj(f)
      const src = asObj(fo.source).path
      return { name: str(fo.name, "?"), line: num(fo.line), ...(typeof src === "string" ? { source: src } : {}) }
    })

    // Capture scopes+locals for the TOP K frames (not just the stop frame) under
    // ONE shared node budget + visited-ref set, so deep callers contribute
    // context but a huge graph can't blow the packet. `frames[0]` = stop frame.
    const budget: VarBudget = { remaining: MAX_TOTAL_VARS }
    const visited = new Set<number>()
    const frames: FrameScopes[] = []
    const framesToCapture = Math.min(rawFrames.length, MAX_FRAMES_WITH_LOCALS)
    for (let i = 0; i < framesToCapture; i++) {
      // A cancelled turn stops capturing further frames immediately (we return
      // whatever we have) rather than waiting out per-query timeouts × frames.
      if (aborted()) break
      const fo = asObj(rawFrames[i])
      const frameId = num(fo.id, 0)
      const scopesRes = await timed("scopes", { frameId })
      const scopes: ScopeVars[] = []
      for (const sc of asArr(asObj(scopesRes.body).scopes)) {
        const so = asObj(sc)
        const ref = num(so.variablesReference)
        if (ref <= 0) continue
        const vars = await expandVariables(timed, ref, 1, budget, visited, opts.signal)
        if (vars.length > 0) scopes.push({ scope: str(so.name, "scope"), vars })
      }
      const src = asObj(fo.source).path
      frames.push({
        frame: str(fo.name, "?"),
        line: num(fo.line),
        ...(typeof src === "string" ? { source: src } : {}),
        scopes,
      })
    }
    const topFrameId = num(asObj(rawFrames[0]).id, 0)

    let evaluated: { expression: string; result: string } | undefined
    if (spec.evaluate !== undefined && spec.evaluate.length > 0) {
      const evRes = await timed("evaluate", { expression: spec.evaluate, frameId: topFrameId, context: "repl" })
      if (evRes.success) evaluated = { expression: spec.evaluate, result: str(asObj(evRes.body).result, "") }
    }

    // Concurrency dump: list the live threads (dlv maps goroutines onto DAP
    // threads). Best-effort + bounded; absent when the adapter doesn't answer.
    const thRes = await timed("threads")
    const threads = asArr(asObj(thRes.body).threads)
      .slice(0, MAX_THREADS)
      .map((t) => ({ id: num(asObj(t).id), name: str(asObj(t).name, "?") }))

    // If we stopped ON an exception, pull its type+message (break-on-throw). The
    // `text` on the stopped event is a fallback id when exceptionInfo is absent.
    let exception: { id: string; description: string } | undefined
    if (reason === "exception") {
      const exRes = await timed("exceptionInfo", { threadId })
      if (exRes.success) {
        const eb = asObj(exRes.body)
        exception = { id: str(eb.exceptionId, str(asObj(stopped.body).text, "exception")), description: str(eb.description) }
      } else {
        const text = str(asObj(stopped.body).text)
        if (text.length > 0) exception = { id: text, description: "" }
      }
    }

    // Best-effort teardown — fire `terminate` but NEVER block on it (lldb-dap
    // doesn't answer it at a breakpoint). `dispose()` kills the child process
    // outright, so cleanup is guaranteed regardless of the terminate response.
    await withTimeout(
      client.request("terminate").then(
        () => {},
        (e) => logger.debug(`debug-inspect: best-effort terminate request failed: ${errMessage(e)}`),
      ),
      2_000,
      undefined,
    )
    client.dispose()

    return { outcome: "stopped", reason, stack, frames, ...(evaluated !== undefined ? { evaluated } : {}), ...(exception !== undefined ? { exception } : {}), ...(threads.length > 0 ? { threads } : {}) }
  } catch (e) {
    client.dispose()
    return { outcome: "error", message: e instanceof Error ? e.message : String(e) }
  }
}
