/**
 * ADR-0406 — Composition-root observability wire (closed contract).
 *
 * Wave-1 + Wave-2 shipped four pure, default-OFF observability ports:
 *
 *   • `@/agent/objective`              — ADR-0394 per-thread Objective store
 *   • `@/agent/run-ledger`             — ADR-0395 in-memory RunLedger store
 *   • `@/agent/approval-state-machine` — ADR-0403 HITL state machine
 *   • `@/agent/shadow-verify`          — ADR-0396/0400 verifier (+ real adapters
 *                                        in `@/agent/shadow-verify-adapters`)
 *
 * Plus the wiring slice:
 *
 *   • `@/agent/run-ledger-attribution` — ADR-0401 `post_tool_use` subscriber
 *
 * Each is a pure typed slice with NO consumers wired at composition time —
 * `AgentConfig.objective` / `AgentConfig.shadowVerify` are spread conditionally
 * and otherwise `undefined`, every downstream consumer no-ops on absence. This
 * ADR closes the wire seam:
 *
 *   1. Instantiate the four ports ONCE per host (factory NO-THROW: a factory
 *      that throws degrades the corresponding port to `undefined`, the other
 *      three still wire — defense-in-depth).
 *   2. Cross-wire `approvalStateMachine` over `objective + runLedger` so
 *      attribution lands in both sibling stores on every `request`/`settle`
 *      (ADR-0403 `__cross_attribution__`).
 *   3. Subscribe `createRunLedgerHookSubscriber({ledger})` to the host's
 *      `post_tool_use` hook bus so the ledger gets real bash/subagent/mcp data
 *      WITHOUT mutating any of those slices (ADR-0401 wave-2 attribution).
 *   4. Return an idempotent NO-THROW `detach()` that unsubscribes the hook
 *      handler and drops references. Detach is safe to call any number of
 *      times.
 *
 * Default-OFF (RFC §1.2): `opts.enabled !== true` ⇒ the wire returns a noop
 * handle. NO port instances are constructed. NO hook handler is registered.
 * The legacy byte-identical path is preserved. The composition root reads
 * `process.env.QUANTA_OBSERVABILITY === "on"` to flip the gate; the wire
 * helper itself is env-free (the env touchpoint lives at the composition
 * root, never inside the slice).
 *
 * Slice fence: imports allowed from `@/agent/objective`,
 * `@/agent/run-ledger`, `@/agent/run-ledger-attribution`,
 * `@/agent/approval-state-machine`, `@/agent/shadow-verify`, and
 * `@/agent/shadow-verify-adapters`. NEVER imports `@/agent/loop`,
 * `@/agent/dispatch`, `@/agent/prompt`, or `@/agent/hooks` — the hook bus is
 * a DUCK-TYPED minimum surface (`subscribe`) on the input opts, NOT a
 * dependency.
 */

import type {
  ApprovalAttributionGap,
  ApprovalStateMachinePort,
} from "@/agent/approval-state-machine"
import type { ObjectivePort } from "@/agent/objective"
import type { RunLedgerPort } from "@/agent/run-ledger"
import type { ShadowVerifyPort } from "@/agent/shadow-verify"

/**
 * Minimum hook-bus surface the wire requires. Duck-typed so the slice fence
 * holds: the wire NEVER imports `@/agent/hooks` (`HookBus`). The host passes
 * an object that exposes a single method — `subscribe(event, handler)` —
 * returning an unsubscribe callback. The `event` literal is `"post_tool_use"`
 * (the only event the wire needs); the handler is the closure produced by
 * `createRunLedgerHookSubscriber({ ledger })`.
 *
 * In practice the composition root passes an adapter:
 *
 *   ```ts
 *   const hookBus = new HookBus(logger)
 *   wireObservability({
 *     enabled: true,
 *     hookBus: {
 *       subscribe: (event, handler) => {
 *         hookBus.on(event, handler as never)
 *         // hooks.ts has no public off() — return a no-op
 *         // (handle.detach() is idempotent + we drop refs).
 *         return () => undefined
 *       },
 *     },
 *   })
 *   ```
 *
 * A host that DOES expose an unsubscribe path returns it from `subscribe()`;
 * the wire forwards it via `handle.detach()`.
 */
export interface ObservabilityHookBus {
  readonly subscribe: (event: "post_tool_use", handler: (e: unknown) => void) => () => void
}

/**
 * Inputs to {@link wireObservability}. ALL fields optional; the `enabled` gate
 * is the single load-bearing field.
 *
 *   - `enabled` — `true` ⇒ instantiate ports + subscribe attribution. Any
 *     other value (incl. `undefined` / `false` / absent) ⇒ NOOP handle
 *     (default-OFF). The composition root projects `QUANTA_OBSERVABILITY ===
 *     "on"` into this field.
 *
 *   - `repoRoot` — required for `shadowVerify` only (the adapters need a
 *     filesystem anchor for the worktree). Absent ⇒ `shadowVerify` stays
 *     `undefined`; the other three ports still wire. The composition root
 *     usually passes `process.cwd()`.
 *
 *   - `now` — clock seam, forwarded to every port factory that accepts one
 *     (`objective` / `runLedger` / `approvalStateMachine`). Absent ⇒ each
 *     factory's own default (`Date.now`) is used. Tests inject a monotone
 *     stepper to lock timestamps.
 *
 *   - `hookBus` — the duck-typed hook bus the wire subscribes the attribution
 *     handler to. Absent ⇒ ports are still instantiated but attribution is
 *     SILENTLY SKIPPED (operator surface keeps the wave-1 slot population —
 *     a host that wants attribution must pass the bus).
 */
export interface ObservabilityWireOpts {
  readonly enabled?: boolean
  readonly repoRoot?: string
  readonly now?: () => number
  readonly hookBus?: ObservabilityHookBus
  /**
   * DOF-40 fail-closed seam. Invoked ONCE per port/subscription slot whose
   * factory or subscription threw during wiring — so a partial-wire failure
   * is SURFACED (which slot went offline is signalled), never silently
   * dropped. Absent ⇒ the failure is still recorded in the handle's
   * {@link ObservabilityWireHandle.degraded} report, but no callback fires
   * (byte-identical default-OFF for callers that do not observe).
   */
  readonly onPortError?: (err: ObservabilityWirePortError) => void
  /**
   * DOF-40 approval attribution-gap sink. A RUNTIME (post-wire) observer for
   * the fail-closed audit gap the approval state machine emits when a terminal
   * mutator (`settle` / `expire` / `cancel`) hits an `approvalId` it holds NO
   * pending record for — i.e. a producer never `request(id)`ed it, so the
   * resolution attributes NOTHING to the Objective / Run Ledger. This wires the
   * SM's own `onUnattributed` producer (already fail-closed at the store) to a
   * REAL consumer the operator can observe.
   *
   * Distinct from {@link onPortError} (a CONSTRUCT-time port/subscription
   * failure): a gap fires LONG after wiring, on every un-attributable
   * resolution, so it is NOT recorded in the point-in-time
   * {@link ObservabilityWireHandle.degraded} report (which is frozen at return
   * and scoped to wiring breakages). Instead, EVERY gap is emitted to the
   * process {@link logger} at `warn` with structured meta (the guaranteed
   * operator-visible floor), and — when supplied — ALSO fanned to this
   * observer. Absent ⇒ the logger floor still fires (a real consumer either
   * way); NEVER a silent drop, NEVER a dead wire.
   *
   * The observer is invoked NO-THROW: a hostile callback cannot break the SM
   * mutator's `null`-return contract (the SM store guards it, and the wire's
   * routing double-guards).
   */
  readonly onApprovalGap?: (gap: ApprovalAttributionGap) => void
}

/** The wire slots that can independently fail to construct/subscribe. */
export type ObservabilityWireSlot =
  | "objective"
  | "runLedger"
  | "approvalStateMachine"
  | "shadowVerify"
  | "attribution"

/** A surfaced partial-wire failure: which slot went offline + the cause. */
export interface ObservabilityWirePortError {
  readonly slot: ObservabilityWireSlot
  readonly message: string
  readonly error: unknown
}

/**
 * A closed enumeration of every wire slot — used both as the offline-report
 * key space and as the drift guard for {@link ObservabilityWireSlot}. Adding a
 * slot to the union WITHOUT adding it here is a compile error.
 */
export const OBSERVABILITY_WIRE_SLOTS = [
  "objective",
  "runLedger",
  "approvalStateMachine",
  "shadowVerify",
  "attribution",
] as const satisfies readonly ObservabilityWireSlot[]

/**
 * Return shape of {@link wireObservability}. Every port field is OPTIONAL:
 *
 *   - All four are PRESENT only when `opts.enabled === true` AND the
 *     corresponding factory did not throw (defense-in-depth — a single
 *     misbehaving factory cannot zero out the whole handle).
 *
 *   - `shadowVerify` additionally requires `opts.repoRoot` (the real adapters
 *     need a fs anchor); absent ⇒ left `undefined` even when the gate is on.
 *
 *   - `detach` is ALWAYS present. When `enabled !== true`, `detach` is the
 *     noop closure (still safe to call). When attribution was subscribed,
 *     `detach` unsubscribes the hook handler + drops local refs. `detach`
 *     is idempotent + NO-THROW: repeated calls do nothing further.
 */
export interface ObservabilityWireHandle {
  readonly objective?: ObjectivePort
  readonly runLedger?: RunLedgerPort
  readonly approvalStateMachine?: ApprovalStateMachinePort
  readonly shadowVerify?: ShadowVerifyPort
  readonly detach: () => void
  /**
   * DOF-40 fail-closed report. Lists EVERY slot whose factory/subscription
   * threw during wiring (empty when the wire was clean or gate-OFF). A
   * partial-wire failure is thus VISIBLE on the returned handle — an
   * operator can read `degraded` to learn WHICH port is offline instead of
   * inferring it from an absent slot (which is ambiguous: absent can mean
   * "opted out" OR "threw"). Present on EVERY handle including the noop.
   */
  readonly degraded: readonly ObservabilityWirePortError[]
}
