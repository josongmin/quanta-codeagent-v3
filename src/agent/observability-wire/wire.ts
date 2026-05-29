/**
 * ADR-0406 — Composition-root observability wire implementation.
 *
 * `wireObservability(opts) → ObservabilityWireHandle` — see `./types.ts` for
 * the full contract. This file is the ONLY runtime-side surface in the slice.
 *
 * Construction strategy: every port factory is wrapped in a `tryConstruct`
 * helper so a single misbehaving factory degrades to `undefined` on its slot
 * but leaves the other three port slots intact (defense-in-depth — see
 * hellgate "factory failure isolation"). This mirrors the NO-THROW posture
 * the sibling wave-1/2 slices already promise on their own seams.
 *
 * Hook subscription is wrapped similarly: a hook bus that throws on
 * `subscribe(...)` degrades to a noop detach (slot ports remain populated,
 * but attribution is silently not active). The detach closure itself is
 * idempotent + NO-THROW even when the host's unsubscribe-callback throws.
 *
 * Slice fence (enforced by lint + by import-shape): the wave-1/2 sealed
 * slices + their attribution/adapter slices + `@/shared` leaf utils
 * (`errMessage`/`logger` for telemetry on the subscribe/unsubscribe catches)
 * are the ONLY imports. NEVER `@/agent/hooks` (we use the duck-typed
 * `ObservabilityHookBus` instead), NEVER `@/agent/loop`, NEVER
 * `@/agent/dispatch`, NEVER `@/agent/prompt`, NEVER `@/agent/types`. The
 * wire is a leaf module.
 */

import type { ApprovalStateMachinePort } from "@/agent/approval-state-machine"
import { createApprovalStateMachine } from "@/agent/approval-state-machine"
import type { ObjectivePort } from "@/agent/objective"
import { createObjectiveStore } from "@/agent/objective"
import type { RunLedgerPort } from "@/agent/run-ledger"
import { createRunLedger } from "@/agent/run-ledger"
import { createRunLedgerHookSubscriber } from "@/agent/run-ledger-attribution"
import type { ShadowVerifyPort } from "@/agent/shadow-verify"
import { createShadowVerify } from "@/agent/shadow-verify"
import { createShadowVerifyAdapters } from "@/agent/shadow-verify-adapters"
import { errMessage, logger } from "@/shared"
import type { ObservabilityWireHandle, ObservabilityWireOpts } from "./types"

/**
 * Try to construct a port; on throw, return `undefined`. The wire's
 * "single factory failure does not zero out the handle" promise is
 * enforced by wrapping every construction call site in this helper.
 *
 * NO-LOG by design: a host that wants to surface construction failures
 * threads its own try/catch outside the wire — keeping the wire's signal
 * surface tight to the public handle shape.
 */
const tryConstruct = <T>(factory: () => T): T | undefined => {
  try {
    return factory()
  } catch {
    return undefined
  }
}

/**
 * The singular noop detach closure — re-used for both the default-OFF code
 * path AND as the fallback when subscription fails. Hoisted so the
 * default-OFF code path allocates ZERO closures (byte-identical legacy).
 */
const noopDetach = (): void => undefined

/**
 * The singular noop handle — re-used for the default-OFF code path so the
 * gate flip costs ONE comparison + a frozen-object read. The four port
 * slots are absent (each `xxx?: ...` field on the interface; absence is
 * `undefined` under `exactOptionalPropertyTypes`).
 *
 * Frozen so a hostile caller cannot mutate the shared sentinel.
 */
const NOOP_HANDLE: ObservabilityWireHandle = Object.freeze({
  detach: noopDetach,
})

/**
 * Build the four port slot values + the hook-subscriber detach closure.
 * Extracted to keep `wireObservability` under biome's cog-complexity cap
 * once the "enabled === true" code path grows. Pure aside from the (host-
 * provided) factory side effects.
 */
const constructHandleParts = (
  opts: ObservabilityWireOpts,
): {
  readonly objective: ObjectivePort | undefined
  readonly runLedger: RunLedgerPort | undefined
  readonly approvalStateMachine: ApprovalStateMachinePort | undefined
  readonly shadowVerify: ShadowVerifyPort | undefined
  readonly detachSubscription: () => void
} => {
  const now = opts.now

  // 1) Objective + RunLedger first — they have no inter-dependency, so
  //    construction order is irrelevant. Each is independently failure-
  //    isolated.
  const objective = tryConstruct(
    (): ObjectivePort => createObjectiveStore(now !== undefined ? { now } : {}),
  )
  const runLedger = tryConstruct(
    (): RunLedgerPort => createRunLedger(now !== undefined ? { now } : {}),
  )

  // 2) ApprovalStateMachine cross-wires over the two above. We MUST pass
  //    the actually-constructed ports (or `undefined`) — passing a port
  //    that previously threw on construction would re-throw on its first
  //    call inside the ASM. Both slot fields are optional on the
  //    `createApprovalStateMachine` opts (ADR-0403 store accepts both as
  //    `undefined`), so a partial-degrade still yields a working ASM.
  const approvalStateMachine = tryConstruct((): ApprovalStateMachinePort => {
    const asmOpts: Parameters<typeof createApprovalStateMachine>[0] = {}
    if (now !== undefined) asmOpts.now = now
    if (objective !== undefined) asmOpts.objective = objective
    if (runLedger !== undefined) asmOpts.ledger = runLedger
    return createApprovalStateMachine(asmOpts)
  })

  // 3) ShadowVerify needs the real adapters (worktree + V4A + LSP/test).
  //    Missing `repoRoot` ⇒ skip (the adapter signature requires a string;
  //    we honor the contract that shadowVerify is undefined without a fs
  //    anchor). Construction itself is failure-isolated.
  const shadowVerify =
    opts.repoRoot !== undefined
      ? tryConstruct((): ShadowVerifyPort => {
          const deps = createShadowVerifyAdapters(opts.repoRoot as string)
          return createShadowVerify(deps)
        })
      : undefined

  // 4) Attribution subscription — only when (a) the ledger is alive AND
  //    (b) a hookBus was provided. A throwing `subscribe()` degrades to a
  //    noop detach (the ports above stay populated; the slice still
  //    surfaces wave-1/2 outputs to the caller — only the wave-2 hook-
  //    driven attribution is silently inert).
  const detachSubscription = setupSubscription(opts, runLedger)

  return {
    objective,
    runLedger,
    approvalStateMachine,
    shadowVerify,
    detachSubscription,
  }
}

/**
 * Wire the run-ledger attribution closure to the host's hook bus. Returns
 * an idempotent NO-THROW `detach()` closure. Idempotency is enforced by a
 * captured boolean flag so repeat calls are O(1) noops.
 *
 * Three failure modes are all collapsed to "noop detach" (silent inert):
 *   - `runLedger === undefined`  ⇒ no subscriber to wire.
 *   - `opts.hookBus === undefined` ⇒ host opted out of attribution.
 *   - `hookBus.subscribe(...)` THREW ⇒ the bus rejected the registration.
 *
 * In every case the handle's other three port slots are still meaningful
 * (a host that reads `objective` / `runLedger` for state queries gets a
 * live port — it just won't get the bash/subagent/mcp side-effects).
 */
const setupSubscription = (
  opts: ObservabilityWireOpts,
  runLedger: RunLedgerPort | undefined,
): (() => void) => {
  if (runLedger === undefined || opts.hookBus === undefined) return noopDetach
  const subscriber = tryConstruct(() => createRunLedgerHookSubscriber({ ledger: runLedger }))
  if (subscriber === undefined) return noopDetach

  // Adapt the typed `RunLedgerHookHandler` (input = `ObservedToolEvent`)
  // to the duck-typed hookBus surface (input = `unknown`). The subscriber
  // is NO-THROW and validates the inbound event shape internally — passing
  // any payload is safe.
  const handler = (e: unknown): void => subscriber(e as never)

  let unsubscribe: (() => void) | undefined
  try {
    unsubscribe = opts.hookBus.subscribe("post_tool_use", handler)
  } catch (e) {
    // Hook bus rejected the registration — log + fall back to noop detach.
    logger.warn(`observability-wire.subscribe: ${errMessage(e)}`)
    return noopDetach
  }

  let detached = false
  return (): void => {
    if (detached) return
    detached = true
    try {
      unsubscribe?.()
    } catch (e) {
      // Host unsubscribe closure threw — NO-THROW contract: log + swallow.
      logger.warn(`observability-wire.unsubscribe: ${errMessage(e)}`)
    }
    // Drop the closure reference so a long-lived handle does not keep the
    // host's unsubscribe state alive.
    unsubscribe = undefined
  }
}

/**
 * The public seam — see {@link ObservabilityWireOpts} +
 * {@link ObservabilityWireHandle} for the full contract.
 *
 * Default-OFF (RFC §1.2): when `opts.enabled !== true`, returns the shared
 * frozen `NOOP_HANDLE`. ZERO closures allocated; ZERO port factories
 * invoked; ZERO hook subscriptions attempted. The composition root flips
 * the gate via `process.env.QUANTA_OBSERVABILITY === "on"`.
 *
 * NO-THROW: a hostile `opts.hookBus.subscribe(...)` and/or a hostile port
 * factory both degrade to the corresponding slot's fallback (`undefined`
 * for the port; `noopDetach` for the subscription). The wire itself never
 * throws — a caller that wraps it in `try` is being defensive against a
 * contract we have already pinned.
 */
export const wireObservability = (opts: ObservabilityWireOpts = {}): ObservabilityWireHandle => {
  // Strict-equals true — operators must opt in with the literal boolean.
  // A truthy non-true ("true", 1, {}) is NOT a request to wire (this
  // mirrors the env projection in the composition root: only
  // QUANTA_OBSERVABILITY === "on" flips the gate).
  if (opts.enabled !== true) return NOOP_HANDLE

  const parts = constructHandleParts(opts)
  const handle: ObservabilityWireHandle = {
    ...(parts.objective !== undefined ? { objective: parts.objective } : {}),
    ...(parts.runLedger !== undefined ? { runLedger: parts.runLedger } : {}),
    ...(parts.approvalStateMachine !== undefined
      ? { approvalStateMachine: parts.approvalStateMachine }
      : {}),
    ...(parts.shadowVerify !== undefined ? { shadowVerify: parts.shadowVerify } : {}),
    detach: parts.detachSubscription,
  }
  return handle
}
