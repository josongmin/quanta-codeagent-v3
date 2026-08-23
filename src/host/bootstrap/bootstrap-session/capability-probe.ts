/**
 * `@/host/bootstrap/bootstrap-session/capability-probe` — ADR-0503 P3 read-only
 * capability/surface exposure drift sweep.
 *
 * SINGLE RESPONSIBILITY: observe (never enforce) whether the unified capability
 * resolver and the legacy per-surface own-gate read agree, and surface any
 * split-brain as ONE warn line. Behind the strict master gate
 * `QUANTA_CAPABILITY_LAYER`; OFF ⇒ zero work, zero output.
 *
 * Split out of `bootstrap-session.ts` (god-module cap) — VERBATIM relocation, no
 * behavior delta. One-way edge: the bootstrap prologue imports this; it imports
 * no sibling stage.
 */

import { type CapabilityDescriptor, runCapabilityProbe, type Surface } from "@/capability"
import { errMessage, gateOn, logger, runtimeConfigFromEnv } from "@/shared"

/**
 * ADR-0503 P3 — armed capability consistency probe (READ-ONLY drift sweep).
 *
 * Behind the strict master gate `QUANTA_CAPABILITY_LAYER` (default-OFF). When
 * OFF: {@link runCapabilityProbe} short-circuits to `[]` BEFORE any work, so this
 * function logs nothing and adds ZERO behavior — the un-armed bootstrap path is
 * byte-identical (the #1 invariant). When ON: it sweeps every declared capability
 * × surface, comparing the unified resolver against the legacy per-surface gate,
 * and SURFACES any split-brain (`agrees === false`) as a single `warn` line. It
 * NEVER enforces or replaces a legacy gate — observe-only.
 *
 * The legacy gate is injected: for the seed registry (all `llmTool` caps) the
 * legacy gate is the tool's own env gate, `gateOn(env, cap.gate.envKey)`.
 */
export const probeCapabilityConsistency = (env: NodeJS.ProcessEnv): void => {
  // OBSERVE-ONLY + NON-FATAL: a consistency probe must NEVER be able to break
  // session bootstrap, so the whole body is try-caught (the warn surface is the
  // only effect). This matters especially once `legacyGateFor` is upgraded to the
  // real (throwable) registration predicate — see the SCAFFOLD note below.
  try {
    // Keep the host's injected env path on the same strict parser as
    // `runtimeConfig()`.  `runCapabilityProbe` retains its own early return as
    // defense in depth for direct callers.
    if (!runtimeConfigFromEnv(env).capabilityLayer) return
    // ADR-0503 P3 — REAL composite check. `resolveExposure` now models the
    // COMPOSITE gate (workflow also requires the default-ON parent QUANTA_SUBAGENT),
    // so it is NO LONGER a re-derivation of `gateOn(env, gate.envKey)`. This
    // `legacyGateFor` is exactly that lone own-gate read — the pre-composite
    // predictor each surface used to make in isolation — so when a composite
    // require is OFF while the own gate is
    // ON (e.g. QUANTA_WORKFLOW=1 + QUANTA_SUBAGENT=0) the resolver says NOT-exposed
    // while this lone read says exposed ⇒ `agrees === false` SURFACES the real
    // split-brain (observe-only). The CI declaration↔reality lock lives in
    // tests/unit/capability/capability-exposure-matches-reality-hellgate.test.ts
    // (it drives the actual internal.ts assembly); this runtime probe is the live
    // observe-only drift sweep using the accurate composite prediction.
    const legacyGateFor = (cap: CapabilityDescriptor, _surface: Surface): boolean =>
      gateOn(env, cap.gate.envKey)
    const probes = runCapabilityProbe(env, legacyGateFor)
    const splitBrain = probes.filter((p) => !p.agrees)
    if (splitBrain.length > 0) {
      logger.warn(
        `capability layer: split-brain exposure drift detected (observe-only) on ${splitBrain.length} (capability,surface) pair(s)`,
        {
          drift: splitBrain.map((p) => ({
            capability: p.capabilityId,
            surface: p.surface,
            resolved: p.resolved,
            legacy: p.legacy,
          })),
        },
      )
    }
  } catch (e) {
    logger.warn(`capability probe skipped (non-fatal): ${errMessage(e)}`)
  }
}
