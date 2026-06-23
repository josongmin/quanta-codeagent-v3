/**
 * `host/runtime/agent-arg-builder/observability-wire.ts` — extracted from
 * `agent-arg-builder.ts` (god-module split). The composition-root observability
 * cluster: adapt the live {@link HookBus} to the wire's duck-typed bus, resolve
 * the wire handle from `QUANTA_OBSERVABILITY`, and project the conditional
 * AgentConfig slot fragment. The public `resolveObservabilityWire` surface is
 * re-exported from `agent-arg-builder.ts` byte-compatibly.
 */

import { HookBus } from "@/agent"
import {
  type ObservabilityHookBus,
  type ObservabilityWireHandle,
  wireObservability,
} from "@/agent/observability-wire"
import type { AssembleRequest } from "@/host/runtime/agent-config-assembler"
import { gateOn } from "@/shared"

/**
 * ADR-0415 — adapt a live {@link HookBus} to the duck-typed
 * {@link ObservabilityHookBus} surface the wire consumes. The wire NEVER
 * imports `@/agent/hooks` (slice fence), so the composition root owns the
 * adapter.
 *
 * `HookBus.on(type, handler)` returns `this` (no public unsubscribe path —
 * handlers are registered once at startup), so `subscribe()` returns a NO-OP
 * detach closure. The wire's `handle.detach()` is idempotent + drops its own
 * refs regardless; a no-op host unsubscribe is the documented contract (see
 * `observability-wire/types.ts`). A throwing `on()` propagates so the wire's
 * own try/catch degrades the subscription to inert (ports still populate).
 */
const toObservabilityHookBus = (bus: HookBus): ObservabilityHookBus => ({
  subscribe: (event, handler) => {
    bus.on(event, handler as never)
    // hooks.ts exposes no `off()` — the registration is permanent for the
    // process lifetime. handle.detach() drops the wire's local refs.
    return () => undefined
  },
})

/**
 * ADR-0404 + ADR-0415 — composition-root observability wire. Returns the wire
 * handle (4 ports + idempotent NO-THROW detach) when `QUANTA_OBSERVABILITY ===
 * "on"`; otherwise the noop handle (no port instances; no hook subscription).
 *
 * The helper is intentionally env-projecting (single canonical knob, strict
 * "on") so the wire itself stays env-agnostic. ADR-0415 closes the deliberate
 * Wave-3 hold: the optional `hookBus` (adapted from the surface's live
 * {@link HookBus}) is forwarded so run-ledger-attribution actually subscribes
 * to `post_tool_use` in production. Absent ⇒ ports still populate but
 * attribution is silently inert (legacy Wave-3 behavior, preserved for callers
 * that do not thread a bus).
 *
 * Default-OFF byte-identical: `QUANTA_OBSERVABILITY !== "on"` ⇒ noop handle
 * ⇒ every conditional spread at the call site sees `undefined` ⇒ slots OMITTED
 * ⇒ AgentConfig is byte-identical to the legacy path (RFC §1.2).
 */
export const resolveObservabilityWire = (
  env: NodeJS.ProcessEnv,
  opts: { readonly hookBus?: HookBus } = {},
): ObservabilityWireHandle =>
  wireObservability({
    enabled: gateOn(env, "QUANTA_OBSERVABILITY"),
    repoRoot: process.cwd(),
    // ADR-0415 — forward the adapted live bus so attribution subscribes to
    // `post_tool_use`. Omitted ⇒ ports populate, attribution stays inert.
    ...(opts.hookBus !== undefined ? { hookBus: toObservabilityHookBus(opts.hookBus) } : {}),
  })

/**
 * ADR-0415 — resolve the observability wire + project it into the conditional
 * AgentConfig slot fragment in ONE call. When `QUANTA_OBSERVABILITY === "on"`,
 * mints the canonical {@link HookBus} (the same bus the loop emits
 * `post_tool_use` to), wires attribution onto it, and returns the four ports
 * + the bus as `hooks`. Gate OFF ⇒ no bus is constructed and `slots` is `{}`
 * (byte-identical default-OFF; `base.hooks` stays untouched for the knobs
 * layer). Extracted from `buildBaseFromArgs` to keep that function under
 * biome's cognitive-complexity cap. Every field is presence-only.
 */
export const resolveObservabilitySlots = (
  env: NodeJS.ProcessEnv,
): Partial<
  Pick<
    AssembleRequest["base"],
    "hooks" | "objective" | "runLedger" | "approvalStateMachine" | "shadowVerify"
  >
> => {
  const bus = gateOn(env, "QUANTA_OBSERVABILITY") ? new HookBus() : undefined
  const wire = resolveObservabilityWire(env, bus !== undefined ? { hookBus: bus } : {})
  return {
    ...(wire.objective !== undefined ? { objective: wire.objective } : {}),
    ...(wire.shadowVerify !== undefined ? { shadowVerify: wire.shadowVerify } : {}),
    ...(wire.runLedger !== undefined ? { runLedger: wire.runLedger } : {}),
    ...(wire.approvalStateMachine !== undefined
      ? { approvalStateMachine: wire.approvalStateMachine }
      : {}),
    ...(bus !== undefined ? { hooks: bus } : {}),
  }
}
