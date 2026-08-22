/**
 * LEAF — the GENERIC family remote-bootstrap lookup.
 *
 * The remote plan builders and (later) box provisioning call this and name no
 * family: a family that needs a box bootstrapped beyond the shared image
 * declares `remoteBootstrap` on its ONE profile object, and every other family
 * returns `undefined` so their lanes stay byte-identical.
 *
 * Derived from the ALREADY-RESOLVED typed `BenchRunConfig`, never from a fresh
 * `process.env` read — the bootstrap must describe the launch that would
 * actually happen, not a second, independently-resolved one.
 */
import type { BenchRunConfig } from "../run-config"
import { resolveDatasetFamilyProfile } from "./registry"
import type { FamilyRemoteBootstrap } from "./types"

export const familyRemoteBootstrap = (cfg: BenchRunConfig): FamilyRemoteBootstrap | undefined =>
  resolveDatasetFamilyProfile(cfg.datasetFamily).remoteBootstrap?.(cfg)

/** The extra dry-run lines a family's bootstrap contributes. Empty when absent. */
export const familyRemoteBootstrapNotes = (cfg: BenchRunConfig): readonly string[] =>
  familyRemoteBootstrap(cfg)?.planNotes ?? []
