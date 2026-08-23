/**
 * RFC-06 F1 hellgate — live skill runtime authority.
 *
 * Pins the three F1 REDs + policy/persistence invariants:
 *   (a) ONE persisted disable makes active/search/management CONSISTENT at one
 *       revision (disable absent from active+searchable, RETAINED in management
 *       with reason) — a per-consumer filter would diverge.
 *   (b) CAS on the unified revision — two concurrent setEnabled at revision N
 *       commit exactly ONE; the other is stale-rejected (no both-publish).
 *   (c) persist-before-publish — a failed durable write leaves the old view live.
 *   + name-keyed policy (required cannot disable / banned cannot enable / unknown
 *     fails closed), corrupt-store fail-close, resolveActive execution check.
 */

import { describe, expect, test } from "bun:test"
import type {
  AdminPolicy,
  Skill,
  SkillRegistry,
  SkillRegistryEntry,
  SkillScope,
  SkillSnapshot,
} from "@/skill"
import {
  createInMemoryDisabledStore,
  createJsonDisabledStore,
  createSkillRuntimeAuthority,
  DISABLED_SET_SCHEMA_VERSION,
  type DisabledStoreFs,
  type DisabledStorePort,
  decodeDisabledSet,
  emptyDisabledSet,
  type PersistedDisabledSet,
  type SkillRuntimeAuthority,
} from "@/skill"

/* ------------------------------------------------------------------------- *
 * Fixtures — a hand-built registry snapshot (no fs; the composition front-door
 * test exercises the real loaders).
 * ------------------------------------------------------------------------- */

const mkSkill = (name: string, scope: SkillScope): Skill => ({
  name,
  description: `desc-${name}`,
  body: `body-${name}`,
  sourcePath: `/fixtures/${name}/SKILL.md`,
  scope,
})

const mkSnapshot = (specs: readonly { name: string; scope: SkillScope }[]): SkillSnapshot => {
  const entries: SkillRegistryEntry[] = specs
    .map((s) => ({ skill: mkSkill(s.name, s.scope), winnerScope: s.scope, overriddenScopes: [] }))
    .sort((a, b) => (a.skill.name < b.skill.name ? -1 : 1))
  const byName = new Map(entries.map((e) => [e.skill.name, e]))
  const registry: SkillRegistry = {
    entries,
    collisions: [],
    lookup: (n) => byName.get(n),
    bySope: () => [],
  }
  return { skills: entries.map((e) => e.skill), registry }
}

const build = (
  specs: readonly { name: string; scope: SkillScope }[],
  opts: {
    policy?: AdminPolicy | null
    store?: DisabledStorePort
    persisted?: PersistedDisabledSet
  } = {},
): { authority: SkillRuntimeAuthority; store: DisabledStorePort } => {
  const store = opts.store ?? createInMemoryDisabledStore(opts.persisted)
  const authority = createSkillRuntimeAuthority({
    snapshot: mkSnapshot(specs),
    policy: opts.policy ?? null,
    disabledStore: store,
    persisted: opts.persisted ?? emptyDisabledSet(),
  })
  return { authority, store }
}

const names = (v: readonly { name: string }[]): string[] => v.map((x) => x.name).sort()

/* ------------------------------------------------------------------------- *
 * (a) One disable → three consistent projections.
 * ------------------------------------------------------------------------- */

describe("F1 (a) — projection consistency at one revision", () => {
  test("a persisted disable removes from active+searchable and RETAINS in management with reason", async () => {
    const { authority } = build([
      { name: "alpha", scope: "user" },
      { name: "beta", scope: "user" },
    ])
    const before = authority.read()
    expect(names(before.active)).toEqual(["alpha", "beta"])
    expect(before.management.every((m) => m.enabled)).toBe(true)

    const res = await authority.setEnabled("beta", false, before.revision)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const v = res.view

    // active + searchable exclude beta — and they NEVER diverge from each other.
    expect(names(v.active)).toEqual(["alpha"])
    expect(v.searchable.map((e) => e.skill.name).sort()).toEqual(["alpha"])
    // management RETAINS beta with the user reason (the row needed to re-enable).
    const beta = v.management.find((m) => m.name === "beta")
    expect(beta).toBeDefined()
    expect(beta?.enabled).toBe(false)
    expect(beta?.disableReason).toBe("user")
    // read() returns the same published revision/view.
    expect(authority.read().revision).toBe(v.revision)
    expect(v.revision).toBe(before.revision + 1)
  })

  test("cross-projection invariant: every management-disabled name is absent from active AND searchable", async () => {
    const { authority } = build([
      { name: "a", scope: "user" },
      { name: "b", scope: "user" },
      { name: "c", scope: "user" },
    ])
    await authority.setEnabled("a", false, 0)
    const v = await authority.setEnabled("c", false, 1)
    expect(v.ok).toBe(true)
    if (!v.ok) return
    const disabled = v.view.management.filter((m) => !m.enabled).map((m) => m.name)
    const activeNames = new Set(v.view.active.map((s) => s.name))
    const searchNames = new Set(v.view.searchable.map((e) => e.skill.name))
    for (const d of disabled) {
      expect(activeNames.has(d)).toBe(false)
      expect(searchNames.has(d)).toBe(false)
    }
    // And enabled management rows ARE present in both.
    for (const m of v.view.management.filter((x) => x.enabled)) {
      expect(activeNames.has(m.name)).toBe(true)
      expect(searchNames.has(m.name)).toBe(true)
    }
  })
})

/* ------------------------------------------------------------------------- *
 * (b) CAS — exactly one of two concurrent writers commits.
 * ------------------------------------------------------------------------- */

describe("F1 (b) — CAS on the unified revision", () => {
  test("two concurrent setEnabled at revision N: exactly one commits, one stale-rejected", async () => {
    const { authority } = build([
      { name: "x", scope: "user" },
      { name: "y", scope: "user" },
    ])
    const rev = authority.read().revision
    const [r1, r2] = await Promise.all([
      authority.setEnabled("x", false, rev),
      authority.setEnabled("y", false, rev),
    ])
    const oks = [r1, r2].filter((r) => r.ok)
    const stales = [r1, r2].filter((r) => !r.ok && r.rejection.kind === "stale_revision")
    expect(oks.length).toBe(1)
    expect(stales.length).toBe(1)
    // The committed writer advanced the revision by exactly one.
    expect(authority.read().revision).toBe(rev + 1)
  })

  test("stale_revision reports expected vs actual and does NOT persist", async () => {
    const { authority, store } = build([{ name: "x", scope: "user" }])
    await authority.setEnabled("x", false, 0) // → revision 1
    const res = await authority.setEnabled("x", true, 0) // stale (expected 0, actual 1)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.rejection).toEqual({ kind: "stale_revision", expected: 0, actual: 1 })
    // x is still disabled in the durable store (the stale re-enable did nothing).
    expect((await store.read()).names).toEqual(["x"])
  })
})

/* ------------------------------------------------------------------------- *
 * (c) persist-before-publish.
 * ------------------------------------------------------------------------- */

describe("F1 (c) — persist before publish", () => {
  test("a failed durable write leaves the OLD revision/view live (no publish)", async () => {
    const failing: DisabledStorePort = {
      read: async () => emptyDisabledSet(),
      write: async () => {
        throw new Error("disk full")
      },
      // The authority mutates through the locked `mutate` path; a non-durable
      // write there propagates so persist-before-publish can refuse.
      mutate: async () => {
        throw new Error("disk full")
      },
    }
    const { authority } = build([{ name: "x", scope: "user" }], { store: failing })
    const before = authority.read()
    const res = await authority.setEnabled("x", false, before.revision)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.rejection.kind).toBe("persist_failed")
    // The live view is byte-identical to before — no partial publication.
    const after = authority.read()
    expect(after.revision).toBe(before.revision)
    expect(names(after.active)).toEqual(["x"])
    expect(after.management.find((m) => m.name === "x")?.enabled).toBe(true)
  })
})

/* ------------------------------------------------------------------------- *
 * Name-keyed policy — required / banned / unknown.
 * ------------------------------------------------------------------------- */

const policy = (p: Partial<AdminPolicy>): AdminPolicy => ({
  requiredSkills: p.requiredSkills ?? [],
  bannedSkills: p.bannedSkills ?? [],
  auditRequired: p.auditRequired ?? false,
  ...(p.org !== undefined ? { org: p.org } : {}),
})

describe("F1 — canonical-name policy (never winnerScope)", () => {
  test("admin-required skill cannot be user-disabled (keyed by NAME, winner scope is user)", async () => {
    // The winning file is USER-scoped, but the NAME is admin-required → refuse.
    const { authority } = build([{ name: "req", scope: "user" }], {
      policy: policy({ requiredSkills: ["req"] }),
    })
    const res = await authority.setEnabled("req", false, 0)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.rejection).toEqual({ kind: "policy_denied", name: "req", reason: "required" })
    // And the projection PINS it enabled even against a stray persisted disable.
    const pinned = build([{ name: "req", scope: "user" }], {
      policy: policy({ requiredSkills: ["req"] }),
      persisted: { schemaVersion: DISABLED_SET_SCHEMA_VERSION, revision: 3, names: ["req"] },
    })
    expect(pinned.authority.read().active.map((s) => s.name)).toContain("req")
  })

  test("admin-banned skill cannot be enabled AND is administrator-disabled in projections", async () => {
    const { authority } = build([{ name: "ban", scope: "user" }], {
      policy: policy({ bannedSkills: ["ban"] }),
    })
    // Projection: banned ⇒ absent from active/searchable, management reason=administrator.
    const v0 = authority.read()
    expect(v0.active.map((s) => s.name)).not.toContain("ban")
    expect(v0.searchable.map((e) => e.skill.name)).not.toContain("ban")
    expect(v0.management.find((m) => m.name === "ban")?.disableReason).toBe("administrator")
    // Enabling a banned skill is refused.
    const res = await authority.setEnabled("ban", true, v0.revision)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.rejection).toEqual({ kind: "policy_denied", name: "ban", reason: "banned" })
  })

  test("unknown skill fails CLOSED", async () => {
    const { authority } = build([{ name: "known", scope: "user" }])
    const res = await authority.setEnabled("ghost", false, 0)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.rejection).toEqual({ kind: "unknown_skill", name: "ghost" })
  })

  test("administrator reason outranks user reason (admin supreme)", async () => {
    const { authority } = build([{ name: "s", scope: "user" }], {
      policy: policy({ bannedSkills: ["s"] }),
      persisted: { schemaVersion: DISABLED_SET_SCHEMA_VERSION, revision: 1, names: ["s"] },
    })
    // Both user-disabled AND admin-banned → the surfaced reason is administrator.
    expect(authority.read().management.find((m) => m.name === "s")?.disableReason).toBe(
      "administrator",
    )
  })
})

/* ------------------------------------------------------------------------- *
 * resolveActive — execution-time presence check.
 * ------------------------------------------------------------------------- */

describe("F1 — resolveActive", () => {
  test("returns the skill while active and undefined after a disable", async () => {
    const { authority } = build([{ name: "e", scope: "user" }])
    expect(authority.resolveActive("e")?.name).toBe("e")
    await authority.setEnabled("e", false, 0)
    expect(authority.resolveActive("e")).toBeUndefined()
  })
})

/* ------------------------------------------------------------------------- *
 * Durable store — versioned + corrupt/unknown fail-close.
 * ------------------------------------------------------------------------- */

describe("F1 — versioned disabled store (fail-closed)", () => {
  test("decodeDisabledSet fail-closes corrupt / wrong-version / malformed to empty", () => {
    expect(decodeDisabledSet(undefined)).toEqual(emptyDisabledSet())
    expect(decodeDisabledSet("not an object")).toEqual(emptyDisabledSet())
    expect(decodeDisabledSet({ schemaVersion: 999, revision: 2, names: ["x"] })).toEqual(
      emptyDisabledSet(),
    )
    expect(
      decodeDisabledSet({ schemaVersion: DISABLED_SET_SCHEMA_VERSION, revision: -1, names: [] }),
    ).toEqual(emptyDisabledSet())
    expect(
      decodeDisabledSet({ schemaVersion: DISABLED_SET_SCHEMA_VERSION, revision: 1, names: [3] }),
    ).toEqual(emptyDisabledSet())
  })

  test("decodeDisabledSet round-trips a valid record (de-dupes + sorts)", () => {
    expect(
      decodeDisabledSet({
        schemaVersion: DISABLED_SET_SCHEMA_VERSION,
        revision: 4,
        names: ["b", "a", "b"],
      }),
    ).toEqual({ schemaVersion: DISABLED_SET_SCHEMA_VERSION, revision: 4, names: ["a", "b"] })
  })

  test("JSON store: corrupt file bytes fail-close to empty on read", async () => {
    const files = new Map<string, string>([["/d/.disabled.json", "{ not json"]])
    const fs: DisabledStoreFs = {
      readText: async (p) => files.get(p) ?? null,
      writeText: async (p, t) => {
        files.set(p, t)
      },
    }
    const store = createJsonDisabledStore({ path: "/d/.disabled.json", fs })
    expect(await store.read()).toEqual(emptyDisabledSet())
  })

  test("JSON store: write persists a record read back at its revision", async () => {
    const files = new Map<string, string>()
    const fs: DisabledStoreFs = {
      readText: async (p) => files.get(p) ?? null,
      writeText: async (p, t) => {
        files.set(p, t)
      },
    }
    const store = createJsonDisabledStore({ path: "/d/.disabled.json", fs })
    await store.write({ schemaVersion: DISABLED_SET_SCHEMA_VERSION, revision: 7, names: ["z"] })
    const back = await store.read()
    expect(back.revision).toBe(7)
    expect(back.names).toEqual(["z"])
  })

  test("authority seeds its unified revision from the persisted disabled set", async () => {
    const { authority } = build([{ name: "p", scope: "user" }], {
      persisted: { schemaVersion: DISABLED_SET_SCHEMA_VERSION, revision: 5, names: ["p"] },
    })
    expect(authority.read().revision).toBe(5)
    expect(authority.read().active.map((s) => s.name)).not.toContain("p")
    // A commit advances from the seeded revision.
    const res = await authority.setEnabled("p", true, 5)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.view.revision).toBe(6)
    expect(res.view.active.map((s) => s.name)).toContain("p")
  })

  test("sync re-reads the durable store and republishes consistent projections", async () => {
    const store = createInMemoryDisabledStore()
    const { authority } = build([{ name: "q", scope: "user" }], { store })
    // Another process wrote a disable directly to the durable store.
    await store.write({ schemaVersion: DISABLED_SET_SCHEMA_VERSION, revision: 9, names: ["q"] })
    const v = await authority.sync()
    expect(v.revision).toBe(9)
    expect(v.active.map((s) => s.name)).not.toContain("q")
    expect(v.searchable.map((e) => e.skill.name)).not.toContain("q")
    expect(v.management.find((m) => m.name === "q")?.disableReason).toBe("user")
  })

  test("sync is idempotent after a local commit (durable store is source of truth, no rollback)", async () => {
    const { authority } = build([
      { name: "m", scope: "user" },
      { name: "n", scope: "user" },
    ])
    const committed = await authority.setEnabled("m", false, 0)
    expect(committed.ok).toBe(true)
    if (!committed.ok) return
    const rev = committed.view.revision
    const synced = await authority.sync()
    // sync neither rolls back the revision nor resurrects the locally-disabled m.
    expect(synced.revision).toBe(rev)
    expect(synced.active.map((s) => s.name)).toEqual(["n"])
    expect(synced.management.find((x) => x.name === "m")?.enabled).toBe(false)
  })
})
