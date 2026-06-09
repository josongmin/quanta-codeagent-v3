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
}

export interface StackFrameInfo {
  readonly name: string
  readonly line: number
  readonly source?: string
}
export interface ScopeVars {
  readonly scope: string
  readonly vars: readonly { readonly name: string; readonly value: string }[]
}
export type Inspection =
  | {
      readonly outcome: "stopped"
      readonly reason: string
      readonly stack: readonly StackFrameInfo[]
      readonly variables: readonly ScopeVars[]
      readonly evaluated?: { readonly expression: string; readonly result: string }
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
    const frames = asArr(asObj(stRes.body).stackFrames).map((f): StackFrameInfo => {
      const fo = asObj(f)
      const src = asObj(fo.source).path
      return { name: str(fo.name, "?"), line: num(fo.line), ...(typeof src === "string" ? { source: src } : {}) }
    })

    const variables: ScopeVars[] = []
    const topFrameId = num(asObj(asArr(asObj(stRes.body).stackFrames)[0]).id, 0)
    const scopesRes = await timed("scopes", { frameId: topFrameId })
    for (const sc of asArr(asObj(scopesRes.body).scopes)) {
      const so = asObj(sc)
      const ref = num(so.variablesReference)
      if (ref <= 0) continue
      const vRes = await timed("variables", { variablesReference: ref })
      variables.push({
        scope: str(so.name, "scope"),
        // Drop debugpy's presentation-group pseudo-entries ("special variables",
        // "function variables", "class variables") — they carry an empty scalar
        // `value` (they exist only as lazy-expand UI nodes). A real empty string
        // renders as `''` (quoted), never "", so this filter is value-safe.
        vars: asArr(asObj(vRes.body).variables)
          .map((v) => {
            const vo = asObj(v)
            return { name: str(vo.name, "?"), value: str(vo.value, "") }
          })
          .filter((v) => v.value !== ""),
      })
    }

    let evaluated: { expression: string; result: string } | undefined
    if (spec.evaluate !== undefined && spec.evaluate.length > 0) {
      const evRes = await timed("evaluate", { expression: spec.evaluate, frameId: topFrameId, context: "repl" })
      if (evRes.success) evaluated = { expression: spec.evaluate, result: str(asObj(evRes.body).result, "") }
    }

    // Best-effort teardown — fire `terminate` but NEVER block on it (lldb-dap
    // doesn't answer it at a breakpoint). `dispose()` kills the child process
    // outright, so cleanup is guaranteed regardless of the terminate response.
    await withTimeout(
      client.request("terminate").then(() => {}).catch(() => {}),
      2_000,
      undefined,
    )
    client.dispose()

    return { outcome: "stopped", reason, stack: frames, variables, ...(evaluated !== undefined ? { evaluated } : {}) }
  } catch (e) {
    client.dispose()
    return { outcome: "error", message: e instanceof Error ? e.message : String(e) }
  }
}
