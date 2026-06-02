/**
 * ADR-0121 — Auto-checkpoint EffectChannel wiring helper.
 *
 * Callers (assembly layer) opt into auto-checkpoint by passing `inner` through
 * this wire helper. Default-OFF: no `shadowCheckpoint` config → returns
 * `inner` unchanged. The dispatch seam (`dispatch.ts`) is INTENTIONALLY not
 * modified by this slice — adoption is a one-line wrap at the composition
 * root the day the assembly layer decides to enable the policy:
 *
 *     const channel = wireCheckpointedEffectChannel(localChannel, config)
 *     // ... then pass `channel` everywhere `localChannel` used to flow.
 *
 * The helper has TWO short-circuits that preserve byte-identical behaviour:
 *
 *  1. `config.shadowCheckpoint` ABSENT ⇒ return `inner` (no allocation, no
 *     wrap, no observable change).
 *  2. `config.shadowOdb` ABSENT (but `shadowCheckpoint` present) ⇒ return
 *     `inner`. The policy has no storage port to call so the wrap would
 *     swallow every anchor; we avoid the indirection by short-circuiting
 *     here. Loud-fail is rejected: a misconfigured pair shouldn't crash a
 *     legacy caller that quietly upgraded one slot without the other.
 *  3. `mode === "off"` ⇒ also short-circuits (the wrap's own fast path is
 *     covered as a defense-in-depth, but we avoid building the policy at
 *     all so the layered cost is exactly zero when off).
 *
 * Tool resolution: the wrap needs a `ToolResolver` so the policy's oracle
 * can classify destructiveness from the call name. We delegate to the
 * registry's `get` if available (duck-typed — the registry is a `ToolRegistry`
 * but we only need a `(name) => Tool | undefined` slice of its surface).
 * Composition root supplies a tighter resolver when it cares; default works.
 *
 * # What this file is NOT
 *
 *  - It is NOT a registry import — it depends ONLY on the closed
 *    `CheckpointPolicy` port + the optional `shadowOdb` slot. The tool
 *    resolver is supplied by the caller (composition root) so this slice
 *    never reaches into `@/tool`.
 *  - It is NOT a dispatch-seam edit — `dispatch.ts` is in-flight user work;
 *    this helper exists so the composition root can adopt the wrap without
 *    a dispatch-seam mutation.
 */

import {
  type CheckpointPolicy,
  defaultCheckpointPolicy,
  type ToolResolver,
  withAutoCheckpoint,
} from "./checkpoint-policy"
import type { EffectChannel } from "./effect-channel"
import type { AgentConfig } from "./types"

/** The narrow `AgentConfig` slice this helper reads. Used as the parameter
 *  type so the helper is decoupled from the full config surface and the
 *  composition root can pass either an `AgentConfig` or a hand-built
 *  `Pick<AgentConfig, "shadowOdb" | "shadowCheckpoint">`. */
export type CheckpointWiringConfig = Pick<AgentConfig, "shadowOdb" | "shadowCheckpoint">

/** Build the EffectChannel chain WITH auto-checkpoint wrapped on top of the
 *  base channel. Returns the SAME inner channel when `config.shadowCheckpoint`
 *  is absent OR `config.shadowOdb` is absent OR `mode === "off"` —
 *  byte-identical to the pre-ADR-0121 dispatch path.
 *
 *  `resolveTool` is the registry-level resolver the wrap consults to ask the
 *  policy's oracle about destructiveness. The composition root supplies a
 *  `(name) => registry.get(name)` slice; tests supply a hand-rolled Map. */
export const wireCheckpointedEffectChannel = (
  inner: EffectChannel,
  config: CheckpointWiringConfig,
  resolveTool: ToolResolver,
): EffectChannel => {
  // Short-circuit 1: policy not configured ⇒ byte-identical pass-through.
  const cp = config.shadowCheckpoint
  if (cp === undefined) return inner
  // Short-circuit 2: storage port absent ⇒ no place to anchor to. We refuse
  // to build the wrap rather than burn cycles on a misconfigured pair.
  const odb = config.shadowOdb
  if (odb === undefined) return inner
  // Short-circuit 3: mode "off" ⇒ wrap would be a pass-through anyway. We
  // skip the policy allocation entirely so the layered cost is zero.
  if (cp.mode === "off") return inner

  // Construct the policy with the caller-supplied mode + oracle override.
  // `defaultCheckpointPolicy` reads `cfg.oracle` through exact-optional spread
  // so omitting it does NOT set `oracle: undefined` (would violate
  // `exactOptionalPropertyTypes`). We mirror that posture here: only spread
  // `oracle` when the caller supplied one.
  // ADR-0203 — prefer a caller-supplied session-scoped granular policy so its
  // tag registry SURVIVES across calls (a throwaway default would rebuild an
  // empty registry per call, never accumulating anchors for `/rewind-tool`).
  // `GranularCheckpointPolicy extends CheckpointPolicy`, so the assignment is
  // sound and `withAutoCheckpoint` already takes a plain `CheckpointPolicy`.
  const policy: CheckpointPolicy =
    cp.granularPolicy ??
    defaultCheckpointPolicy({
      mode: cp.mode,
      odb,
      ...(cp.oracle !== undefined ? { oracle: cp.oracle } : {}),
    })

  return withAutoCheckpoint(
    inner,
    policy,
    {
      mode: cp.mode,
      odb,
      ...(cp.oracle !== undefined ? { oracle: cp.oracle } : {}),
    },
    resolveTool,
  )
}
