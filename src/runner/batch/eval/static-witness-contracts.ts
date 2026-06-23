/**
 * Static-witness -> public-contract bridge (SCAFF-05).
 *
 * PURE builder that converts AUTHORITATIVE {@link StaticWitness}es into REQUIRED
 * {@link PublicContract}s, so the clean selector gains a hard contract-dominance
 * obligation to prefer a COMPLETE co-change family before minimality can win.
 *
 * Mapping (authoritative witnesses ONLY — advisory contributes ZERO):
 *  - `override-family`        -> required `multi-site-family` over its subjectFiles (needs >= 2 files)
 *  - `producer-consumer`      -> required `multi-site-family` over its subjectFiles (needs >= 2 files)
 *  - `registration-callback`  -> required `multi-site-family` over its subjectFiles (needs >= 2 files)
 *  - `unique-symbol-definer`  -> required `owner-must-touch` over its single subjectFile
 *
 * No-fake guard: only witnesses where {@link canBeCleanAuthority} is true can
 * produce a contract. Advisory or forbidden-provenance witnesses produce nothing.
 * A multi-site mapping additionally requires {@link canBeMultiSiteObligation}
 * (>= 2 files); a witness with < 2 files yields no multi-site contract.
 *
 * The actual {@link PublicContract} construction is delegated to the existing
 * builders ({@link buildMultiSiteFamilyContract} / {@link buildOwnerMustTouchContracts}),
 * which already set provenance `static-witness` and strength `required`. Results
 * are deduped by `contractId`.
 *
 * PURE + deterministic: no I/O, no LLM, no clock/random. Carries NO benchmark /
 * grader-shaped authority — see static-witness.ts provenance invariants.
 */

import {
  buildMultiSiteFamilyContract,
  buildOwnerMustTouchContracts,
} from "@/runner/batch/eval/public-contract-bundle"
import type { PublicContract } from "@/runner/batch/eval/public-contract-types"
import {
  canBeCleanAuthority,
  canBeMultiSiteObligation,
  type StaticWitness,
  type StaticWitnessKind,
} from "@/runner/batch/eval/static-witness"

/** Witness kinds that map to a required `multi-site-family` co-change obligation. */
const MULTI_SITE_FAMILY_KINDS: ReadonlySet<StaticWitnessKind> = new Set<StaticWitnessKind>([
  "override-family",
  "producer-consumer",
  "registration-callback",
])

/** Witness kinds that map to a required single-file `owner-must-touch` obligation. */
const OWNER_MUST_TOUCH_KINDS: ReadonlySet<StaticWitnessKind> = new Set<StaticWitnessKind>([
  "unique-symbol-definer",
])

/**
 * Map ONE authoritative witness to the contracts it licenses. A witness that is
 * not clean authority, or whose kind has no mapping, contributes `[]`.
 */
const contractsForWitness = (witness: StaticWitness): PublicContract[] => {
  if (!canBeCleanAuthority(witness)) return []

  if (MULTI_SITE_FAMILY_KINDS.has(witness.kind)) {
    if (!canBeMultiSiteObligation(witness)) return []
    return buildMultiSiteFamilyContract(witness.subjectFiles)
  }

  if (OWNER_MUST_TOUCH_KINDS.has(witness.kind)) {
    return buildOwnerMustTouchContracts(witness.subjectFiles)
  }

  return []
}

/**
 * Convert a list of static witnesses into the required public contracts they
 * license, deduped by `contractId` (first-seen order preserved).
 */
export const buildStaticWitnessContracts = (
  witnesses: readonly StaticWitness[],
): PublicContract[] => {
  const byId = new Map<string, PublicContract>()
  for (const witness of witnesses) {
    for (const contract of contractsForWitness(witness)) {
      if (!byId.has(contract.contractId)) byId.set(contract.contractId, contract)
    }
  }
  return [...byId.values()]
}
