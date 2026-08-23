/**
 * LEAF — the GENERIC family plan-note lookup for remote dry-run plans.
 *
 * The remote plan builders (`remote/full.ts`, `commands/pool.ts`) call this and
 * name no family. A family that wants extra operator-facing detail on a plan
 * declares `planNotes` on its ONE profile object; every other family returns
 * nothing, so their plans stay byte-identical.
 *
 * Notes are derived from the ALREADY-RESOLVED typed `BenchRunConfig`, never from
 * a fresh `process.env` read — the plan must describe the launch that would
 * actually happen, not a second, independently-resolved one.
 */
import type { BenchRunConfig } from "../run-config"
import { familyRemoteBootstrap } from "./bootstrap"
import { familyBootstrapWiringPlanNotes } from "./bootstrap-phase-wiring"
import { resolveDatasetFamilyProfile } from "./registry"

/**
 * A family's own notes, PLUS the one note no family would write about itself:
 * whether the answer-key lifecycle its bootstrap declares is actually executed
 * by anything in production (see `bootstrap-phase-wiring.ts`). Empty for every
 * family whose bootstrap materializes no gold — i.e. all of them but ProMax —
 * so existing plans stay byte-identical.
 */
export const familyPlanNotes = (cfg: BenchRunConfig): readonly string[] => [
  ...(resolveDatasetFamilyProfile(cfg.datasetFamily).planNotes?.(cfg) ?? []),
  ...familyBootstrapWiringPlanNotes(familyRemoteBootstrap(cfg)),
]
