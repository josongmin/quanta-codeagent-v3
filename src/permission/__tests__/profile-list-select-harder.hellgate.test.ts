/**
 * ★ HELLGATE (harder) — ADR-0434 PermissionProfile List + Select.
 *
 * Companion to `profile-list-select.hellgate.test.ts` (the original 17). This
 * battery pushes harder on the security-critical edges the first round only
 * grazed, plus a closed-loop e2e through `TwoLayerManager`:
 *
 *   G. Per-axis safety-ceiling breach — each of the 4 widening axes is proven
 *      INDEPENDENTLY rejected (the original round only tested a profile that
 *      breached every axis at once, which a buggy single-axis check would pass).
 *   H. Structural rejection — unknown keys are STRIPPED (never leak); a bogus
 *      enum on every pillar is a typed reject; malformed JSON / missing pillar
 *      never crash and never partial-apply.
 *   I. Built-in authority — a malicious `trusted.json` (wider than the built-in)
 *      cannot shadow the built-in via either List or Select.
 *   J. Unknown name is ALWAYS a typed error — never a permissive fallback, even
 *      when a profiles dir exists with other valid files.
 *   K. Path-traversal / symlink-escape profile names are rejected (a `<name>`
 *      derived from `../etc/passwd` must not select a file outside the dir).
 *   L. e2e — a user profile on disk → select → apply via TwoLayerManager →
 *      assert the resulting permission DECISION matches the profile.
 *
 * Every assertion is deterministic: real temp dirs, exact typed-error classes,
 * exact decision values. NO heuristics, NO arbitrary thresholds.
 */

import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { FileSystemEntry, PermissionProfile } from "@/permission"
import {
  createCachedResolver,
  createTwoLayerManager,
  exceedsCeiling,
  listPermissionProfiles,
  ProfileSelectError,
  ProfileValidationError,
  parseUserProfile as parseUserProfileFn,
  selectPermissionProfile,
} from "@/permission"
import { NAMED_PROFILES } from "../named-profiles"

/* ─── fixtures ─────────────────────────────────────────────────────────── */

const mkProfilesDir = async (): Promise<string> => mkdtemp(join(tmpdir(), "quanta-profiles-h-"))

const withDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await mkProfilesDir()
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const writeProfile = async (dir: string, name: string, obj: unknown): Promise<void> => {
  await writeFile(join(dir, `${name}.json`), JSON.stringify(obj), "utf8")
}

/** A minimal in-ceiling user profile (no wider than the `default` built-in). */
const SAFE_USER_PROFILE = {
  fileSystem: { type: "restricted", entries: [] },
  approval: { mode: "always", promptUser: true },
  network: { mode: "deny-all" },
  sandbox: { osSandbox: "none", readOnly: true, workspaceWrite: false, networkIsolated: true },
  control: { managedBy: "user", auditRequired: true },
} as const

/* ─── G. Per-axis safety-ceiling breach (each axis independent) ──────────── */

describe("G. Safety ceiling — each widening axis is rejected independently", () => {
  // Each fixture starts from SAFE and breaches EXACTLY ONE axis.
  const breachByAxis: Record<string, unknown> = {
    "network egress (allow-list > deny-all)": {
      ...SAFE_USER_PROFILE,
      network: { mode: "allow-list", allowHosts: ["example.com"] },
    },
    "network egress (allow-all > deny-all)": {
      ...SAFE_USER_PROFILE,
      network: { mode: "allow-all" },
    },
    "workspace-write (true > false)": {
      ...SAFE_USER_PROFILE,
      sandbox: { osSandbox: "none", readOnly: true, workspaceWrite: true, networkIsolated: true },
    },
    "readOnly relaxation (false < true ceiling)": {
      ...SAFE_USER_PROFILE,
      sandbox: { osSandbox: "none", readOnly: false, workspaceWrite: false, networkIsolated: true },
    },
    "network-isolation removal (false < true ceiling)": {
      ...SAFE_USER_PROFILE,
      sandbox: { osSandbox: "none", readOnly: true, workspaceWrite: false, networkIsolated: false },
    },
    "prompt-suppression (promptUser false)": {
      ...SAFE_USER_PROFILE,
      approval: { mode: "auto", promptUser: false },
    },
  }

  for (const [axis, obj] of Object.entries(breachByAxis)) {
    test(`breach: ${axis} ⇒ ProfileValidationError on select (no allowWiden)`, async () => {
      await withDir(async (dir) => {
        await writeProfile(dir, "probe", obj)
        await expect(selectPermissionProfile("probe", { profilesDir: dir })).rejects.toBeInstanceOf(
          ProfileValidationError,
        )
      })
    })

    test(`breach: ${axis} ⇒ dropped from List (no allowWiden), present with allowWiden`, async () => {
      await withDir(async (dir) => {
        await writeProfile(dir, "probe", obj)
        const dropped = await listPermissionProfiles({ profilesDir: dir })
        expect(dropped.some((e) => e.name === "probe")).toBe(false)
        const admitted = await listPermissionProfiles({ profilesDir: dir, allowWiden: true })
        expect(admitted.some((e) => e.name === "probe" && e.source === "user")).toBe(true)
      })
    })

    test(`breach: ${axis} ⇒ exceedsCeiling returns a reason string`, () => {
      const profile = parseUserProfileFn("probe.json", JSON.stringify(obj))
      const reason = exceedsCeiling(profile)
      expect(typeof reason).toBe("string")
      expect((reason ?? "").length).toBeGreaterThan(0)
    })
  }

  test("the exact SAFE profile passes the ceiling (control case — no false positive)", () => {
    const profile = parseUserProfileFn("safe.json", JSON.stringify(SAFE_USER_PROFILE))
    expect(exceedsCeiling(profile)).toBeUndefined()
  })
})

/* ─── H. Structural rejection + unknown-key stripping ────────────────────── */

describe("H. Structural validator — strict, total, no leak", () => {
  test("unknown top-level + nested keys are STRIPPED (rebuilt field-by-field)", () => {
    const withJunk = {
      ...SAFE_USER_PROFILE,
      evil: "rm -rf /",
      network: { mode: "deny-all", evilHost: "attacker.test", allowHosts: ["ok.test"] },
      approval: { mode: "always", promptUser: true, backdoor: true },
    }
    const profile = parseUserProfileFn("junk.json", JSON.stringify(withJunk))
    // No unknown keys survived the rebuild.
    expect(Object.keys(profile).sort()).toEqual([
      "approval",
      "control",
      "fileSystem",
      "network",
      "sandbox",
    ])
    expect((profile as Record<string, unknown>).evil).toBeUndefined()
    expect(Object.keys(profile.approval).sort()).toEqual(["mode", "promptUser"])
    expect((profile.approval as Record<string, unknown>).backdoor).toBeUndefined()
    expect(Object.keys(profile.network).sort()).toEqual(["allowHosts", "mode"])
    expect((profile.network as Record<string, unknown>).evilHost).toBeUndefined()
  })

  // A bogus enum on EVERY pillar is a typed reject (each pillar's parser).
  const bogusByPillar: Record<string, unknown> = {
    "fileSystem.type": { ...SAFE_USER_PROFILE, fileSystem: { type: "wide", entries: [] } },
    "approval.mode": {
      ...SAFE_USER_PROFILE,
      approval: { mode: "never-ask", promptUser: true },
    },
    "network.mode": { ...SAFE_USER_PROFILE, network: { mode: "wide-open" } },
    "sandbox.osSandbox": {
      ...SAFE_USER_PROFILE,
      sandbox: { osSandbox: "vm", readOnly: true, workspaceWrite: false, networkIsolated: true },
    },
    "control.managedBy": {
      ...SAFE_USER_PROFILE,
      control: { managedBy: "root", auditRequired: true },
    },
    "fileSystem.entries[].access": {
      ...SAFE_USER_PROFILE,
      fileSystem: {
        type: "restricted",
        entries: [{ path: { type: "special", kind: "project" }, access: "execute" }],
      },
    },
    "fileSystem.entries[].path.kind": {
      ...SAFE_USER_PROFILE,
      fileSystem: {
        type: "restricted",
        entries: [{ path: { type: "special", kind: "moon" }, access: "read" }],
      },
    },
  }
  for (const [pillar, obj] of Object.entries(bogusByPillar)) {
    test(`bogus enum on ${pillar} ⇒ ProfileValidationError`, () => {
      expect(() => parseUserProfileFn("bad.json", JSON.stringify(obj))).toThrow(
        ProfileValidationError,
      )
    })
  }

  // Each missing pillar ⇒ rejected (no partial apply).
  for (const pillar of ["fileSystem", "approval", "network", "sandbox", "control"] as const) {
    test(`missing pillar '${pillar}' ⇒ ProfileValidationError`, () => {
      const { [pillar]: _omit, ...rest } = SAFE_USER_PROFILE
      expect(() => parseUserProfileFn("missing.json", JSON.stringify(rest))).toThrow(
        ProfileValidationError,
      )
    })
  }

  test("non-object top-level (array / number / null / string) ⇒ ProfileValidationError", () => {
    for (const raw of ["[]", "42", "null", '"hi"', "true"]) {
      expect(() => parseUserProfileFn("x.json", raw)).toThrow(ProfileValidationError)
    }
  })

  test("malformed JSON ⇒ ProfileValidationError (carries file), never a SyntaxError", () => {
    try {
      parseUserProfileFn("broken.json", "{ not: valid, json ]")
      throw new Error("should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(ProfileValidationError)
      expect((err as ProfileValidationError).file).toBe("broken.json")
    }
  })

  test("a valid profile round-trips to the canonical, frozen-shape struct", () => {
    const profile = parseUserProfileFn("ok.json", JSON.stringify(SAFE_USER_PROFILE))
    expect(profile.network.mode).toBe("deny-all")
    expect(profile.approval).toEqual({ mode: "always", promptUser: true })
    expect(profile.sandbox.networkIsolated).toBe(true)
    expect(profile.control).toEqual({ managedBy: "user", auditRequired: true })
  })
})

/* ─── I. Built-in authority — malicious shadow cannot win ────────────────── */

describe("I. Built-in precedence over a malicious user file", () => {
  test("a WIDER trusted.json cannot shadow the built-in via Select", async () => {
    await withDir(async (dir) => {
      // A user file that, if it shadowed, would be MORE permissive than nothing.
      await writeProfile(dir, "trusted", {
        ...SAFE_USER_PROFILE,
        network: { mode: "allow-all" },
        sandbox: {
          osSandbox: "none",
          readOnly: false,
          workspaceWrite: true,
          networkIsolated: false,
        },
        approval: { mode: "auto", promptUser: false },
      })
      const profile = await selectPermissionProfile("trusted", { profilesDir: dir })
      // The frozen built-in struct (by reference) — disk file ignored entirely.
      expect(profile).toBe(NAMED_PROFILES.trusted)
    })
  })

  test("List with onError:'throw' surfaces the built-in collision as a typed error", async () => {
    await withDir(async (dir) => {
      await writeProfile(dir, "default", SAFE_USER_PROFILE)
      await expect(
        listPermissionProfiles({ profilesDir: dir, onError: "throw" }),
      ).rejects.toBeInstanceOf(ProfileValidationError)
    })
  })

  test("each built-in name is single-sourced as 'builtin' even when shadowed on disk", async () => {
    await withDir(async (dir) => {
      for (const name of ["default", "trusted", "restricted"]) {
        await writeProfile(dir, name, SAFE_USER_PROFILE)
      }
      const list = await listPermissionProfiles({ profilesDir: dir })
      for (const name of ["default", "trusted", "restricted"]) {
        const rows = list.filter((e) => e.name === name)
        expect(rows.length).toBe(1)
        expect(rows[0]?.source).toBe("builtin")
      }
    })
  })
})

/* ─── J. Unknown name ⇒ typed error, never permissive ────────────────────── */

describe("J. Unknown select name is always a typed error", () => {
  test("unknown name with a populated dir lists the available names in the error", async () => {
    await withDir(async (dir) => {
      await writeProfile(dir, "ci-bot", SAFE_USER_PROFILE)
      try {
        await selectPermissionProfile("ghost", { profilesDir: dir })
        throw new Error("should have thrown")
      } catch (err) {
        expect(err).toBeInstanceOf(ProfileSelectError)
        const e = err as ProfileSelectError
        expect(e.profileName).toBe("ghost")
        // available enumerates built-ins + the valid user profile, NEVER 'ghost'.
        expect(e.available).toContain("ci-bot")
        expect(e.available).toContain("default")
        expect(e.available).not.toContain("ghost")
      }
    })
  })

  test("empty string name ⇒ ProfileSelectError (never resolves to a built-in)", async () => {
    await expect(selectPermissionProfile("")).rejects.toBeInstanceOf(ProfileSelectError)
  })
})

/* ─── K. Path-traversal / symlink escape rejected ────────────────────────── */

describe("K. Path-traversal & symlink names cannot escape the dir", () => {
  test("a traversal-style select name does not resolve a file outside the dir", async () => {
    await withDir(async (dir) => {
      await writeProfile(dir, "ci-bot", SAFE_USER_PROFILE)
      // `readdir` only ever yields basenames, so a name with `/` or `..` can
      // never match a discovered entry ⇒ unknown ⇒ typed error (not a read of
      // an arbitrary path).
      for (const evil of ["../secrets", "../../etc/passwd", "/etc/passwd", "..%2Fescape"]) {
        await expect(selectPermissionProfile(evil, { profilesDir: dir })).rejects.toBeInstanceOf(
          ProfileSelectError,
        )
      }
    })
  })

  test("a symlink whose target escapes the dir but resolves to a WIDE profile is still ceiling-checked", async () => {
    await withDir(async (outsideDir) => {
      // Place a wide profile OUTSIDE the profiles dir.
      const widePath = join(outsideDir, "wide-source.json")
      await writeFile(
        widePath,
        JSON.stringify({ ...SAFE_USER_PROFILE, network: { mode: "allow-all" } }),
        "utf8",
      )
      await withDir(async (dir) => {
        // Symlink inside the dir → the outside wide profile.
        await symlink(widePath, join(dir, "linked.json"))
        // Even though the link resolves + parses, the ceiling check rejects it
        // (no allowWiden) — escaping the dir buys the attacker no extra trust.
        await expect(
          selectPermissionProfile("linked", { profilesDir: dir }),
        ).rejects.toBeInstanceOf(ProfileValidationError)
      })
    })
  })
})

/* ─── L. e2e — disk → select → apply → assert ACCESS DECISION ────────────── */

// Deterministic resolver: `project` special path ⇒ /repo (no real FS / git).
const mkResolver = () =>
  createCachedResolver({
    os: { family: () => "darwin", tmpdir: () => "/var/folders/T" },
    cwd: { cwd: () => "/repo", projectRoot: () => "/repo" },
    git: { gitDir: () => undefined },
  })

const projectEntry = (access: "read" | "write"): FileSystemEntry => ({
  path: { type: "special", kind: "project" },
  access,
})

describe("L. e2e — close the loop through TwoLayerManager (real decision)", () => {
  test("a user profile on disk → select → apply → access decision matches the profile", async () => {
    await withDir(async (dir) => {
      // In-ceiling profile granting WRITE to the project tree (FS entries are an
      // allow-list, orthogonal to the ceiling axes — net/readOnly/isolation/
      // prompt all stay at the locked-down baseline so nothing widens).
      const grantProfile = {
        fileSystem: {
          type: "restricted",
          entries: [{ path: { type: "special", kind: "project" }, access: "write" }],
        },
        approval: { mode: "always", promptUser: true },
        network: { mode: "deny-all" },
        sandbox: {
          osSandbox: "none",
          readOnly: true,
          workspaceWrite: false,
          networkIsolated: true,
        },
        control: { managedBy: "user", auditRequired: false },
      }
      await writeProfile(dir, "writer", grantProfile)

      // Select off disk → concrete struct.
      const selected: PermissionProfile = await selectPermissionProfile("writer", {
        profilesDir: dir,
      })
      expect(selected.fileSystem.entries[0]?.access).toBe("write")

      // Apply BOTH layers (profile from disk + a matching sandbox) so the 2-layer
      // AND-gate actually fires, then assert the live DECISION:
      const mgr = createTwoLayerManager()
      const tid = "t-writer"
      mgr.setPermissionProfile(tid, selected)
      mgr.setFileSystemSandboxPolicy(tid, { type: "restricted", entries: [projectEntry("write")] })

      // WRITE inside the project ⇒ ALLOW (both layers grant it).
      const wIn = mgr.getEffectiveAccess(tid, "/repo/src/x.ts", "write", mkResolver())
      expect(wIn.decidedBy).toBe("profile-and-sandbox")
      expect(wIn.allow).toBe(true)

      // WRITE outside the project ⇒ DENY (allow-list miss).
      const wOut = mgr.getEffectiveAccess(tid, "/etc/passwd", "write", mkResolver())
      expect(wOut.allow).toBe(false)

      // The applied struct is exactly what came off disk.
      expect(mgr.getPermissionProfile(tid)).toEqual(selected)
    })
  })

  test("a read-only user profile DENIES write to the same path (decision tracks the profile)", async () => {
    await withDir(async (dir) => {
      const readerProfile = {
        fileSystem: {
          type: "restricted",
          entries: [{ path: { type: "special", kind: "project" }, access: "read" }],
        },
        approval: { mode: "always", promptUser: true },
        network: { mode: "deny-all" },
        sandbox: {
          osSandbox: "none",
          readOnly: true,
          workspaceWrite: false,
          networkIsolated: true,
        },
        control: { managedBy: "user", auditRequired: true },
      }
      await writeProfile(dir, "reader", readerProfile)
      const selected = await selectPermissionProfile("reader", { profilesDir: dir })

      const mgr = createTwoLayerManager()
      const tid = "t-reader"
      mgr.setPermissionProfile(tid, selected)
      mgr.setFileSystemSandboxPolicy(tid, { type: "restricted", entries: [projectEntry("read")] })

      // READ inside ⇒ ALLOW; WRITE inside ⇒ DENY (the profile granted read only).
      expect(mgr.getEffectiveAccess(tid, "/repo/a.ts", "read", mkResolver()).allow).toBe(true)
      expect(mgr.getEffectiveAccess(tid, "/repo/a.ts", "write", mkResolver()).allow).toBe(false)
    })
  })

  test("a built-in selected name applied through the manager equals the registry struct", async () => {
    const selected = await selectPermissionProfile("restricted")
    const mgr = createTwoLayerManager()
    mgr.setPermissionProfile("t-builtin", selected)
    expect(mgr.getPermissionProfile("t-builtin")).toEqual(NAMED_PROFILES.restricted)
  })
})
