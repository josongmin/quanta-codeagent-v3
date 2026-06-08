/**
 * `@/capability/descriptor.ts` — the cross-surface CAPABILITY descriptor
 * (ADR-0503 P3 / RFC §4, "Capability layer").
 *
 * PROBLEM (split-brain). A feature's exposure on each invocation surface — the
 * LLM tool list (manifest), a slash command, an auto-loaded skill, a subscribed
 * hook — is today decided by EACH surface reading the env gate independently. The
 * two reads drift (tool ON / slash OFF) — the recurring split-brain bug class.
 *
 * FIX. A capability DECLARES, in ONE place, (a) the single env gate that arms it
 * and (b) WHICH surfaces it exposes on. Every surface then derives its exposure
 * from the SAME declaration via {@link resolveExposure}, so the decision has one
 * source of truth.
 *
 * PURE DATA — no imports, no env reads. The whole layer is behind the master
 * `QUANTA_CAPABILITY_LAYER` gate (default-OFF, byte-identical degrade): until
 * that is on, this declaration is consumed only by the consistency PROBE, never
 * by a live surface gate. This is the smaller descriptor shape the P3 proof
 * needs (single env gate, boolean per-surface flags); the richer RFC §4.2 shape
 * (composite gates / per-surface opt-in / named tool groups) is a later layer.
 */

/** The invocation surfaces a capability can be exposed on. */
export type Surface = "llmTool" | "slash" | "skill" | "hook" | "thinClient"

/** Which surfaces a capability exposes on. A surface is exposed iff its flag is
 *  explicitly `true`; absent / `false` ⇒ not exposed on that surface. */
export interface CapabilitySurfaces {
  readonly llmTool?: boolean
  readonly slash?: boolean
  readonly skill?: boolean
  readonly hook?: boolean
  readonly thinClient?: boolean
}

/**
 * An ADDITIONAL env gate a capability's real exposure ALSO depends on (a
 * COMPOSITE gate). `envKey` is the gate; `defaultOn` mirrors the REAL assembly's
 * default for that gate so the prediction matches reality byte-for-byte:
 *   - `defaultOn: false` ⇒ `gateOn(env, envKey)` semantics (default-OFF opt-in).
 *   - `defaultOn: true`  ⇒ `readBool(env[envKey], true)` semantics (default-ON,
 *     i.e. UNSET / "" / unrecognized ⇒ ON; only a falsy token disables).
 * (e.g. workflow's `run_workflow` tool is registered only when BOTH its own gate
 * QUANTA_WORKFLOW AND the parent subagent gate QUANTA_SUBAGENT [default-ON] are
 * truthy — `enabled && (QUANTA_WORKFLOW ?? false)` in apps/cli/internal.ts.)
 */
export interface CapabilityRequire {
  /** The additional env gate that must ALSO be truthy for exposure. */
  readonly envKey: `QUANTA_${string}`
  /** The REAL assembly default for this gate — mirror it so the env-only
   *  prediction agrees with the assembled exposure (NOT an opinion: it is what
   *  the source `readCliKnob(envKey,"bool") ?? <default>` resolves to). */
  readonly defaultOn: boolean
}

/** A single cross-surface capability declaration. */
export interface CapabilityDescriptor {
  /** Stable identifier (e.g. "workflow", "artifact-store"). */
  readonly id: string
  /** The single env gate that arms this capability. */
  readonly gate: { readonly envKey: `QUANTA_${string}` }
  /** Which invocation surfaces it exposes on. */
  readonly surfaces: CapabilitySurfaces
  /** Human-readable one-liner (catalog / discoverability). */
  readonly describe: string
  /**
   * ADDITIONAL env gates that must ALSO be truthy for the REAL exposure — the
   * COMPOSITE gate. Absent ⇒ no extra gate (the lone `gate.envKey` decides), so
   * caps without a composite gate stay byte-identical. Each entry carries the
   * real assembly default (see {@link CapabilityRequire}) so the prediction
   * matches the assembled exposure across the env matrix.
   */
  readonly requires?: readonly CapabilityRequire[]
}
