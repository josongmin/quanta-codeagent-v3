/**
 * Permission-profile INHERITANCE — hellgate battery (DETERMINISTIC).
 *
 * Seals `src/permission/profile-inheritance.ts` (ADR-0438): the `extends`
 * resolver with monotone-narrowing merge, cycle detection (THROW), Managed
 * ceiling, and built-in byte-identical regression. NO Math.random / Date — every
 * "property" iterates a FIXED enumeration.
 *
 *   HELL-PI-01  single extend per-axis narrow (the trusted+network-locked case)
 *   HELL-PI-02  network MRW — narrow accepted, widen dropped
 *   HELL-PI-03  approval MRW — stricter accepted, laxer dropped; promptUser OR
 *   HELL-PI-04  fileSystem entries intersection + type MRW + access narrowing
 *   HELL-PI-05  sandbox per-flag MRW (AND/OR/osSandbox)
 *   HELL-PI-06  control MRW — managedBy can't drop; auditRequired OR
 *   HELL-PI-07  cycle throws (A->B->A and A->B->C->A) with path in message
 *   HELL-PI-08  self-extend throws
 *   HELL-PI-09  unknown base throws (fail-closed, no silent fallback)
 *   HELL-PI-10  managed ceiling can't be widened (clamp + throw modes)
 *   HELL-PI-11  monotone-narrowing invariant across all 13 axes
 *   HELL-PI-12  deep chain (N=20) resolves
 *   HELL-PI-13  diamond consistency (A,B both extend X)
 *   HELL-PI-14  REGRESSION — 3 built-ins byte-identical to NAMED_PROFILES
 *   HELL-PI-15  empty / undefined extends ⇒ DEFAULT-based
 */

import { describe, expect, test } from "bun:test"
import {
  DEFAULT_PERMISSION_PROFILE,
  NAMED_PROFILE_NAMES,
  NAMED_PROFILES,
  NETWORK_RANK,
  type PermissionProfile,
  type ProfileDefinition,
  type ProfileDefinitionRegistry,
  ProfileInheritanceError,
  resolveProfileInheritance,
} from "@/permission"

const APPROVAL_RANK = { auto: 0, once: 1, session: 2, always: 3 } as const
const FS_TYPE_RANK = { restricted: 0, managed: 1 } as const
const MANAGED_BY_RANK = { user: 1, team: 2, admin: 3 } as const
const managedByRank = (m: "user" | "team" | "admin" | undefined): number =>
  m === undefined ? 0 : MANAGED_BY_RANK[m]
const osRank = (k: PermissionProfile["sandbox"]["osSandbox"]): number => (k === "none" ? 0 : 1)

describe("profile-inheritance hellgate", () => {
  test("HELL-PI-01 single extend narrows ONE axis (trusted + network locked)", () => {
    const reg: ProfileDefinitionRegistry = {
      "trusted-no-net": { extends: "trusted", network: { mode: "deny-all" } },
    }
    const r = resolveProfileInheritance("trusted-no-net", reg)
    // network narrowed to deny-all...
    expect(r.network.mode).toBe("deny-all")
    // ...while the rest of trusted is inherited unchanged.
    expect(r.approval).toEqual(NAMED_PROFILES.trusted.approval)
    expect(r.fileSystem).toEqual(NAMED_PROFILES.trusted.fileSystem)
    expect(r.sandbox).toEqual(NAMED_PROFILES.trusted.sandbox)
  })

  test("HELL-PI-02 network MRW — narrow accepted, widen dropped", () => {
    // base allow-all, derived allow-list ⇒ allow-list (narrow).
    const narrow = resolveProfileInheritance("d", {
      d: { extends: "trusted", network: { mode: "allow-list", allowHosts: ["a.com"] } },
    })
    expect(narrow.network.mode).toBe("allow-list")
    expect(narrow.network.allowHosts).toEqual(["a.com"])

    // base deny-all (default), derived allow-all ⇒ deny-all (widen dropped).
    const widen = resolveProfileInheritance("d", {
      d: { extends: "default", network: { mode: "allow-all" } },
    })
    expect(widen.network.mode).toBe("deny-all")
  })

  test("HELL-PI-02b allowHosts intersection (derived may only drop hosts)", () => {
    const reg: ProfileDefinitionRegistry = {
      // base must extend trusted (allow-all) to legitimately declare allow-list
      // with hosts — a root definition is bounded by the locked-down DEFAULT.
      base: { extends: "trusted", network: { mode: "allow-list", allowHosts: ["a.com", "b.com"] } },
      // derived adds c.com (widen) + keeps a.com ⇒ intersection = {a.com}.
      child: { extends: "base", network: { mode: "allow-list", allowHosts: ["a.com", "c.com"] } },
    }
    const r = resolveProfileInheritance("child", reg)
    expect(r.network.allowHosts).toEqual(["a.com"])
  })

  test("HELL-PI-03 approval MRW + promptUser OR", () => {
    const stricter = resolveProfileInheritance("d", {
      d: { extends: "trusted", approval: { mode: "always", promptUser: true } },
    })
    expect(stricter.approval.mode).toBe("always") // trusted=auto, derived narrows
    expect(stricter.approval.promptUser).toBe(true)

    const laxer = resolveProfileInheritance("d", {
      d: { extends: "restricted", approval: { mode: "auto", promptUser: false } },
    })
    expect(laxer.approval.mode).toBe("always") // restricted=always; widen dropped
    expect(laxer.approval.promptUser).toBe(true) // OR keeps restricted's prompt
  })

  test("HELL-PI-04 fileSystem entries intersection + type MRW + access narrow", () => {
    // trusted grants project=write; derived keeps project but narrows write→read
    // AND tries to add a root=write grant (widen) — the root entry is dropped.
    const reg: ProfileDefinitionRegistry = {
      child: {
        extends: "trusted",
        fileSystem: {
          type: "managed",
          entries: [
            { path: { type: "special", kind: "project" }, access: "read" },
            { path: { type: "special", kind: "root" }, access: "write" }, // not covered ⇒ dropped
          ],
        },
      },
    }
    const r = resolveProfileInheritance("child", reg)
    expect(r.fileSystem.type).toBe("managed") // restricted→managed = MRW max
    expect(r.fileSystem.entries).toEqual([
      { path: { type: "special", kind: "project" }, access: "read" },
    ])
  })

  test("HELL-PI-04b derived empty entries denies all; omitted inherits", () => {
    const reg: ProfileDefinitionRegistry = {
      child: { extends: "trusted", fileSystem: { entries: [] } },
      keep: { extends: "trusted" },
    }
    expect(resolveProfileInheritance("child", reg).fileSystem.entries).toEqual([])
    expect(resolveProfileInheritance("keep", reg).fileSystem.entries).toEqual(
      NAMED_PROFILES.trusted.fileSystem.entries,
    )
  })

  test("HELL-PI-05 sandbox per-flag MRW", () => {
    // trusted: osSandbox none, readOnly false, workspaceWrite true, networkIsolated false
    const r = resolveProfileInheritance("d", {
      d: {
        extends: "trusted",
        sandbox: {
          osSandbox: "seatbelt", // none→seatbelt (narrow accepted)
          readOnly: true, // OR ⇒ true
          workspaceWrite: false, // AND ⇒ false (narrow)
          networkIsolated: true, // OR ⇒ true
        },
      },
    })
    expect(r.sandbox.osSandbox).toBe("seatbelt")
    expect(r.sandbox.readOnly).toBe(true)
    expect(r.sandbox.workspaceWrite).toBe(false)
    expect(r.sandbox.networkIsolated).toBe(true)

    // widen attempts dropped: base seatbelt + readOnly, derived none + readOnly:false
    const widen = resolveProfileInheritance("c", {
      base: {
        sandbox: {
          osSandbox: "seatbelt",
          readOnly: true,
          workspaceWrite: false,
          networkIsolated: true,
        },
      },
      c: {
        extends: "base",
        sandbox: {
          osSandbox: "none",
          readOnly: false,
          workspaceWrite: true,
          networkIsolated: false,
        },
      },
    })
    expect(widen.sandbox.osSandbox).toBe("seatbelt")
    expect(widen.sandbox.readOnly).toBe(true)
    expect(widen.sandbox.workspaceWrite).toBe(false)
    expect(widen.sandbox.networkIsolated).toBe(true)
  })

  test("HELL-PI-06 control MRW — managedBy can't drop, auditRequired OR", () => {
    // restricted = managedBy admin + auditRequired true
    const r = resolveProfileInheritance("d", {
      d: { extends: "restricted", control: { managedBy: "user", auditRequired: false } },
    })
    expect(r.control.managedBy).toBe("admin") // user widen dropped
    expect(r.control.auditRequired).toBe(true) // OR keeps audit

    // narrow direction: default (user) → admin accepted
    const up = resolveProfileInheritance("d", {
      d: { extends: "default", control: { managedBy: "admin", auditRequired: true } },
    })
    expect(up.control.managedBy).toBe("admin")
    expect(up.control.auditRequired).toBe(true)
  })

  test("HELL-PI-07 cycle throws with path in message", () => {
    const cyc2: ProfileDefinitionRegistry = { A: { extends: "B" }, B: { extends: "A" } }
    expect(() => resolveProfileInheritance("A", cyc2)).toThrow(ProfileInheritanceError)
    try {
      resolveProfileInheritance("A", cyc2)
    } catch (e) {
      expect((e as ProfileInheritanceError).kind).toBe("cycle")
      expect((e as Error).message).toContain("A -> B -> A")
    }

    const cyc3: ProfileDefinitionRegistry = {
      A: { extends: "B" },
      B: { extends: "C" },
      C: { extends: "A" },
    }
    try {
      resolveProfileInheritance("A", cyc3)
    } catch (e) {
      expect((e as ProfileInheritanceError).kind).toBe("cycle")
      expect((e as Error).message).toContain("A -> B -> C -> A")
    }
  })

  test("HELL-PI-08 self-extend throws", () => {
    expect(() => resolveProfileInheritance("A", { A: { extends: "A" } })).toThrow(
      /cannot extend itself/,
    )
    try {
      resolveProfileInheritance("A", { A: { extends: "A" } })
    } catch (e) {
      expect((e as ProfileInheritanceError).kind).toBe("self-extend")
    }
  })

  test("HELL-PI-09 unknown base throws (fail-closed, no silent fallback)", () => {
    try {
      resolveProfileInheritance("A", { A: { extends: "ghost" } })
      throw new Error("should have thrown")
    } catch (e) {
      expect(e).toBeInstanceOf(ProfileInheritanceError)
      expect((e as ProfileInheritanceError).kind).toBe("unknown-base")
      expect((e as Error).message).toContain("ghost")
    }
    // unknown TOP-LEVEL name also throws.
    expect(() => resolveProfileInheritance("nope", {})).toThrow(ProfileInheritanceError)
  })

  test("HELL-PI-10 managed ceiling cannot be widened (clamp + throw)", () => {
    const reg: ProfileDefinitionRegistry = {
      // managed base: deny-all net, always approval+prompt, no ws write, audit, admin.
      org: {
        tag: "managed",
        network: { mode: "deny-all" },
        approval: { mode: "always", promptUser: true },
        sandbox: {
          osSandbox: "seatbelt",
          readOnly: true,
          workspaceWrite: false,
          networkIsolated: true,
        },
        control: { managedBy: "admin", auditRequired: true },
        fileSystem: { type: "managed", entries: [] },
      },
      // derived tries to widen EVERY axis.
      bad: {
        extends: "org",
        network: { mode: "allow-all" },
        approval: { mode: "auto", promptUser: false },
        sandbox: {
          osSandbox: "none",
          readOnly: false,
          workspaceWrite: true,
          networkIsolated: false,
        },
        control: { managedBy: "user", auditRequired: false },
        fileSystem: { type: "restricted" },
      },
    }
    // clamp mode (default): result is no wider than ceiling on any axis.
    const clamped = resolveProfileInheritance("bad", reg)
    expect(clamped.network.mode).toBe("deny-all")
    expect(clamped.approval.mode).toBe("always")
    expect(clamped.approval.promptUser).toBe(true)
    expect(clamped.sandbox.osSandbox).toBe("seatbelt")
    expect(clamped.sandbox.workspaceWrite).toBe(false)
    expect(clamped.control.managedBy).toBe("admin")
    expect(clamped.control.auditRequired).toBe(true)
    expect(clamped.fileSystem.type).toBe("managed")

    // throw mode: reject the widen outright.
    try {
      resolveProfileInheritance("bad", reg, { onManagedWiden: "throw" })
      throw new Error("should have thrown")
    } catch (e) {
      expect(e).toBeInstanceOf(ProfileInheritanceError)
      expect((e as ProfileInheritanceError).kind).toBe("managed-widen")
    }
  })

  test("HELL-PI-11 monotone-narrowing invariant across all axes", () => {
    // For every built-in base × a battery of partial derived defs, resolve(child)
    // must be no wider than resolve(base) on each of the 13 axes.
    const derivedBatch: ReadonlyArray<ProfileDefinition> = [
      {},
      { network: { mode: "allow-all" } }, // widen attempt
      { network: { mode: "deny-all" } }, // narrow
      { approval: { mode: "auto", promptUser: false } }, // widen attempt
      { approval: { mode: "always", promptUser: true } }, // narrow
      {
        sandbox: {
          osSandbox: "none",
          readOnly: false,
          workspaceWrite: true,
          networkIsolated: false,
        },
      },
      {
        sandbox: {
          osSandbox: "seatbelt",
          readOnly: true,
          workspaceWrite: false,
          networkIsolated: true,
        },
      },
      { control: { managedBy: "user", auditRequired: false } },
      { control: { managedBy: "admin", auditRequired: true } },
      { fileSystem: { type: "restricted", entries: [] } },
      { fileSystem: { type: "managed" } },
    ]
    for (const baseName of NAMED_PROFILE_NAMES) {
      const baseResolved = NAMED_PROFILES[baseName]
      for (const d of derivedBatch) {
        const child = resolveProfileInheritance("child", { child: { extends: baseName, ...d } })
        assertNotWiderThan(child, baseResolved)
      }
    }
  })

  test("HELL-PI-12 deep chain N=20 resolves", () => {
    const reg: Record<string, ProfileDefinition> = { p0: { extends: "trusted" } }
    for (let i = 1; i < 20; i++) reg[`p${i}`] = { extends: `p${i - 1}` }
    // each link narrows network one notch where possible; final still <= trusted.
    reg.p19 = { extends: "p18", network: { mode: "deny-all" } }
    const r = resolveProfileInheritance("p19", reg)
    expect(r.network.mode).toBe("deny-all")
    assertNotWiderThan(r, NAMED_PROFILES.trusted)
  })

  test("HELL-PI-13 diamond consistency (A,B both extend X)", () => {
    const reg: ProfileDefinitionRegistry = {
      X: { extends: "trusted", approval: { mode: "session", promptUser: true } },
      A: { extends: "X", network: { mode: "allow-list", allowHosts: ["a.com"] } },
      B: {
        extends: "X",
        sandbox: {
          osSandbox: "seatbelt",
          readOnly: false,
          workspaceWrite: true,
          networkIsolated: false,
        },
      },
      D: { extends: ["A", "B"] },
    }
    const d1 = resolveProfileInheritance("D", reg)
    const d2 = resolveProfileInheritance("D", reg)
    expect(d1).toEqual(d2) // deterministic
    // X's session approval propagates through both arms.
    expect(d1.approval.mode).toBe("session")
    expect(d1.network.mode).toBe("allow-list")
    expect(d1.sandbox.osSandbox).toBe("seatbelt")
  })

  test("HELL-PI-14 REGRESSION — built-ins byte-identical", () => {
    for (const name of NAMED_PROFILE_NAMES) {
      const r = resolveProfileInheritance(name, {})
      expect(r).toEqual(NAMED_PROFILES[name])
      // identity: built-in fallback returns the frozen struct verbatim.
      expect(r).toBe(NAMED_PROFILES[name])
    }
  })

  test("HELL-PI-15 empty / undefined extends ⇒ DEFAULT-based", () => {
    const undef = resolveProfileInheritance("a", { a: {} })
    expect(undef).toEqual(DEFAULT_PERMISSION_PROFILE)
    const empty = resolveProfileInheritance("a", { a: { extends: [] } })
    expect(empty).toEqual(DEFAULT_PERMISSION_PROFILE)
    // own fields narrow from DEFAULT (already locked-down; audit ON is a narrow).
    const own = resolveProfileInheritance("a", { a: { control: { auditRequired: true } } })
    expect(own.control.auditRequired).toBe(true)
    expect(own.network.mode).toBe("deny-all")
  })
})

/* ----- helpers ----------------------------------------------------------- */

/** Assert `child` is no wider than `base` on every security axis. */
const assertNotWiderThan = (child: PermissionProfile, base: PermissionProfile): void => {
  expect(NETWORK_RANK[child.network.mode]).toBeLessThanOrEqual(NETWORK_RANK[base.network.mode])
  expect(APPROVAL_RANK[child.approval.mode]).toBeGreaterThanOrEqual(
    APPROVAL_RANK[base.approval.mode],
  )
  if (base.approval.promptUser) expect(child.approval.promptUser).toBe(true)
  expect(FS_TYPE_RANK[child.fileSystem.type]).toBeGreaterThanOrEqual(
    FS_TYPE_RANK[base.fileSystem.type],
  )
  expect(osRank(child.sandbox.osSandbox)).toBeGreaterThanOrEqual(osRank(base.sandbox.osSandbox))
  if (base.sandbox.readOnly) expect(child.sandbox.readOnly).toBe(true)
  if (!base.sandbox.workspaceWrite) expect(child.sandbox.workspaceWrite).toBe(false)
  if (base.sandbox.networkIsolated) expect(child.sandbox.networkIsolated).toBe(true)
  expect(managedByRank(child.control.managedBy)).toBeGreaterThanOrEqual(
    managedByRank(base.control.managedBy),
  )
  if (base.control.auditRequired) expect(child.control.auditRequired).toBe(true)
}
