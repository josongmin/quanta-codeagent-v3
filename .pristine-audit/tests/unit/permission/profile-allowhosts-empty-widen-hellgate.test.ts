/**
 * Permission-profile NETWORK allow-list ZERO-HOST WIDEN — SECURITY hellgate
 * (DETERMINISTIC; no Math.random / Date).
 *
 * SEALS the fix for the monotone-narrowing breach on the `allowHosts` axis
 * (ADR-0438 inheritance + per-sub-field layer merge). An `allow-list` profile
 * with ABSENT/EMPTY `allowHosts` permits ZERO hosts (the empty set ∅ — an
 * allow-list with no entries permits NOTHING). The old merge treated an absent
 * host list as "no constraint" (`bh ?? dh` / `a ?? b`), so a derived/co-layer
 * could ADD hosts to a zero-host allow-list base — WIDENING egress from ∅. A
 * derived may only ever NARROW (intersect), so the result host set must be a
 * SUBSET of the base; absent base hosts ⇒ ∅ ⇒ derived cannot add anything.
 *
 * Three breaches, three seals:
 *   HELL-AHW-01  INHERITANCE — derived adds a host to a host-less allow-list base
 *                ⇒ result allow-list with ZERO hosts (NOT the derived's host).
 *   HELL-AHW-02  MANAGED CEILING — a host widen over a managed allow-list ceiling
 *                THROWS under onManagedWiden:"throw" (widerAxis now sees hosts).
 *   HELL-AHW-03  LAYER MERGE — a host-less allow-list team-admin layer cannot be
 *                widened by a co-layer adding hosts under `most-restrictive`.
 *
 * NON-REGRESSION guards (the legitimate narrowing must still flow):
 *   HELL-AHW-04  allow-all base + derived allow-list with hosts ⇒ those hosts
 *                survive (allow-all imposes no host constraint — narrowing).
 *   HELL-AHW-05  derived OMITTING allowHosts INHERITS the base host set (not ∅).
 *
 * ANTI-THEATER: against the unfixed code, HELL-AHW-01/03 would see the derived's
 * host leak through (`bh ?? dh` returns the derived list when bh is undefined)
 * and HELL-AHW-02 would NOT throw (widerAxis ignored allowHosts) — all three
 * FAIL pre-fix.
 */

import { describe, expect, test } from "bun:test"
import {
  type ConfigLayer,
  DEFAULT_PERMISSION_PROFILE,
  type LayerSource,
  mergeLayered,
  mergeProfileLayers,
  type NetworkPolicy,
  type PermissionProfile,
  type PermissionSandboxPolicy,
  PROFILE_COMBINERS,
  type ProfileDefinitionRegistry,
  ProfileInheritanceError,
  resolveProfileInheritance,
} from "@/permission"

const SANDBOX: PermissionSandboxPolicy = {
  readOnly: false,
  workspaceWrite: true,
  networkIsolated: false,
  osSandbox: "none",
}

const mkProfile = (network: NetworkPolicy): PermissionProfile => ({
  fileSystem: { type: "restricted", entries: [] },
  approval: { mode: "once", promptUser: true },
  network,
  sandbox: SANDBOX,
  control: { auditRequired: false },
})

const layer = (source: LayerSource, value: PermissionProfile): ConfigLayer<PermissionProfile> => ({
  source,
  value,
})

describe("allow-list zero-host widen hellgate", () => {
  test("HELL-AHW-01 INHERITANCE: derived cannot add hosts to a host-less allow-list base", () => {
    // base: allow-list with NO allowHosts ⇒ permits ZERO hosts. It must extend
    // trusted (allow-all) so the allow-list narrow is legitimate vs the locked
    // DEFAULT (deny-all). Derived tries to ADD evil.example.
    const reg: ProfileDefinitionRegistry = {
      base: { extends: "trusted", network: { mode: "allow-list" } }, // allowHosts absent ⇒ ∅
      child: {
        extends: "base",
        network: { mode: "allow-list", allowHosts: ["evil.example"] },
      },
    }
    const r = resolveProfileInheritance("child", reg)
    expect(r.network.mode).toBe("allow-list")
    // FIX: ∅ ∩ {evil.example} = ∅ — the added host is NOT permitted (fail-closed).
    expect(r.network.allowHosts ?? []).toEqual([])
    expect(r.network.allowHosts ?? []).not.toContain("evil.example")
  })

  test("HELL-AHW-01b INHERITANCE: derived host must be a SUBSET of a non-empty base", () => {
    const reg: ProfileDefinitionRegistry = {
      base: {
        extends: "trusted",
        network: { mode: "allow-list", allowHosts: ["a.com"] },
      },
      // derived keeps a.com (covered) + adds b.com (widen) ⇒ intersection {a.com}.
      child: {
        extends: "base",
        network: { mode: "allow-list", allowHosts: ["a.com", "b.com"] },
      },
    }
    const r = resolveProfileInheritance("child", reg)
    expect(r.network.allowHosts).toEqual(["a.com"])
  })

  test("HELL-AHW-02 MANAGED CEILING: host widen over a managed allow-list ceiling THROWS", () => {
    // To exercise widerAxis on the host axis, construct a result that is wider
    // than a managed allow-list ceiling at the SAME mode rank: a non-managed base
    // establishes acc={evil.example}; a managed sibling contributes the ceiling
    // {api.internal}. The acc host is OUTSIDE the ceiling ⇒ host widen ⇒ throw.
    const widenReg: ProfileDefinitionRegistry = {
      orgCeil: {
        tag: "managed",
        extends: "trusted",
        network: { mode: "allow-list", allowHosts: ["api.internal"] },
      },
      // a NON-managed sibling permitting evil.example, then a child extending BOTH
      // the managed ceiling and the permissive base — acc becomes evil.example,
      // ceiling stays api.internal ⇒ host widen ⇒ throw.
      permissive: {
        extends: "trusted",
        network: { mode: "allow-list", allowHosts: ["evil.example"] },
      },
      bad: { extends: ["permissive", "orgCeil"] },
    }
    expect(() => resolveProfileInheritance("bad", widenReg, { onManagedWiden: "throw" })).toThrow(
      ProfileInheritanceError,
    )
    try {
      resolveProfileInheritance("bad", widenReg, { onManagedWiden: "throw" })
    } catch (e) {
      expect(e).toBeInstanceOf(ProfileInheritanceError)
      expect((e as ProfileInheritanceError).kind).toBe("managed-widen")
      expect((e as Error).message).toContain("network.allowHosts")
    }
  })

  test("HELL-AHW-03 LAYER MERGE: host-less allow-list layer cannot be widened by a co-layer", () => {
    // team-admin: allow-list with NO allowHosts ⇒ ∅. per-user adds hosts.
    const teamAdmin = mkProfile({ mode: "allow-list" }) // ∅
    const perUser = mkProfile({ mode: "allow-list", allowHosts: ["evil.example", "extra.example"] })

    const prod = mergeProfileLayers({ perUser, teamAdmin }, "most-restrictive").merged
    expect(prod.network.mode).toBe("allow-list")
    // FIX: ∅ ∩ {evil,extra} = ∅ — the team-admin zero-host posture is not widened.
    expect(prod.network.allowHosts ?? []).toEqual([])

    // Order-independence: raw engine path, low-authority layer first.
    const raw = mergeLayered([layer("per-user", perUser), layer("team-admin", teamAdmin)], {
      base: DEFAULT_PERMISSION_PROFILE,
      strategy: "most-restrictive",
      combiners: PROFILE_COMBINERS,
    }).merged
    expect(raw.network.allowHosts ?? []).toEqual([])
  })

  test("HELL-AHW-04 NON-REGRESSION: allow-all base imposes no host constraint (narrow survives)", () => {
    // base allow-all (no host axis) + derived allow-list with hosts ⇒ hosts kept.
    const r = resolveProfileInheritance("child", {
      child: {
        extends: "trusted",
        network: { mode: "allow-list", allowHosts: ["a.com"] },
      },
    })
    expect(r.network.mode).toBe("allow-list")
    expect(r.network.allowHosts).toEqual(["a.com"])

    // layer: allow-all layer + allow-list layer with hosts ⇒ those hosts survive.
    const allowAll = mkProfile({ mode: "allow-all" })
    const listed = mkProfile({ mode: "allow-list", allowHosts: ["a.com"] })
    const merged = mergeProfileLayers(
      { perUser: allowAll, teamAdmin: listed },
      "most-restrictive",
    ).merged
    expect(merged.network.mode).toBe("allow-list")
    expect(merged.network.allowHosts).toEqual(["a.com"])
  })

  test("HELL-AHW-05 NON-REGRESSION: derived OMITTING allowHosts inherits the base set (not ∅)", () => {
    const reg: ProfileDefinitionRegistry = {
      base: {
        extends: "trusted",
        network: { mode: "allow-list", allowHosts: ["a.com", "b.com"] },
      },
      // derived narrows ONLY perRequestApproval; omits allowHosts ⇒ inherit base.
      child: { extends: "base", network: { perRequestApproval: true } },
    }
    const r = resolveProfileInheritance("child", reg)
    expect(r.network.mode).toBe("allow-list")
    expect(r.network.allowHosts).toEqual(["a.com", "b.com"]) // inherited, NOT ∅
    expect(r.network.perRequestApproval).toBe(true)
  })
})
