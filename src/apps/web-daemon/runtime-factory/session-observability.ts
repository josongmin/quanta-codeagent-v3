/**
 * `@/apps/web-daemon/runtime-factory/session-observability` — ONE
 * responsibility: the PER-SESSION observability wire for the web surface.
 *
 * Three collaborating pieces of the same story (ADR-0404 / ADR-0415):
 *   1. `toObservabilityHookBus` — adapt the live `@/agent` `HookBus` to the
 *      duck-typed bus the slice-fenced wire consumes.
 *   2. `wireSessionObservability` — mint the bus + the four ports for ONE
 *      session (gated on `QUANTA_OBSERVABILITY`).
 *   3. `observabilitySlots` — project that wire onto the conditional
 *      `AgentConfig` slot fragment the session config spreads.
 *
 * Default-OFF byte-identical: gate off ⇒ noop handle + `undefined` bus ⇒
 * `observabilitySlots` returns `{}`.
 *
 * Extracted verbatim from `../runtime-factory.ts` (god-module split); that
 * module re-exports `wireSessionObservability`, so no importer moves. The edge
 * is ONE-WAY — the parent imports this file.
 */

import type { AgentConfig } from "@/agent"
import { HookBus } from "@/agent"
import {
  type ObservabilityHookBus,
  type ObservabilityWireHandle,
  wireObservability,
} from "@/agent/observability-wire"
import { resolveGatedObjectiveAuthority } from "@/host/runtime/objective-store-wire"
import { gateOn } from "@/shared"

/**
 * ADR-0415 — adapt a live {@link HookBus} to the duck-typed
 * {@link ObservabilityHookBus} the wire consumes (slice fence: the wire never
 * imports `@/agent/hooks`). `HookBus.on()` has no public unsubscribe, so the
 * detach is a no-op; `handle.detach()` drops the wire's local refs regardless.
 */
const toObservabilityHookBus = (bus: HookBus): ObservabilityHookBus => ({
  subscribe: (event, handler) => {
    bus.on(event, handler as never)
    return () => undefined
  },
})

/**
 * ADR-0415 — project the per-session observability wire into the conditional
 * AgentConfig slot fragment. Extracted from the factory closure to keep that
 * closure under biome's cognitive-complexity cap as the spread count grows.
 * Pure: every field is presence-only (absent ⇒ slot omitted; default-OFF
 * byte-identical under `exactOptionalPropertyTypes`).
 */
export const observabilitySlots = (observability: {
  readonly handle: ObservabilityWireHandle
  readonly bus: HookBus | undefined
}): Partial<
  Pick<AgentConfig, "hooks" | "objective" | "runLedger" | "approvalStateMachine" | "shadowVerify">
> => {
  const { handle, bus } = observability
  return {
    ...(bus !== undefined ? { hooks: bus } : {}),
    ...(handle.objective !== undefined ? { objective: handle.objective } : {}),
    ...(handle.runLedger !== undefined ? { runLedger: handle.runLedger } : {}),
    ...(handle.approvalStateMachine !== undefined
      ? { approvalStateMachine: handle.approvalStateMachine }
      : {}),
    ...(handle.shadowVerify !== undefined ? { shadowVerify: handle.shadowVerify } : {}),
  }
}

/**
 * ADR-0404 + ADR-0415 — per-session observability wire for the web-daemon
 * surface. Mints the canonical {@link HookBus} the loop emits `post_tool_use`
 * to (the SAME bus run-ledger-attribution subscribes to) and stitches the four
 * ports together. Default-OFF byte-identical: `QUANTA_OBSERVABILITY !== "on"`
 * ⇒ `bus` is `undefined`, the wire is the shared noop handle, every port is
 * absent ⇒ the session config + facade are byte-identical to the legacy path.
 */
export const wireSessionObservability = (
  env: Record<string, string | undefined>,
  cwd: string,
): { readonly handle: ObservabilityWireHandle; readonly bus: HookBus | undefined } => {
  if (!gateOn(env, "QUANTA_OBSERVABILITY")) {
    return { handle: wireObservability(), bus: undefined }
  }
  const bus = new HookBus()
  // RFC-03 H1 — the ONE GATED session-stable objective authority (no longer UNGATED);
  // `confirmationAvailable:false` (web has no `onConfirm`) ⇒ FAIL-CLOSED, TOOLS off ⇒ no leak.
  const objective = resolveGatedObjectiveAuthority(env, { confirmationAvailable: false })
  const handle = wireObservability({
    enabled: true,
    repoRoot: cwd,
    ...(objective !== undefined ? { objective } : {}),
    hookBus: toObservabilityHookBus(bus),
  })
  return { handle, bus }
}
