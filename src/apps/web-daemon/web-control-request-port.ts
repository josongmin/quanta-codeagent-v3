/**
 * QUANTA_CONTROL_REQUEST — web-daemon side of the OUT-OF-BAND INBOUND
 * control-request channel (ADR-0496 A1 live wire).
 *
 * The MISSING PRODUCER for the `drainControlRequests`/`applyControlEffect`
 * surface. The pure planner + the turn-loop drain edge (`pollControlRequests`)
 * shipped in jul-03 A1, but NOTHING fed the port — the protocol was inert. This
 * port is that feed: a browser/IDE client sends a `controlRequest` WS frame, the
 * server peeks it (`peekControlRequest`, mirror of `peekPlanInputAnswer`) and
 * `enqueue`s it here; the turn loop's `pollControlRequests` then `port.next()`s
 * each pending request, plans it against the live allowlists, and applies the
 * effect via the {@link ControlEffectApplier} — landing a REAL mid-session
 * runtime-control change on the host.
 *
 * Architecture (mirrors {@link ./web-user-input-port}): this is NOT a kernel
 * `SessionCommand` — the kernel reducer + its drift contract stay UNTOUCHED. The
 * request rides an out-of-band JSON frame the server peeks BEFORE the session
 * bridge, exactly as the `planInputAnswer` / `followerVerb` frames do.
 *
 * PERMISSION-MODE is the LOAD-BEARING live effect: the applier mutates the
 * daemon's mutable `permission.mode` cell, which the per-turn permission gate
 * reads FRESH each turn — so `set_permission_mode` ACTUALLY changes the gate
 * mid-session (not a logged no-op). The permission axis is fail-closed at the
 * planner (an explicit allowlist is REQUIRED — a model-issued `bypass` is never
 * silently honored).
 *
 * Gate: `QUANTA_CONTROL_REQUEST` (the A1 SSOT). The gate is checked by
 * `pollControlRequests` at the loop, AND the composition root only mints this
 * port under the gate — so gate OFF ⇒ no slot ⇒ the drain never polls ⇒
 * byte-identical (a client's frame falls through to the session bridge as an
 * unknown frame, exactly as before).
 *
 * NO-THROW / BOUNDED: `drainControlRequests` caps the drain and swallows a
 * hostile port/applier; this port's `next()` is a pure queue shift (never
 * throws) and `enqueue` bounds the pending queue so a flooding client cannot
 * grow it without bound.
 *
 * Slice fence: this module lives in `@/apps/web-daemon` and imports only the
 * `@/agent/control-request` port/effect shapes + `@/permission`'s live-cell
 * type. It never imports `@/agent/loop`; the composition root is the only bridge.
 */

import type {
  ContextUsageSnapshot,
  ControlApplyResult,
  ControlEffectApplier,
  ControlRequest,
  ControlRequestContext,
  ControlRequestPort,
} from "@/agent/control-request"
import {
  ALL_PERMISSION_MODES,
  isPermissionMode,
  type PermissionContext,
  type PermissionMode,
} from "@/permission"

/**
 * Upper bound on PENDING control requests. A client that floods the daemon with
 * control frames must not grow the queue without bound between turns; once full,
 * the OLDEST pending request is dropped (a control request is a "latest wins"
 * intent — the freshest set_model/mode is what the user wants). Generous vs any
 * real interactive burst.
 */
export const MAX_PENDING_CONTROL_REQUESTS = 64

/** The permission modes a CONTROL REQUEST may select. A strict subset of the
 *  closed `ALL_PERMISSION_MODES` union: everything except `bypass`, which turns
 *  the approval gate off entirely and must originate from the operator's own
 *  surface rather than from a frame on the wire. Derived from the SSOT so a new
 *  mode is admitted by default and only the escalating one is subtracted —
 *  a hand-written literal would silently drop a future mode instead. */
export const WEB_CONTROL_PERMISSION_MODES: readonly PermissionMode[] = ALL_PERMISSION_MODES.filter(
  (m) => m !== "bypass",
)

/**
 * The handle the composition root wires: `port` + `applier` + `context` go onto
 * `AgentConfig.controlRequest`; `enqueue` is called by the server when a
 * `controlRequest` frame arrives; `pendingCount` for observability + the
 * hellgate's queue-bound assertion.
 */
export interface WebControlRequestPortHandle {
  /** The port the loop's `pollControlRequests` drains each turn. */
  readonly port: ControlRequestPort
  /** The applier the drain routes each planned effect to (mutates the live
   *  permission cell for `set_permission_mode`; the other axes surface via the
   *  optional deps callbacks). */
  readonly applier: ControlEffectApplier
  /** The live allowlists the planner validates against (permission modes are the
   *  closed SSOT set; model/thinking allowlists are host-opt-in). */
  readonly context: ControlRequestContext
  /** Queue an inbound control request (the server calls this from the peeked
   *  frame). Bounded: drops the OLDEST when full (latest-wins). */
  enqueue(req: ControlRequest): void
  /** How many requests are pending (not yet drained by the loop). */
  pendingCount(): number
}

export interface WebControlRequestPortDeps {
  /**
   * The daemon's LIVE mutable permission cell (the getter/setter pair
   * `runtime-factory` builds). `set_permission_mode` writes `.mode` here; the
   * per-turn gate reads it FRESH so the change lands mid-session. REQUIRED — the
   * permission axis is the load-bearing live effect.
   */
  readonly permission: PermissionContext
  /**
   * Optional model allowlist. When present, a `set_model` request is validated
   * against it (off-list ⇒ rejected). Absent ⇒ the planner accepts any model
   * (host opted out of gating that axis).
   *
   * Accepts a GETTER (aug-27) as well as a fixed array: the daemon's candidate
   * set grows when the provider-catalog probe runs (lazily, on the `/model`
   * readout), and the context is read per drain — so a getter admits a
   * just-discovered model without re-minting the port. A fixed array keeps the
   * old semantics verbatim.
   */
  readonly modelAllowlist?: readonly string[] | (() => readonly string[])
  /**
   * aug-27 — the REAL `set_model` leg: persist the pick so the next turn runs it
   * (`web-model-switch.ts` writes the sticky store the loop reads). Absent ⇒ the
   * effect stays the historical observability-only echo, which is what made a
   * client's `set_model` look accepted while every turn kept the old model.
   * MUST NOT throw (a thrown applier abandons the whole control drain). MR-03: it
   * is AWAITED, and its typed result decides whether the client's echo says
   * `model-set` or `rejected` — a switch the store refused must not read as
   * success.
   */
  readonly applyModel?: (model: string) => Promise<ControlApplyResult>
  /** Optional thinking-level allowlist (same posture as {@link modelAllowlist}). */
  readonly thinkingLevels?: readonly string[]
  /**
   * Optional context-usage snapshot for `get_context_usage`. When present, the
   * planner returns a `usage` effect carrying a defensive copy. Read at MINT
   * time (the daemon has no live per-turn usage-supplier seam wired today); a
   * live supplier is the honest follow-up when a usage source exists.
   */
  readonly usage?: ContextUsageSnapshot
  /**
   * Optional observability sink for the NON-permission axes (model / thinking /
   * usage / rejected). It STILL fires for `set_model` alongside
   * {@link applyModel} (the echo is what a client renders); `thinking` / `usage`
   * have no live cell on this surface yet, so for them this remains the honest
   * "surfaced, not faked" path. Absent ⇒ no echo.
   */
  readonly observe?: (effect: {
    readonly kind: "model" | "thinking" | "usage" | "rejected"
    readonly value: string
  }) => void
}

/**
 * Create the web control-request port. One per daemon facade (the composition
 * root mints it under `QUANTA_CONTROL_REQUEST`, alongside the live permission
 * cell it mutates).
 */
export const createWebControlRequestPort = (
  deps: WebControlRequestPortDeps,
): WebControlRequestPortHandle => {
  const queue: ControlRequest[] = []

  const port: ControlRequestPort = {
    next: () => queue.shift() ?? null,
  }

  const enqueue = (req: ControlRequest): void => {
    // Bounded (latest-wins): drop the OLDEST pending request when full so a
    // flooding client cannot grow the queue without bound between turns.
    if (queue.length >= MAX_PENDING_CONTROL_REQUESTS) queue.shift()
    queue.push(req)
  }

  const safeObserve = (kind: "model" | "thinking" | "usage" | "rejected", value: string): void => {
    if (deps.observe === undefined) return
    try {
      deps.observe({ kind, value })
    } catch {
      // NO-THROW: a hostile observability sink must never derail the drain
      // (drainControlRequests would bail the whole drain on a thrown applier).
    }
  }

  // The applier LANDS each planned effect. permission-mode mutates the live cell
  // (load-bearing); the other axes surface via the optional observe sink.
  const applier: ControlEffectApplier = {
    setPermissionMode: (mode) => {
      // The planner already validated `mode` against the closed SSOT allowlist,
      // but re-check at the boundary (defense-in-depth: never write a
      // non-PermissionMode string into the live gate cell).
      if (!isPermissionMode(mode)) return
      deps.permission.mode = mode
    },
    setModel: async (model) => {
      safeObserve("model", model)
      // AWAITED (MR-03). This used to be fire-and-forget, "ordered after the echo
      // so a client sees the acknowledgement even if the host's write path is
      // slow" — which is exactly the defect: the drain runs at the TOP of a turn,
      // so the same turn then read a selection the write had not reached yet and
      // ran the OLD model, while the end-of-turn echo (reading a by-then-updated
      // cell) reported the NEW one. Measured through the real loop: the turn ran
      // the boot model and the store was still empty when the turn ENDED.
      //
      // `applyModel` is no-throw by contract; a rejection here becomes a typed
      // `rejected` effect, so the client's echo stops claiming a switch that the
      // store refused.
      const res = await deps.applyModel?.(model)
      return res ?? { ok: true }
    },
    setThinking: (level) => safeObserve("thinking", level),
    reportUsage: (usage) => safeObserve("usage", JSON.stringify(usage)),
    onRejected: (reason) => safeObserve("rejected", reason),
  }

  // A getter dep is normalized to one thunk; a fixed array is wrapped so the
  // context below has exactly one shape to read.
  const allowlist = deps.modelAllowlist
  const modelAllow: (() => readonly string[]) | undefined =
    allowlist === undefined
      ? undefined
      : typeof allowlist === "function"
        ? allowlist
        : () => allowlist

  const baseContext: ControlRequestContext = {
    // Permission modes: the planner fail-closes on an ABSENT allowlist, so one
    // MUST be supplied for the mode effect to land at all — but supplying the
    // full SSOT set made this file's own header false ("a model-issued `bypass`
    // is never silently honored"), because the set it required CONTAINED
    // `bypass`. The allowlist NARROWS the closed union to the modes that are not
    // a privilege escalation; `bypass` is reachable only from the operator's own
    // surface, never from a control request over the wire.
    permissionModes: WEB_CONTROL_PERMISSION_MODES,
    ...(deps.thinkingLevels !== undefined ? { thinkingLevels: deps.thinkingLevels } : {}),
    // `usage` is read at MINT time; the planner shallow-copies it defensively.
    ...(deps.usage !== undefined ? { usage: deps.usage } : {}),
  }

  // The allowlist is a real GETTER on the object (NOT a spread of one — a spread
  // would copy the value at mint time and freeze the list), so each drain reads
  // the CURRENT candidate set.
  const context: ControlRequestContext =
    modelAllow === undefined
      ? baseContext
      : {
          ...baseContext,
          get modelAllowlist(): readonly string[] {
            return modelAllow()
          },
        }

  return {
    port,
    applier,
    context,
    enqueue,
    pendingCount: () => queue.length,
  }
}
