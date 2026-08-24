/**
 * W5 — CDP launch+inspect driver for NODE (the Chrome DevTools Protocol analogue
 * of {@link inspectViaDap}). Drives the canonical sequence to run a node program
 * under `--inspect-brk`, stop at a failure-line breakpoint, and snapshot the
 * top-K frames' locals (with DAP-parity bounded nested expansion + type), then
 * returns the SAME {@link Inspection} shape — so the evidence mapper (`toRuntime`)
 * is carrier-agnostic across DAP and CDP.
 *
 * Sequence: Runtime.enable → Debugger.enable → Debugger.setBreakpointByUrl →
 * Runtime.runIfWaitingForDebugger → (skip the `--inspect-brk` entry pause) →
 * Debugger.paused@ourBp → Debugger.getScopes via callFrames → Runtime.getProperties[*]
 * → snapshot. Every wait is timeout-guarded + abort-aware, so a wedged inspector
 * can never hang the tool.
 */
import { errMessage, logger } from "@/shared"
import type { CdpClient } from "./cdp-client"
import type {
  DapVariable,
  FrameScopes,
  Inspection,
  ScopeVars,
  StackFrameInfo,
} from "./inspect-driver"

export interface CdpInspectSpec {
  /** file:// URL of the breakpoint source (the failing test file). */
  readonly url: string
  /** 1-based failure line (converted to CDP's 0-based internally). */
  readonly line: number
  /** Break-on-throw: when set, `Debugger.setPauseOnExceptions` arms a pause at
   *  the throw site (CDP's analogue of DAP exception filters) — caught by REASON
   *  ("exception"), not a breakpoint id. */
  readonly pauseOnExceptions?: "none" | "uncaught" | "all"
}

export interface CdpInspectOptions {
  readonly stopTimeoutMs?: number
  readonly signal?: AbortSignal
}

const DEFAULT_STOP_TIMEOUT_MS = 20_000
// Mirror the DAP driver's capture bounds (resource caps, not heuristics).
const MAX_FRAMES_WITH_LOCALS = 3
const MAX_VAR_DEPTH = 2
const MAX_CHILDREN_PER_VAR = 16
const MAX_TOTAL_VARS = 200
/** Cap on entry/other pauses we resume past before giving up (defends against a
 *  pause storm; the real flow needs at most one resume past the entry break). */
const MAX_RESUMES = 8

const asObj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {}
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback)
const num = (v: unknown, fallback = 0): number => (typeof v === "number" ? v : fallback)

const withTimeout = <T>(p: Promise<T>, ms: number, onTimeout: T): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout), ms)
  })
  return Promise.race([
    p.then((v) => {
      if (timer) clearTimeout(timer)
      return v
    }),
    timeout,
  ])
}

/** Render a CDP RemoteObject's value in a DAP-parity style (strings quoted,
 *  primitives stringified, objects shown by description). */
const renderValue = (ro: Record<string, unknown>): string => {
  const type = str(ro.type)
  if (type === "undefined") return "undefined"
  if (type === "string") return `'${str(ro.value)}'`
  if ("value" in ro && ro.value !== undefined && ro.value !== null) return String(ro.value)
  if (ro.value === null) return "null"
  return str(ro.description) || str(ro.className) || str(ro.subtype) || type
}
const typeOf = (ro: Record<string, unknown>): string =>
  str(ro.className) || str(ro.subtype) || str(ro.type)

interface VarBudget {
  remaining: number
}

/** Recursively expand an object's own data-properties into a BOUNDED
 *  {@link DapVariable} tree (depth/breadth/total caps + visited-id cycle guard),
 *  mirroring the DAP `expandVariables`. */
const expandObject = async (
  getProps: (objectId: string) => Promise<unknown[]>,
  objectId: string,
  depth: number,
  budget: VarBudget,
  visited: Set<string>,
  signal?: AbortSignal,
): Promise<DapVariable[]> => {
  if (
    signal?.aborted === true ||
    objectId.length === 0 ||
    depth > MAX_VAR_DEPTH ||
    budget.remaining <= 0 ||
    visited.has(objectId)
  )
    return []
  visited.add(objectId)
  const props = await getProps(objectId)
  const out: DapVariable[] = []
  for (const p of props) {
    if (budget.remaining <= 0 || out.length >= MAX_CHILDREN_PER_VAR) break
    const rendered = await expandProperty(getProps, p, depth, budget, visited, signal)
    if (rendered !== null) out.push(rendered)
  }
  return out
}

/**
 * Render ONE own property as a {@link DapVariable}, or `null` when it is not a
 * property we show.
 *
 * A unit because it owns the property FILTER together with the budget spend:
 * accessors (no `value`) and `__proto__` are skipped BEFORE `budget.remaining`
 * is decremented, so a skipped property never costs a slot a real one could
 * have used.
 */
const expandProperty = async (
  getProps: (objectId: string) => Promise<unknown[]>,
  p: unknown,
  depth: number,
  budget: VarBudget,
  visited: Set<string>,
  signal?: AbortSignal,
): Promise<DapVariable | null> => {
  const po = asObj(p)
  // Data properties only — skip accessors (getters: no `value`) and __proto__.
  if (!("value" in po) || po.value === undefined) return null
  if (str(po.name) === "__proto__") return null
  const ro = asObj(po.value)
  budget.remaining--
  const childId = str(ro.objectId)
  const type = typeOf(ro)
  // Expand nested objects (objectId present) one+ level deeper.
  const children =
    childId.length > 0 && (str(ro.type) === "object" || str(ro.type) === "function")
      ? await expandObject(getProps, childId, depth + 1, budget, visited, signal)
      : []
  return {
    name: str(po.name, "?"),
    value: renderValue(ro),
    ...(type !== "" ? { type } : {}),
    ...(children.length > 0 ? { children } : {}),
  }
}

/**
 * Whether this `Debugger.paused` event is the stop we armed for.
 *
 * A unit because telling OUR stop from an unrelated one (an entry break, a
 * stray `debugger` statement) is the resume loop's whole job: reading it wrong
 * either resumes straight past the breakpoint or reports someone else's pause
 * as ours. An exception stop only counts when the caller asked for one.
 */
const isTargetStop = (
  body: Record<string, unknown>,
  spec: CdpInspectSpec,
  bpId: string,
): boolean => {
  const hit = asArr(body.hitBreakpoints).map((h) => str(h))
  const isExceptionStop =
    spec.pauseOnExceptions !== undefined &&
    spec.pauseOnExceptions !== "none" &&
    str(body.reason) === "exception"
  return (bpId.length > 0 && hit.includes(bpId)) || isExceptionStop
}

/** Arm/resume loop result: either an early {@link Inspection} the caller must
 *  return verbatim (dispose already done here), or the matched paused body. */
type PausedResolution =
  | { readonly kind: "return"; readonly value: Inspection }
  | { readonly kind: "paused"; readonly body: Record<string, unknown> }

/**
 * Drive the arm→trigger→(resume past unrelated pauses)→our-pause loop until the
 * target breakpoint / exception stop is hit, budget is exhausted, or the turn is
 * aborted. Extracted verbatim from {@link inspectViaCdp} — every `dispose()`,
 * abort-sentinel race, timeout, and CDP request is preserved in the SAME order;
 * `pausedP` (armed by the caller BEFORE the first trigger) is re-armed here before
 * each `Debugger.resume` to keep the fast-inspector race-proofing intact.
 */
const resolvePausedBody = async (
  client: CdpClient,
  spec: CdpInspectSpec,
  initialPausedP: Promise<unknown>,
  stopTimeoutMs: number,
  aborted: () => boolean,
  abortP: Promise<symbol>,
  ABORTED: symbol,
  bpId: string,
  bound: boolean,
): Promise<PausedResolution> => {
  let pausedP = initialPausedP
  let pausedBody: Record<string, unknown> | undefined
  for (let i = 0; i < MAX_RESUMES; i++) {
    if (aborted()) {
      client.dispose()
      return { kind: "return", value: { outcome: "error", message: "aborted" } }
    }
    const ev = await Promise.race([withTimeout(pausedP, stopTimeoutMs, undefined), abortP])
    if (ev === ABORTED) {
      client.dispose()
      return { kind: "return", value: { outcome: "error", message: "aborted" } }
    }
    if (ev === undefined) {
      // No pause within budget: either the program ran to completion (bp never
      // bound) or the inspector wedged. Report exited with the bind verdict.
      client.dispose()
      return {
        kind: "return",
        value: { outcome: "exited", ...(bpId.length > 0 ? { breakpointsBound: bound } : {}) },
      }
    }
    const body = asObj(ev)
    if (isTargetStop(body, spec, bpId)) {
      pausedBody = body
      break
    }
    // Unrelated pause (entry break / debugger statement) — re-arm THEN resume.
    pausedP = client.waitForEvent("Debugger.paused")
    await client.request("Debugger.resume")
  }
  if (pausedBody === undefined) {
    client.dispose()
    return {
      kind: "return",
      value: { outcome: "error", message: "did not stop at the breakpoint" },
    }
  }
  return { kind: "paused", body: pausedBody }
}

/**
 * Split ONE frame's CDP scope chain into the buckets a reader expects.
 *
 * A unit because the merge IS the presentation decision: CDP reports `block`
 * and `catch` bindings separately from `local`, but a human reading a frame
 * thinks of all three as "the locals". Stating the three-way merge and the
 * closure separation together is what keeps them from drifting apart. An empty
 * bucket is omitted rather than rendered as an empty scope.
 */
const splitFrameScopes = async (
  fo: Record<string, unknown>,
  getProps: (objectId: string) => Promise<unknown[]>,
  budget: VarBudget,
  visited: Set<string>,
  signal?: AbortSignal,
): Promise<ScopeVars[]> => {
  const localVars: DapVariable[] = []
  const closureVars: DapVariable[] = []
  for (const sc of asArr(fo.scopeChain)) {
    const so = asObj(sc)
    const kind = str(so.type)
    const objectId = str(asObj(so.object).objectId)
    if (objectId.length === 0) continue
    if (kind === "local" || kind === "block" || kind === "catch")
      localVars.push(...(await expandObject(getProps, objectId, 1, budget, visited, signal)))
    else if (kind === "closure")
      closureVars.push(...(await expandObject(getProps, objectId, 1, budget, visited, signal)))
  }
  const scopes: ScopeVars[] = []
  if (localVars.length > 0) scopes.push({ scope: "Locals", vars: localVars })
  if (closureVars.length > 0) scopes.push({ scope: "Closure", vars: closureVars })
  return scopes
}

/**
 * Snapshot the top-K call frames' locals/closures into {@link FrameScopes},
 * sharing ONE var budget + visited-id set across all frames (so the total cap is
 * global). Extracted verbatim from {@link inspectViaCdp} — CDP local/block/catch
 * scopes merge into "Locals", closures into "Closure", same order and caps.
 */
const captureFrameScopes = async (
  callFrames: readonly unknown[],
  getProps: (objectId: string) => Promise<unknown[]>,
  aborted: () => boolean,
  signal?: AbortSignal,
): Promise<FrameScopes[]> => {
  const budget: VarBudget = { remaining: MAX_TOTAL_VARS }
  const visited = new Set<string>()
  const frames: FrameScopes[] = []
  for (let i = 0; i < Math.min(callFrames.length, MAX_FRAMES_WITH_LOCALS); i++) {
    if (aborted()) break
    const fo = asObj(callFrames[i])
    const loc = asObj(fo.location)
    const url = str(fo.url)
    const scopes = await splitFrameScopes(fo, getProps, budget, visited, signal)
    frames.push({
      frame: str(fo.functionName, "(anonymous)") || "(anonymous)",
      line: num(loc.lineNumber) + 1,
      ...(url.length > 0 ? { source: url } : {}),
      scopes,
    })
  }
  return frames
}

export const inspectViaCdp = async (
  client: CdpClient,
  spec: CdpInspectSpec,
  opts: CdpInspectOptions = {},
): Promise<Inspection> => {
  const stopTimeoutMs = opts.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS
  const aborted = (): boolean => opts.signal?.aborted === true
  // Abort sentinel raced into every wait so a cancelled turn unblocks at once
  // (and tears the inspector down) instead of lingering to the stop timeout.
  const ABORTED = Symbol("aborted")
  const abortP = new Promise<typeof ABORTED>((resolve) => {
    if (opts.signal === undefined) return
    if (opts.signal.aborted) resolve(ABORTED)
    else opts.signal.addEventListener("abort", () => resolve(ABORTED), { once: true })
  })
  if (aborted()) {
    client.dispose()
    return { outcome: "error", message: "aborted" }
  }
  try {
    await client.request("Runtime.enable")
    await client.request("Debugger.enable")
    // Break-on-throw: best-effort (an old inspector just errors — ignored).
    if (spec.pauseOnExceptions !== undefined && spec.pauseOnExceptions !== "none") {
      await client.request("Debugger.setPauseOnExceptions", { state: spec.pauseOnExceptions })
    }
    const bp = await client.request("Debugger.setBreakpointByUrl", {
      lineNumber: Math.max(0, spec.line - 1),
      url: spec.url,
      columnNumber: 0,
    })
    const bpId = str(asObj(bp.result).breakpointId)
    const bound = asArr(asObj(bp.result).locations).length > 0

    // ARM the paused waiter BEFORE the trigger (runIfWaitingForDebugger / each
    // resume) — a fast inspector can emit `Debugger.paused` synchronously, so
    // arming after the trigger would miss it and hang. (Same race-proofing as
    // the DAP driver arming its event waiters before the first request.)
    const pausedP = client.waitForEvent("Debugger.paused")
    await client.request("Runtime.runIfWaitingForDebugger")

    const resolved = await resolvePausedBody(
      client,
      spec,
      pausedP,
      stopTimeoutMs,
      aborted,
      abortP,
      ABORTED,
      bpId,
      bound,
    )
    if (resolved.kind === "return") return resolved.value
    const pausedBody = resolved.body

    const callFrames = asArr(pausedBody.callFrames)
    const stack: StackFrameInfo[] = callFrames.map((f): StackFrameInfo => {
      const fo = asObj(f)
      const loc = asObj(fo.location)
      const url = str(fo.url)
      return {
        name: str(fo.functionName, "(anonymous)") || "(anonymous)",
        line: num(loc.lineNumber) + 1,
        ...(url.length > 0 ? { source: url } : {}),
      }
    })

    const getProps = async (objectId: string): Promise<unknown[]> => {
      const r = await withTimeout(
        client.request("Runtime.getProperties", { objectId, ownProperties: true }),
        Math.min(stopTimeoutMs, 10_000),
        { result: { result: [] } },
      )
      return asArr(asObj(r.result).result)
    }

    const frames = await captureFrameScopes(callFrames, getProps, aborted, opts.signal)

    // Best-effort: let the program finish, then tear down (dispose kills the WS,
    // and the caller kills the node process). A rejecting resume is attributed
    // (not swallowed) so a persistently-failing teardown is visible in telemetry.
    await withTimeout(
      client.request("Debugger.resume").then(
        () => {},
        (e) => logger.debug(`cdp-inspect: best-effort Debugger.resume failed: ${errMessage(e)}`),
      ),
      1_000,
      undefined,
    )
    client.dispose()
    const reason = str(pausedBody.reason, "breakpoint") || "breakpoint"
    // Break-on-throw: map the paused `data` RemoteObject → {type, first message line}.
    let exception: { id: string; description: string } | undefined
    if (reason === "exception") {
      const d = asObj(pausedBody.data)
      const id = str(d.className) || str(d.subtype) || "exception"
      const description = str(d.description).split("\n")[0] ?? ""
      exception = { id, description }
    }
    return {
      outcome: "stopped",
      reason,
      stack,
      frames,
      ...(exception !== undefined ? { exception } : {}),
    }
  } catch (e) {
    client.dispose()
    return { outcome: "error", message: errMessage(e) }
  }
}
