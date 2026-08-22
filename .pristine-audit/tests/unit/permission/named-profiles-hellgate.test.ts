/**
 * Named permission-profile registry hellgate (Track A2).
 *
 * Audit found `DEFAULT_PERMISSION_PROFILE` + the envelope name enum existed but
 * NO registry mapped name → concrete struct, and `TwoLayerManager` took only a
 * struct. This battery seals the registry + the by-name manager API + the
 * `default_permissions` decode bridge:
 *
 *   HELL-NP-01  every NAMED_PROFILE_NAMES entry resolves to a frozen struct.
 *   HELL-NP-02  `default` resolves to DEFAULT_PERMISSION_PROFILE (identity).
 *   HELL-NP-03  escalation: restricted ⊂ default ⊂ trusted on key pillars.
 *   HELL-NP-04  unknown name → throws (fail-closed at parse boundary).
 *   HELL-NP-05  `custom` is NOT a registry key → resolveProfileByName throws.
 *   HELL-NP-06  isNamedProfileName guard rejects custom / unknown / casing.
 *   HELL-NP-07  resolvePermissionProfileField: struct passthrough.
 *   HELL-NP-08  resolvePermissionProfileField: name → registry struct.
 *   HELL-NP-09  resolvePermissionProfileField: "custom" → default struct.
 *   HELL-NP-10  resolvePermissionProfileField: unknown name → throws.
 *   HELL-NP-11  TwoLayerManager.setPermissionProfileByName resolves + stores.
 *   HELL-NP-12  setPermissionProfileByName(unknown) throws; struct API intact.
 */

import { describe, expect, test } from "bun:test"
import {
  createTwoLayerManager,
  DEFAULT_PERMISSION_PROFILE,
  isNamedProfileName,
  NAMED_PROFILE_NAMES,
  NAMED_PROFILES,
  type PermissionProfile,
  resolvePermissionProfileField,
  resolveProfileByName,
} from "@/permission"

describe("HELL-NP-01 every named profile resolves to a frozen struct", () => {
  test("registry has exactly the resolvable names, each frozen", () => {
    expect(Object.keys(NAMED_PROFILES).sort()).toEqual([...NAMED_PROFILE_NAMES].sort())
    for (const name of NAMED_PROFILE_NAMES) {
      const p = NAMED_PROFILES[name]
      expect(Object.isFrozen(p)).toBe(true)
      // shape sanity: all four pillars present
      expect(p.fileSystem).toBeDefined()
      expect(p.approval).toBeDefined()
      expect(p.network).toBeDefined()
      expect(p.sandbox).toBeDefined()
      expect(p.control).toBeDefined()
    }
  })
})

describe("HELL-NP-02 default name === DEFAULT_PERMISSION_PROFILE", () => {
  test("identity (same canonical struct)", () => {
    expect(resolveProfileByName("default")).toBe(DEFAULT_PERMISSION_PROFILE)
    expect(NAMED_PROFILES.default).toBe(DEFAULT_PERMISSION_PROFILE)
  })
})

describe("HELL-NP-03 escalation restricted ⊂ default ⊂ trusted", () => {
  const restricted = resolveProfileByName("restricted")
  const def = resolveProfileByName("default")
  const trusted = resolveProfileByName("trusted")

  test("network: restricted=deny-all, default=deny-all, trusted=allow-all", () => {
    expect(restricted.network.mode).toBe("deny-all")
    expect(def.network.mode).toBe("deny-all")
    expect(trusted.network.mode).toBe("allow-all")
  })
  test("sandbox write: restricted=off, default=off, trusted=on", () => {
    expect(restricted.sandbox.workspaceWrite).toBe(false)
    expect(def.sandbox.workspaceWrite).toBe(false)
    expect(trusted.sandbox.workspaceWrite).toBe(true)
  })
  test("approval: restricted=always(strictest), trusted=auto(loosest)", () => {
    expect(restricted.approval.mode).toBe("always")
    expect(trusted.approval.mode).toBe("auto")
    expect(trusted.approval.promptUser).toBe(false)
  })
  test("audit: restricted forces audit ON; trusted OFF", () => {
    expect(restricted.control.auditRequired).toBe(true)
    expect(trusted.control.auditRequired).toBe(false)
  })
})

describe("HELL-NP-04/05 unsupported names throw", () => {
  test("unknown name throws", () => {
    expect(() => resolveProfileByName("superuser")).toThrow()
  })
  test("`custom` is not a registry entry → throws", () => {
    expect(() => resolveProfileByName("custom")).toThrow()
    expect((NAMED_PROFILES as Record<string, unknown>).custom).toBeUndefined()
  })
  test("empty string throws", () => {
    expect(() => resolveProfileByName("")).toThrow()
  })
})

describe("HELL-NP-06 isNamedProfileName guard", () => {
  test("accepts the three resolvable names", () => {
    expect(isNamedProfileName("default")).toBe(true)
    expect(isNamedProfileName("trusted")).toBe(true)
    expect(isNamedProfileName("restricted")).toBe(true)
  })
  test("rejects custom / unknown / wrong casing", () => {
    expect(isNamedProfileName("custom")).toBe(false)
    expect(isNamedProfileName("Default")).toBe(false)
    expect(isNamedProfileName("nope")).toBe(false)
    expect(isNamedProfileName("")).toBe(false)
  })
})

describe("HELL-NP-07..10 resolvePermissionProfileField decode bridge", () => {
  test("struct passthrough (identity)", () => {
    const bespoke: PermissionProfile = {
      ...DEFAULT_PERMISSION_PROFILE,
      network: { mode: "allow-list", allowHosts: ["x.com"] },
    }
    expect(resolvePermissionProfileField(bespoke)).toBe(bespoke)
  })
  test("name → registry struct", () => {
    expect(resolvePermissionProfileField("trusted")).toBe(NAMED_PROFILES.trusted)
    expect(resolvePermissionProfileField("restricted")).toBe(NAMED_PROFILES.restricted)
  })
  test("`custom` name (no struct) → locked-down default", () => {
    expect(resolvePermissionProfileField("custom")).toBe(DEFAULT_PERMISSION_PROFILE)
  })
  test("unknown name string → throws (fail-closed)", () => {
    expect(() => resolvePermissionProfileField("godmode")).toThrow()
  })
})

describe("HELL-NP-11/12 TwoLayerManager by-name API", () => {
  test("setPermissionProfileByName resolves through the registry + stores", () => {
    const mgr = createTwoLayerManager()
    mgr.setPermissionProfileByName("t1", "trusted")
    expect(mgr.getPermissionProfile("t1")).toBe(NAMED_PROFILES.trusted)
  })
  test("unknown name throws AND leaves no thread state behind", () => {
    const mgr = createTwoLayerManager()
    expect(() => mgr.setPermissionProfileByName("t2", "wat")).toThrow()
    expect(mgr.getPermissionProfile("t2")).toBeUndefined()
  })
  test("struct API still works (backward-compat)", () => {
    const mgr = createTwoLayerManager()
    const bespoke: PermissionProfile = { ...DEFAULT_PERMISSION_PROFILE }
    mgr.setPermissionProfile("t3", bespoke)
    expect(mgr.getPermissionProfile("t3")).toBe(bespoke)
  })
})
