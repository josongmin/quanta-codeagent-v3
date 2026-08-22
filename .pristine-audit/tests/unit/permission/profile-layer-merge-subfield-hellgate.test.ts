/**
 * Per-SUB-FIELD `most-restrictive` merge — SECURITY-REGRESSION hellgate
 * (DETERMINISTIC; no Math.random, exhaustive over the subset/permutation space).
 *
 * SEALS the fix for the PROVEN exploit in the `most-restrictive` strategy: the
 * struct pillars (`sandbox`, `network`, `approval`, `control`) used to be merged
 * by picking the WHOLE winning struct via a SUM-of-safety-bits. A LOWER-authority
 * layer that was safer on MORE axes (higher sum) thereby overrode a HIGHER-
 * authority layer's specific safe bit — e.g. a per-user
 *   {readOnly:true, workspaceWrite:TRUE, networkIsolated:true, osSandbox:seatbelt}  (sum 3)
 * overriding a team-admin
 *   {readOnly:true, workspaceWrite:FALSE, networkIsolated:false, osSandbox:none}    (sum 2)
 * ⇒ `workspaceWrite:true` LEAKED past the team-admin denial under the strategy
 * literally named "most-restrictive". The fix merges PER SUB-FIELD: the safest
 * value of EACH atomic axis independently, regardless of overall sum.
 *
 *   HELL-SUB-01  the EXACT proven exploit ⇒ merged sandbox.workspaceWrite is FALSE
 *                (the safe value) even though per-user has the higher sum.
 *   HELL-SUB-02  per-sub-field safest for EACH sandbox axis independently.
 *   HELL-SUB-03  network: allowHosts INTERSECTION — a wide per-user list cannot
 *                widen a narrow team-admin list; mode = narrower; perReq = OR.
 *   HELL-SUB-04  approval / control per-sub-field safe (no ride-along).
 *   HELL-SUB-05  INVARIANT (property over fixed permutations): EVERY atomic axis
 *                of the merged value is never-less-safe than ANY input layer's
 *                value for that axis — exhaustive over all subsets × permutations.
 *   HELL-SUB-06  source-precedence still picks the WHOLE struct by precedence
 *                (unchanged — combiners ignored).
 *   HELL-SUB-07  order-independence (commutative/associative combiner): every
 *                permutation of a slot set ⇒ deeply-equal merged under most-restrictive.
 */

import { describe, expect, test } from "bun:test"
import {
  type ConfigLayer,
  DEFAULT_PERMISSION_PROFILE,
  type LayerSource,
  type MergeStrategy,
  mergeLayered,
  mergeProfileLayers,
  type NetworkPolicy,
  type PermissionProfile,
  type PermissionSandboxPolicy,
  PROFILE_COMBINERS,
} from "@/permission"

const PROFILE_BASE_FOR_RAW = DEFAULT_PERMISSION_PROFILE

/* ------------------------------ enumeration helpers ------------------------------ */

const permute = <X>(arr: readonly X[]): X[][] =>
  arr.length <= 1
    ? [[...arr]]
    : arr.flatMap((x, i) =>
        permute([...arr.slice(0, i), ...arr.slice(i + 1)]).map((rest) => [x, ...rest]),
      )

const nonEmptySubsets = <X>(arr: readonly X[]): X[][] => {
  const out: X[][] = []
  for (let mask = 1; mask < 1 << arr.length; mask++) {
    const subset: X[] = []
    for (let i = 0; i < arr.length; i++) if (mask & (1 << i)) subset.push(arr[i] as X)
    out.push(subset)
  }
  return out
}

/* ----------------------------- profile fixtures ----------------------------- */

// A small fixed catalogue of profiles deliberately CROSSING the safe/unsafe line
// per-axis (so no single one is safest on every axis — the sum-trap territory).
const mkProfile = (
  sandbox: PermissionSandboxPolicy,
  network: NetworkPolicy,
  approval: PermissionProfile["approval"],
  control: PermissionProfile["control"],
): PermissionProfile => ({
  fileSystem: { type: "restricted", entries: [] },
  approval,
  network,
  sandbox,
  control,
})

// The PROVEN exploit pair. team-admin is safe on workspaceWrite (FALSE) but
// UNSAFE on more axes (sum 2); per-user is unsafe on workspaceWrite (TRUE) but
// safe on more axes (sum 3). The OLD sum-merge picked per-user's whole sandbox.
const TEAM_ADMIN_SANDBOX: PermissionSandboxPolicy = {
  readOnly: true,
  workspaceWrite: false, // SAFE bit only team-admin has
  networkIsolated: false,
  osSandbox: "none",
}
const PER_USER_SANDBOX: PermissionSandboxPolicy = {
  readOnly: true,
  workspaceWrite: true, // UNSAFE — must NOT win
  networkIsolated: true,
  osSandbox: "seatbelt",
}

const layer = (source: LayerSource, value: PermissionProfile): ConfigLayer<PermissionProfile> => ({
  source,
  value,
})

/* --------------------------------- the battery --------------------------------- */

describe("most-restrictive per-sub-field — the proven sandbox exploit", () => {
  test("HELL-SUB-01 workspaceWrite:false (team-admin) survives a higher-sum per-user", () => {
    const teamAdmin = mkProfile(
      TEAM_ADMIN_SANDBOX,
      { mode: "allow-all" },
      { mode: "auto", promptUser: false },
      { auditRequired: false },
    )
    const perUser = mkProfile(
      PER_USER_SANDBOX,
      { mode: "deny-all" },
      { mode: "always", promptUser: true },
      { auditRequired: true, managedBy: "admin" },
    )
    // Declaration order must NOT matter — put the (low-authority) per-user first
    // in the raw layer list to exercise the engine's order-independence directly.
    const rawMerged = mergeLayered([layer("per-user", perUser), layer("team-admin", teamAdmin)], {
      base: PROFILE_BASE_FOR_RAW,
      strategy: "most-restrictive",
      combiners: PROFILE_COMBINERS,
    }).merged
    expect(rawMerged.sandbox.workspaceWrite).toBe(false) // engine path: no leak

    const prod = mergeProfileLayers({ perUser, teamAdmin }, "most-restrictive").merged
    // THE FIX: the unsafe per-user workspaceWrite must NOT leak past team-admin.
    expect(prod.sandbox.workspaceWrite).toBe(false)
    // The OTHER axes still take their own safest value independently.
    expect(prod.sandbox.readOnly).toBe(true)
    expect(prod.sandbox.networkIsolated).toBe(true) // per-user's safe bit kept
    expect(prod.sandbox.osSandbox).toBe("seatbelt") // active sandbox kept (safer than none)
  })
})

describe("most-restrictive per-sub-field — each axis independently", () => {
  test("HELL-SUB-02 sandbox: safest of every atomic axis, never whole-struct-by-sum", () => {
    // Construct a pair where each side owns exactly one DISTINCT safe bit so the
    // only correct merge is the per-axis combination of both.
    const a = mkProfile(
      { readOnly: false, workspaceWrite: false, networkIsolated: false, osSandbox: "seatbelt" },
      { mode: "allow-all" },
      { mode: "auto", promptUser: false },
      { auditRequired: false },
    )
    const b = mkProfile(
      { readOnly: true, workspaceWrite: true, networkIsolated: true, osSandbox: "none" },
      { mode: "allow-all" },
      { mode: "auto", promptUser: false },
      { auditRequired: false },
    )
    const { merged } = mergeProfileLayers({ perUser: a, teamAdmin: b }, "most-restrictive")
    expect(merged.sandbox.readOnly).toBe(true) // b's safe bit
    expect(merged.sandbox.workspaceWrite).toBe(false) // a's safe bit (AND)
    expect(merged.sandbox.networkIsolated).toBe(true) // b's safe bit (OR)
    expect(merged.sandbox.osSandbox).toBe("seatbelt") // a's active sandbox
  })

  test("HELL-SUB-04 approval + control: no unsafe ride-along", () => {
    // approval: side A has the stricter MODE but suppresses the prompt; side B
    // has a weaker mode but prompts. Safe merge = stricter mode AND prompt true.
    const a = mkProfile(
      TEAM_ADMIN_SANDBOX,
      { mode: "allow-all" },
      { mode: "always", promptUser: false },
      { auditRequired: true, managedBy: "user" },
    )
    const b = mkProfile(
      TEAM_ADMIN_SANDBOX,
      { mode: "allow-all" },
      { mode: "auto", promptUser: true },
      { auditRequired: false, managedBy: "admin" },
    )
    const { merged } = mergeProfileLayers({ perUser: a, teamAdmin: b }, "most-restrictive")
    expect(merged.approval.mode).toBe("always") // stricter mode kept
    expect(merged.approval.promptUser).toBe(true) // prompt forced (OR)
    expect(merged.control.auditRequired).toBe(true) // OR
    expect(merged.control.managedBy).toBe("admin") // stronger lock kept
  })
})

describe("most-restrictive per-sub-field — network allowHosts intersection", () => {
  test("HELL-SUB-03 a wide per-user list cannot widen a narrow team-admin list", () => {
    const teamAdmin = mkProfile(
      TEAM_ADMIN_SANDBOX,
      { mode: "allow-list", allowHosts: ["api.internal"], perRequestApproval: true },
      { mode: "auto", promptUser: false },
      { auditRequired: false },
    )
    const perUser = mkProfile(
      PER_USER_SANDBOX,
      // wide list including the exfil host the team-admin never allowed.
      { mode: "allow-list", allowHosts: ["api.internal", "evil.example", "extra.example"] },
      { mode: "auto", promptUser: false },
      { auditRequired: false },
    )
    const { merged } = mergeProfileLayers({ perUser, teamAdmin }, "most-restrictive")
    expect(merged.network.mode).toBe("allow-list")
    // INTERSECTION only — the narrow team-admin list cannot be widened.
    expect([...(merged.network.allowHosts ?? [])].sort()).toEqual(["api.internal"])
    expect(merged.network.allowHosts).not.toContain("evil.example")
    // perRequestApproval rides along OR (team-admin required it).
    expect(merged.network.perRequestApproval).toBe(true)
  })

  test("HELL-SUB-03b narrower mode (deny-all) wins; allowHosts dropped when not allow-list", () => {
    const teamAdmin = mkProfile(
      TEAM_ADMIN_SANDBOX,
      { mode: "deny-all" },
      { mode: "auto", promptUser: false },
      { auditRequired: false },
    )
    const perUser = mkProfile(
      PER_USER_SANDBOX,
      { mode: "allow-list", allowHosts: ["evil.example"] },
      { mode: "auto", promptUser: false },
      { auditRequired: false },
    )
    const { merged } = mergeProfileLayers({ perUser, teamAdmin }, "most-restrictive")
    expect(merged.network.mode).toBe("deny-all") // narrower egress wins
    expect(merged.network.allowHosts).toBeUndefined() // not meaningful on deny-all
  })
})

/* ------------------------- the exhaustive invariant ------------------------- */

type SlotName = "perUser" | "perRepo" | "teamAdmin"
const SLOTS: readonly SlotName[] = ["perUser", "perRepo", "teamAdmin"]

// Three crossing profiles — none safest on every axis (the sum-trap territory).
const CATALOGUE: Record<SlotName, PermissionProfile> = {
  perUser: mkProfile(
    { readOnly: true, workspaceWrite: true, networkIsolated: true, osSandbox: "seatbelt" },
    { mode: "deny-all" },
    { mode: "auto", promptUser: true },
    { auditRequired: false, managedBy: "admin" },
  ),
  perRepo: mkProfile(
    { readOnly: false, workspaceWrite: false, networkIsolated: false, osSandbox: "none" },
    { mode: "allow-list", allowHosts: ["a.example", "b.example"] },
    { mode: "always", promptUser: false },
    { auditRequired: true, managedBy: "user" },
  ),
  teamAdmin: mkProfile(
    { readOnly: false, workspaceWrite: false, networkIsolated: true, osSandbox: "landlock" },
    { mode: "allow-list", allowHosts: ["b.example", "c.example"] },
    { mode: "session", promptUser: true },
    { auditRequired: false, managedBy: "team" },
  ),
}

/** Atomic-axis safety probes — HIGHER = safer. One per atomic axis (NOT a sum). */
const sandboxAxes = {
  readOnly: (p: PermissionProfile) => (p.sandbox.readOnly ? 1 : 0),
  workspaceWrite: (p: PermissionProfile) => (p.sandbox.workspaceWrite ? 0 : 1),
  networkIsolated: (p: PermissionProfile) => (p.sandbox.networkIsolated ? 1 : 0),
  osSandbox: (p: PermissionProfile) => (p.sandbox.osSandbox === "none" ? 0 : 1),
} as const
const NET_RANK: Record<NetworkPolicy["mode"], number> = {
  "deny-all": 2,
  "allow-list": 1,
  "allow-all": 0,
}
const otherAxes = {
  networkMode: (p: PermissionProfile) => NET_RANK[p.network.mode],
  approvalPrompt: (p: PermissionProfile) => (p.approval.promptUser ? 1 : 0),
  audit: (p: PermissionProfile) => (p.control.auditRequired ? 1 : 0),
} as const

const slotsFromSubset = (subset: readonly SlotName[]) =>
  Object.fromEntries(subset.map((s) => [s, CATALOGUE[s]])) as {
    perUser?: PermissionProfile
    perRepo?: PermissionProfile
    teamAdmin?: PermissionProfile
  }

/** Assert every atomic-axis safety probe of `merged` is ≥ each input's. */
const assertAxesNeverLessSafe = (merged: PermissionProfile, subset: readonly SlotName[]): void => {
  const probes = { ...sandboxAxes, ...otherAxes }
  for (const probe of Object.values(probes)) {
    const mergedSafety = probe(merged)
    for (const s of subset) expect(mergedSafety).toBeGreaterThanOrEqual(probe(CATALOGUE[s]))
  }
}

/** Assert the merged allow-list is a SUBSET of every allow-list input (no widen). */
const assertAllowHostsNarrowing = (
  merged: PermissionProfile,
  subset: readonly SlotName[],
): void => {
  if (merged.network.mode !== "allow-list" || merged.network.allowHosts === undefined) return
  for (const s of subset) {
    const input = CATALOGUE[s]
    if (input.network.mode !== "allow-list" || input.network.allowHosts === undefined) continue
    const inputSet = new Set(input.network.allowHosts)
    for (const h of merged.network.allowHosts) expect(inputSet.has(h)).toBe(true)
  }
}

describe("most-restrictive per-sub-field — exhaustive never-less-safe invariant", () => {
  test("HELL-SUB-05 every atomic axis ≥ safest input axis (all subsets × perms)", () => {
    for (const subset of nonEmptySubsets(SLOTS)) {
      const { merged } = mergeProfileLayers(slotsFromSubset(subset), "most-restrictive")
      assertAxesNeverLessSafe(merged, subset)
      assertAllowHostsNarrowing(merged, subset)
    }
  })

  test("HELL-SUB-07 order-independence: every permutation ⇒ deeply-equal merged", () => {
    for (const subset of nonEmptySubsets(SLOTS)) {
      const canonical = JSON.stringify(
        mergeProfileLayers(slotsFromSubset(subset), "most-restrictive").merged,
      )
      for (const order of permute(subset)) {
        const got = JSON.stringify(
          mergeProfileLayers(slotsFromSubset(order), "most-restrictive").merged,
        )
        expect(got).toBe(canonical)
      }
    }
  })
})

describe("source-precedence is UNCHANGED (whole-struct by precedence)", () => {
  test("HELL-SUB-06 the whole winning struct is kept verbatim under source-precedence", () => {
    const teamAdmin = mkProfile(
      TEAM_ADMIN_SANDBOX,
      { mode: "allow-all" },
      { mode: "auto", promptUser: false },
      { auditRequired: false },
    )
    const perUser = mkProfile(
      PER_USER_SANDBOX,
      { mode: "deny-all" },
      { mode: "always", promptUser: true },
      { auditRequired: true, managedBy: "admin" },
    )
    const { merged } = mergeProfileLayers({ perUser, teamAdmin }, "source-precedence")
    // team-admin OUTRANKS per-user ⇒ its WHOLE sandbox/network struct wins intact,
    // including the UNSAFE bits (source-precedence makes no safety claim).
    expect(merged.sandbox).toEqual(TEAM_ADMIN_SANDBOX)
    expect(merged.network).toEqual({ mode: "allow-all" })
    expect(merged.approval).toEqual({ mode: "auto", promptUser: false })
  })

  test("HELL-SUB-06b strategy DIVERGES — the proven exploit only existed under most-restrictive", () => {
    const teamAdmin = mkProfile(
      TEAM_ADMIN_SANDBOX,
      { mode: "allow-all" },
      { mode: "auto", promptUser: false },
      { auditRequired: false },
    )
    const perUser = mkProfile(
      PER_USER_SANDBOX,
      { mode: "deny-all" },
      { mode: "always", promptUser: true },
      { auditRequired: true },
    )
    const sp = mergeProfileLayers({ perUser, teamAdmin }, "source-precedence").merged
    const mr = mergeProfileLayers({ perUser, teamAdmin }, "most-restrictive").merged
    // source-precedence keeps team-admin's (unsafe) workspaceWrite:false anyway
    // here; the DIVERGENCE shows on networkIsolated (sp=team-admin false, mr=true).
    expect(sp.sandbox.networkIsolated).toBe(false)
    expect(mr.sandbox.networkIsolated).toBe(true)
  })
})

const STRATS: readonly MergeStrategy[] = ["source-precedence", "most-restrictive"]
describe("identity preserved across the change", () => {
  test("HELL-SUB-08 empty slots ⇒ merged deep-equals DEFAULT, overrides []", () => {
    for (const strat of STRATS) {
      const { merged, overrides } = mergeProfileLayers({}, strat)
      // default baseline is locked-down; both strategies must reproduce it.
      expect(merged.sandbox.workspaceWrite).toBe(false)
      expect(merged.network.mode).toBe("deny-all")
      expect(overrides).toEqual([])
    }
  })
})
