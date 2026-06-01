/**
 * ★ HELLGATE — ADR-0434 PermissionProfile List + Select + user-defined profiles.
 *
 * Codex `PermissionProfile{List/Select/Apply/Resolve}` absorption. The existing
 * registry (`named-profiles.ts`) had Apply (`setPermissionProfileByName`) +
 * Resolve (`resolveProfileByName`) but NO List enumeration verb, no first-class
 * Select verb, and no user-defined named profiles from disk.
 *
 * Every case is adversarial — it constructs the exact input that a naive
 * implementation would resolve toward "widen / crash / partial-load" and
 * asserts the fail-CLOSED behavior.
 *
 * Sections:
 *   A. List returns the 3 built-ins when no dir (byte-identical, source:builtin)
 *   B. User-defined profile loaded + listed with source:'user'
 *   C. Select unknown name ⇒ typed error (not a permissive fallback)
 *   D. Malformed user profile JSON ⇒ rejected (not crash, not partial)
 *   E. User profile cannot exceed the safety ceiling unless explicitly allowed
 *   F. Absent dir ⇒ built-ins only, byte-identical to the registry
 */

import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NAMED_PROFILE_NAMES, NAMED_PROFILES } from "../named-profiles"
import {
  listPermissionProfiles,
  ProfileSelectError,
  ProfileValidationError,
  selectPermissionProfile,
} from "../profile-list-select"

/* ─── fixtures ─────────────────────────────────────────────────────────── */

const mkProfilesDir = async (): Promise<string> => mkdtemp(join(tmpdir(), "quanta-profiles-"))

/** A minimal-but-valid user profile struct (no wider than the `default`
 *  built-in: deny-all network, no workspace write, restricted FS). */
const SAFE_USER_PROFILE = {
  fileSystem: { type: "restricted", entries: [] },
  approval: { mode: "always", promptUser: true },
  network: { mode: "deny-all" },
  sandbox: { osSandbox: "none", readOnly: true, workspaceWrite: false, networkIsolated: true },
  control: { managedBy: "user", auditRequired: true },
}

/** A user profile that WIDENS past every built-in: network allow-all AND OS
 *  sandbox disabled AND workspace write. Must be rejected unless allowWiden. */
const WIDE_USER_PROFILE = {
  fileSystem: {
    type: "restricted",
    entries: [{ path: { type: "special", kind: "root" }, access: "write" }],
  },
  approval: { mode: "auto", promptUser: false },
  network: { mode: "allow-all" },
  sandbox: { osSandbox: "none", readOnly: false, workspaceWrite: true, networkIsolated: false },
  control: { managedBy: "user", auditRequired: false },
}

/* ─── A. List returns the 3 built-ins when no dir ────────────────────────── */

describe("A. List — built-ins only when no dir", () => {
  test("returns exactly the 3 built-in names with source:'builtin'", async () => {
    const list = await listPermissionProfiles()
    const builtins = list.filter((e) => e.source === "builtin")
    expect(builtins.map((e) => e.name).sort()).toEqual([...NAMED_PROFILE_NAMES].sort())
    expect(builtins.every((e) => e.source === "builtin")).toBe(true)
    expect(builtins.every((e) => typeof e.summary === "string" && e.summary.length > 0)).toBe(true)
  })

  test("no user entries when dir absent", async () => {
    const list = await listPermissionProfiles()
    expect(list.some((e) => e.source === "user")).toBe(false)
    expect(list.length).toBe(NAMED_PROFILE_NAMES.length)
  })
})

/* ─── B. User-defined profile loaded + listed with source:'user' ─────────── */

describe("B. List — user-defined profile from disk", () => {
  test("a valid user profile appears with source:'user'", async () => {
    const dir = await mkProfilesDir()
    try {
      await writeFile(join(dir, "ci-bot.json"), JSON.stringify(SAFE_USER_PROFILE), "utf8")
      const list = await listPermissionProfiles({ profilesDir: dir })
      const user = list.find((e) => e.name === "ci-bot")
      expect(user).toBeDefined()
      expect(user?.source).toBe("user")
      // built-ins still present
      expect(list.filter((e) => e.source === "builtin").length).toBe(NAMED_PROFILE_NAMES.length)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("Select resolves a user profile by name", async () => {
    const dir = await mkProfilesDir()
    try {
      await writeFile(join(dir, "ci-bot.json"), JSON.stringify(SAFE_USER_PROFILE), "utf8")
      const profile = await selectPermissionProfile("ci-bot", { profilesDir: dir })
      expect(profile.network.mode).toBe("deny-all")
      expect(profile.approval.mode).toBe("always")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("a built-in name still resolves through Select (no dir needed)", async () => {
    const profile = await selectPermissionProfile("trusted")
    expect(profile).toEqual(NAMED_PROFILES.trusted)
  })

  test("a built-in name CANNOT be shadowed by a user file of the same name", async () => {
    const dir = await mkProfilesDir()
    try {
      // user tries to redefine `trusted` as a locked-down struct — built-in wins.
      await writeFile(join(dir, "trusted.json"), JSON.stringify(SAFE_USER_PROFILE), "utf8")
      const profile = await selectPermissionProfile("trusted", { profilesDir: dir })
      expect(profile).toEqual(NAMED_PROFILES.trusted)
      // and List does not double-count or mis-source it.
      const list = await listPermissionProfiles({ profilesDir: dir })
      const trustedEntries = list.filter((e) => e.name === "trusted")
      expect(trustedEntries.length).toBe(1)
      expect(trustedEntries[0]?.source).toBe("builtin")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

/* ─── C. Select unknown name ⇒ typed error ───────────────────────────────── */

describe("C. Select — unknown name is a typed error", () => {
  test("unknown name (no dir) throws ProfileSelectError", async () => {
    await expect(selectPermissionProfile("does-not-exist")).rejects.toBeInstanceOf(
      ProfileSelectError,
    )
  })

  test("unknown name (with dir) throws ProfileSelectError, not a permissive fallback", async () => {
    const dir = await mkProfilesDir()
    try {
      await writeFile(join(dir, "ci-bot.json"), JSON.stringify(SAFE_USER_PROFILE), "utf8")
      await expect(selectPermissionProfile("nope", { profilesDir: dir })).rejects.toBeInstanceOf(
        ProfileSelectError,
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

/* ─── D. Malformed user profile JSON ⇒ rejected ──────────────────────────── */

describe("D. Load — malformed JSON is rejected, never partial", () => {
  test("non-JSON content surfaces a ProfileValidationError, not a crash", async () => {
    const dir = await mkProfilesDir()
    try {
      await writeFile(join(dir, "broken.json"), "{ this is not json ", "utf8")
      await expect(
        listPermissionProfiles({ profilesDir: dir, onError: "throw" }),
      ).rejects.toBeInstanceOf(ProfileValidationError)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("structurally-invalid JSON (missing pillar) is rejected", async () => {
    const dir = await mkProfilesDir()
    try {
      await writeFile(
        join(dir, "partial.json"),
        JSON.stringify({ fileSystem: { type: "restricted", entries: [] } }),
        "utf8",
      )
      await expect(
        listPermissionProfiles({ profilesDir: dir, onError: "throw" }),
      ).rejects.toBeInstanceOf(ProfileValidationError)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("wrong enum value (bogus network mode) is rejected", async () => {
    const dir = await mkProfilesDir()
    try {
      await writeFile(
        join(dir, "badenum.json"),
        JSON.stringify({ ...SAFE_USER_PROFILE, network: { mode: "wide-open" } }),
        "utf8",
      )
      await expect(selectPermissionProfile("badenum", { profilesDir: dir })).rejects.toBeInstanceOf(
        ProfileValidationError,
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("default onError='skip' ⇒ malformed file dropped, valid siblings + built-ins survive", async () => {
    const dir = await mkProfilesDir()
    try {
      await writeFile(join(dir, "broken.json"), "{ not json", "utf8")
      await writeFile(join(dir, "ci-bot.json"), JSON.stringify(SAFE_USER_PROFILE), "utf8")
      const list = await listPermissionProfiles({ profilesDir: dir })
      expect(list.some((e) => e.name === "ci-bot" && e.source === "user")).toBe(true)
      expect(list.some((e) => e.name === "broken")).toBe(false)
      expect(list.filter((e) => e.source === "builtin").length).toBe(NAMED_PROFILE_NAMES.length)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

/* ─── E. Safety ceiling ──────────────────────────────────────────────────── */

describe("E. Safety ceiling — user profile cannot widen unless allowed", () => {
  test("a wider-than-ceiling user profile is rejected by default", async () => {
    const dir = await mkProfilesDir()
    try {
      await writeFile(join(dir, "wide.json"), JSON.stringify(WIDE_USER_PROFILE), "utf8")
      await expect(selectPermissionProfile("wide", { profilesDir: dir })).rejects.toBeInstanceOf(
        ProfileValidationError,
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("the same wide profile is admitted when allowWiden:true", async () => {
    const dir = await mkProfilesDir()
    try {
      await writeFile(join(dir, "wide.json"), JSON.stringify(WIDE_USER_PROFILE), "utf8")
      const profile = await selectPermissionProfile("wide", { profilesDir: dir, allowWiden: true })
      expect(profile.network.mode).toBe("allow-all")
      expect(profile.sandbox.workspaceWrite).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("List drops the wide profile by default (ceiling enforced uniformly)", async () => {
    const dir = await mkProfilesDir()
    try {
      await writeFile(join(dir, "wide.json"), JSON.stringify(WIDE_USER_PROFILE), "utf8")
      const list = await listPermissionProfiles({ profilesDir: dir })
      expect(list.some((e) => e.name === "wide")).toBe(false)
      // and surfaces it when widening is allowed.
      const allowed = await listPermissionProfiles({ profilesDir: dir, allowWiden: true })
      expect(allowed.some((e) => e.name === "wide" && e.source === "user")).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

/* ─── F. Absent dir ⇒ built-ins only, byte-identical ─────────────────────── */

describe("F. Byte-identical built-ins when dir absent", () => {
  test("Select of every built-in name === the frozen registry struct", async () => {
    for (const name of NAMED_PROFILE_NAMES) {
      const profile = await selectPermissionProfile(name)
      expect(profile).toBe(NAMED_PROFILES[name])
    }
  })

  test("List with no opts and List with an empty/missing dir agree on built-ins", async () => {
    const noOpts = await listPermissionProfiles()
    const missingDir = await listPermissionProfiles({
      profilesDir: join(tmpdir(), "nope-does-not-exist-xyz"),
    })
    const a = noOpts
      .filter((e) => e.source === "builtin")
      .map((e) => e.name)
      .sort()
    const b = missingDir
      .filter((e) => e.source === "builtin")
      .map((e) => e.name)
      .sort()
    expect(a).toEqual(b)
    expect(missingDir.some((e) => e.source === "user")).toBe(false)
  })
})
