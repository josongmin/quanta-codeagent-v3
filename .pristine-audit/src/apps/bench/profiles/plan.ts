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
import { resolveDatasetFamilyProfile } from "./registry"

export const familyPlanNotes = (cfg: BenchRunConfig): readonly string[] =>
  resolveDatasetFamilyProfile(cfg.datasetFamily).planNotes?.(cfg) ?? []
