/**
 * Layered permission-PROFILE merge — hellgate battery (DETERMINISTIC).
 *
 * Seals `src/permission/profile-layer-merge.ts` (the domain bridge that drives
 * the pure `policy-layers` engine with the permission-profile safety polarity)
 * + harder property-style invariants over `mergeLayered`. NO Math.random — every
 * "property" iterates a FIXED enumeration of permutations / value combinations.
 *
 *   HELL-PLM-01  source-precedence: highest-precedence-PRESENT source wins EVERY
 *                field, over ALL 7 non-empty subsets × ALL their permutations
 *   HELL-PLM-02  most-restrictive: merged field is NEVER less safe than ANY input
 *                layer's value for that field (polarity per PROFILE_RESTRICTIVENESS)
 *   HELL-PLM-03  most-restrictive boolean polarity — both directions
 *                (workspaceWrite:false-safe vs networkIsolated:true-safe)
 *   HELL-PLM-04  override metadata records EVERY superseded source (count+identity)
 *   HELL-PLM-05  same-source double-set supersedes EXACTLY one (drops one winner)
 *   HELL-PLM-06  empty slots ⇒ merged deep-equals DEFAULT, overrides []
 *   HELL-PLM-07  single slot ⇒ that source wins every field it set, overrode []
 *   HELL-PLM-08  fileSystem has NO restrictiveness ⇒ source-precedence fallback
 *                even under most-restrictive
 *   HELL-PLM-09  determinism: every permutation of a slot set ⇒ deeply-equal merged
 */

import { describe, expect, test } from "bun:test"
import {
  type ConfigLayer,
  type LayerSource,
  layerSourceRank,
  type MergeStrategy,
  mergeLayered,
  mergeProfileLayers,
  NAMED_PROFILES,
  type PermissionProfile,
  PROFILE_RESTRICTIVENESS,
} from "@/permission"

// The three named profiles span the safety spectrum:
//   restricted (safest) — always-confirm, deny-all, networkIsolated, no ws write
//   default              — once+prompt, deny-all, networkIsolated, no ws write
//   trusted (least safe) — auto, allow-all, NOT isolated, ws write granted
const { restricted, default: deflt, trusted } = NAMED_PROFILES

/* ----------------------------- enumeration helpers ----------------------------- */

const permute = <X>(arr: readonly X[]): X[][] =>
  arr.length <= 1
    ? [[...arr]]
    : arr.flatMap((x, i) =>
        permute([...arr.slice(0, i), ...arr.slice(i + 1)]).map((rest) => [x, ...rest]),
      )

/** All non-empty subsets of a 3-element source list (7 of them). */
const nonEmptySubsets = <X>(arr: readonly X[]): X[][] => {
  const out: X[][] = []
  for (let mask = 1; mask < 1 << arr.length; mask++) {
    const subset: X[] = []
    for (let i = 0; i < arr.length; i++) if (mask & (1 << i)) subset.push(arr[i] as X)
    out.push(subset)
  }
  return out
}

type SlotSource = "per-user" | "per-repo" | "team-admin"
const SLOT_SOURCES: readonly SlotSource[] = ["per-user", "per-repo", "team-admin"]

const PROFILE_BY_SLOT: Record<SlotSource, PermissionProfile> = {
  "per-user": trusted, // least safe at LOW authority
  "per-repo": deflt,
  "team-admin": restricted, // safest at HIGH authority
}

const buildLayers = (sources: readonly SlotSource[]): ConfigLayer<PermissionProfile>[] =>
  sources.map((s) => ({ source: s as LayerSource, value: PROFILE_BY_SLOT[s] }))

/** Build the `mergeProfileLayers` slot object for a subset (only present sources). */
const slotsFromSubset = (subset: readonly SlotSource[]) => ({
  ...(subset.includes("per-user") ? { perUser: PROFILE_BY_SLOT["per-user"] } : {}),
  ...(subset.includes("per-repo") ? { perRepo: PROFILE_BY_SLOT["per-repo"] } : {}),
  ...(subset.includes("team-admin") ? { teamAdmin: PROFILE_BY_SLOT["team-admin"] } : {}),
})

/* --------------------------------- the battery --------------------------------- */

describe("profile-layer-merge — source-precedence invariant", () => {
  test("HELL-PLM-01 highest-precedence-present source wins every field (all subsets×perms)", () => {
    const fields = Object.keys(deflt) as Array<keyof PermissionProfile>
    for (const subset of nonEmptySubsets(SLOT_SOURCES)) {
      // The most-authoritative present source = the one with the highest rank.
      const expectedWinner = [...subset].sort(
        (a, b) => layerSourceRank(b as LayerSource) - layerSourceRank(a as LayerSource),
      )[0] as SlotSource
      const winnerProfile = PROFILE_BY_SLOT[expectedWinner]
      for (const order of permute(subset)) {
        const { merged } = mergeLayered(buildLayers(order), {
          base: deflt,
          strategy: "source-precedence",
        })
        for (const f of fields) {
          // Every layer sets every field (full profiles), so the winner is the
          // highest-precedence-present source for ALL fields.
          expect(merged[f]).toEqual(winnerProfile[f])
        }
      }
    }
  })
})

describe("profile-layer-merge — most-restrictive safety invariant", () => {
  // restrictiveness rank reused from production polarity (HIGHER = safer).
  const safetyOf = (f: keyof PermissionProfile, p: PermissionProfile): number | undefined => {
    const ranker = PROFILE_RESTRICTIVENESS[f]
    return ranker === undefined ? undefined : ranker(p[f] as never)
  }

  // The merged field's safety must be >= the safety of EVERY input layer in the
  // subset. Extracted so the per-subset loop stays under the complexity cap.
  const assertNeverLessSafe = (
    subset: readonly SlotSource[],
    merged: PermissionProfile,
    f: keyof PermissionProfile,
  ): void => {
    const mergedSafety = safetyOf(f, merged)
    expect(mergedSafety).not.toBeUndefined()
    for (const s of subset) {
      expect(mergedSafety as number).toBeGreaterThanOrEqual(
        safetyOf(f, PROFILE_BY_SLOT[s]) as number,
      )
    }
  }

  test("HELL-PLM-02 merged value NEVER less safe than ANY input layer (all subsets)", () => {
    const rankedFields = Object.keys(PROFILE_RESTRICTIVENESS) as Array<keyof PermissionProfile>
    for (const subset of nonEmptySubsets(SLOT_SOURCES)) {
      const { merged } = mergeProfileLayers(slotsFromSubset(subset), "most-restrictive")
      for (const f of rankedFields) assertNeverLessSafe(subset, merged, f)
    }
  })

  test("HELL-PLM-03 boolean polarity — both directions (ws-write vs network-isolated)", () => {
    // per-user (low authority) carries the SAFER sandbox; team-admin the unsafe.
    const { merged } = mergeProfileLayers(
      { perUser: restricted, teamAdmin: trusted },
      "most-restrictive",
    )
    // restricted is safer on the sandbox axis ⇒ its whole sandbox struct wins.
    expect(merged.sandbox.workspaceWrite).toBe(false) // false-safe direction
    expect(merged.sandbox.networkIsolated).toBe(true) // true-safe direction
    expect(merged.sandbox.readOnly).toBe(true)
  })

  test("HELL-PLM-08 fileSystem has no ordering ⇒ source-precedence fallback", () => {
    // trusted (per-user) grants project write; restricted (team-admin) empty.
    // Under most-restrictive, fileSystem (no ranker) falls back to authority ⇒
    // team-admin (restricted, empty entries) wins fileSystem.
    const { merged } = mergeProfileLayers(
      { perUser: trusted, teamAdmin: restricted },
      "most-restrictive",
    )
    expect(merged.fileSystem.entries.length).toBe(0) // team-admin's empty table won
  })
})

describe("profile-layer-merge — override metadata", () => {
  test("HELL-PLM-04 records EVERY superseded source (count + identity)", () => {
    // All three slots set `approval`; under source-precedence team-admin wins,
    // per-repo + per-user are superseded (most-authoritative first).
    const { overrides } = mergeProfileLayers(
      { perUser: trusted, perRepo: deflt, teamAdmin: restricted },
      "source-precedence",
    )
    const ov = overrides.find((o) => o.field === "approval")
    expect(ov?.winner).toBe("team-admin")
    expect(ov?.overrode).toEqual(["per-repo", "per-user"])
    expect(ov?.overrode.length).toBe(2)
  })

  test("HELL-PLM-05 same-source double-set supersedes EXACTLY one", () => {
    const layers: ConfigLayer<PermissionProfile>[] = [
      { source: "per-repo", value: deflt },
      { source: "per-repo", value: trusted },
    ]
    const { merged, overrides } = mergeLayered(layers, {
      base: deflt,
      strategy: "source-precedence",
    })
    // Later same-source declaration wins the value.
    expect(merged.approval).toEqual(trusted.approval)
    const ov = overrides.find((o) => o.field === "approval")
    expect(ov?.winner).toBe("per-repo")
    expect(ov?.overrode).toEqual(["per-repo"]) // EXACTLY one superseded
    expect(ov?.overrode.length).toBe(1)
  })
})

describe("profile-layer-merge — identity + determinism", () => {
  test("HELL-PLM-06 empty slots ⇒ merged deep-equals DEFAULT, overrides []", () => {
    for (const strat of ["source-precedence", "most-restrictive"] as MergeStrategy[]) {
      const { merged, overrides } = mergeProfileLayers({}, strat)
      expect(merged).toEqual(deflt)
      expect(overrides).toEqual([])
    }
  })

  test("HELL-PLM-07 single slot ⇒ that source wins every field, overrode []", () => {
    // ADR-0470 — uses the guard-NEUTRAL `perUser` source. (Previously `perRepo`,
    // but the provenance guard now drops a repo-controllable source's grant-capable
    // WIDENS under source-precedence, so a single per-repo slot no longer "wins
    // every field" by design — that secure behavior is sealed in
    // config-provenance-gate-hellgate.test.ts. The identity/determinism invariant
    // this test guards is source-agnostic, so per-user proves it cleanly.)
    const { merged, overrides } = mergeProfileLayers({ perUser: trusted }, "source-precedence")
    const fields = Object.keys(deflt) as Array<keyof PermissionProfile>
    for (const f of fields) expect(merged[f]).toEqual(trusted[f])
    for (const o of overrides) expect(o.overrode).toEqual([])
  })

  test("HELL-PLM-09 every permutation of a slot set ⇒ deeply-equal merged", () => {
    for (const strat of ["source-precedence", "most-restrictive"] as MergeStrategy[]) {
      const canonical = JSON.stringify(
        mergeLayered(buildLayers(SLOT_SOURCES), { base: deflt, strategy: strat }),
      )
      for (const order of permute(SLOT_SOURCES)) {
        const got = JSON.stringify(
          mergeLayered(buildLayers(order), { base: deflt, strategy: strat }),
        )
        expect(got).toBe(canonical)
      }
    }
  })
})
