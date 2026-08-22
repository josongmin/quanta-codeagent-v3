/**
 * RFC-06 F5 hellgate — per-skill copy / reveal / enable-disable actions.
 *
 * Pins the three F5 REDs + the all-surface convergence invariant:
 *
 *   (a) ACTION-TIME copy — a disk mutation that lands AFTER the surface was built
 *       IS reflected by copy (re-resolve + read at action time), NOT a
 *       construction-time snapshot. Red-on-injection: a construction-time capture
 *       returns the STALE bytes.
 *   (b) PATH-JAIL + BOUND — a symlink/repurpose escape is a typed `path_jail`
 *       refusal; an oversize file is a typed `too_large` refusal (no out-of-tree
 *       read, no unbounded slurp).
 *   (c) CAPABILITY-BASED reveal — an ABSENT reveal capability is the DISTINCT
 *       typed `unsupported` receipt, never a silent success.
 *   (d) CAS enable/disable — a stale-revision disable is rejected (RED (b) of the
 *       packet); the CLI action + the host command path mutate the SAME authority
 *       and converge; management retains the disabled row; re-enable restores.
 *   + NO delete/uninstall operation exists (F6 PARKED).
 */

import { describe, expect, test } from "bun:test"
import type { KernelDispatchContext, SessionHost } from "@/kernel/session"
import { applySkillCommand } from "@/kernel/session/skill-command"
import {
  buildSkillSetEnabled,
  SessionSkillConflictError,
  SessionSkillDeniedError,
  SessionSkillUnsupportedError,
} from "@/protocol/session"
import type {
  AdminPolicy,
  Skill,
  SkillActionPorts,
  SkillRegistry,
  SkillRegistryEntry,
  SkillRuntimeAuthority,
  SkillScope,
  SkillSnapshot,
} from "@/skill"
import * as skillActionsModule from "@/skill"
import {
  copySkillMarkdown,
  createInMemoryDisabledStore,
  createSkillRuntimeAuthority,
  revealSkill,
  setSkillEnabledAction,
} from "@/skill"

/* ------------------------------------------------------------------------- *
 * Fixtures.
 * ------------------------------------------------------------------------- */

const mkSkill = (name: string, scope: SkillScope): Skill => ({
  name,
  description: `desc-${name}`,
  body: `body-${name}`,
  sourcePath: `/skills/${name}/SKILL.md`,
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

const buildAuthority = (
  specs: readonly { name: string; scope: SkillScope }[],
  policy: AdminPolicy | null = null,
): SkillRuntimeAuthority => {
  const store = createInMemoryDisabledStore()
  return createSkillRuntimeAuthority({
    snapshot: mkSnapshot(specs),
    policy,
    disabledStore: store,
    persisted: { schemaVersion: 1, revision: 0, names: [] },
  })
}

/** A fake fs+resolve port over an in-memory disk. The disk is MUTABLE so a test
 *  can simulate an action-time change; `realpaths` overrides realpath to inject a
 *  jail escape. */
const mkPorts = (opts: {
  disk: Map<string, string>
  reveal?: (p: string) => Promise<void>
  realpaths?: Map<string, string>
}): SkillActionPorts => {
  const canon = (name: string): Skill | undefined =>
    opts.disk.has(`/skills/${name}/SKILL.md`) ? mkSkill(name, "user") : undefined
  return {
    resolveCanonicalSkill: async (name) => canon(name),
    statBytes: async (p) => {
      const v = opts.disk.get(p)
      if (v === undefined) throw new Error(`ENOENT ${p}`)
      return Buffer.byteLength(v, "utf8")
    },
    readFileUtf8: async (p) => {
      const v = opts.disk.get(p)
      if (v === undefined) throw new Error(`ENOENT ${p}`)
      return v
    },
    realpath: async (p) => opts.realpaths?.get(p) ?? p,
    ...(opts.reveal !== undefined ? { reveal: opts.reveal } : {}),
  }
}

/* ------------------------------------------------------------------------- *
 * (a) ACTION-TIME copy.
 * ------------------------------------------------------------------------- */

describe("F5 copy — action-time re-resolution + raw bytes", () => {
  test("reflects a disk mutation that lands AFTER the surface was built", async () => {
    const disk = new Map([["/skills/rr/SKILL.md", "---\nname: rr\n---\nV1 body"]])
    const ports = mkPorts({ disk })

    const first = await copySkillMarkdown(ports, { name: "rr" })
    expect(first.ok).toBe(true)
    if (first.ok) expect(first.markdown).toBe("---\nname: rr\n---\nV1 body")

    // Mutate the on-disk file AFTER the first copy.
    disk.set("/skills/rr/SKILL.md", "---\nname: rr\n---\nV2 body EDITED")

    const second = await copySkillMarkdown(ports, { name: "rr" })
    expect(second.ok).toBe(true)
    if (second.ok) {
      expect(second.markdown).toBe("---\nname: rr\n---\nV2 body EDITED")
      // RAW markdown — frontmatter INCLUDED (not the parsed `Skill.body`).
      expect(second.markdown).toContain("---\nname: rr\n---")
    }
  })

  test("RED-on-injection: a construction-time captured copy returns STALE bytes", async () => {
    // Ground-truth control: capture the Skill ONCE (the buggy construction-time
    // shape) and return its parsed body — it can never see the disk edit.
    const disk = new Map([["/skills/rr/SKILL.md", "V1"]])
    const captured = mkSkill("rr", "user") // captured at "construction"
    const constructionTimeCopy = (): string => `body-${captured.name}` // frozen, disk-blind
    disk.set("/skills/rr/SKILL.md", "V2")
    const live = await copySkillMarkdown(mkPorts({ disk }), { name: "rr" })
    expect(live.ok).toBe(true)
    if (live.ok) {
      expect(live.markdown).toBe("V2") // the SHIPPED action is live
      expect(constructionTimeCopy()).not.toBe(live.markdown) // the bug would be stale
    }
  })

  test("unknown skill ⇒ typed unknown_skill (no read attempt)", async () => {
    const res = await copySkillMarkdown(mkPorts({ disk: new Map() }), { name: "ghost" })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.rejection.kind).toBe("unknown_skill")
  })
})

/* ------------------------------------------------------------------------- *
 * (b) PATH-JAIL + BOUND.
 * ------------------------------------------------------------------------- */

describe("F5 copy — path-jail + byte-bound", () => {
  test("a symlink/repurpose escape is a typed path_jail refusal (no bytes read)", async () => {
    const disk = new Map([["/skills/rr/SKILL.md", "secret should not be copied"]])
    // realpath resolves the SKILL.md to a file OUTSIDE the skill dir (a symlink
    // escape); the jail must refuse before any read.
    const realpaths = new Map([
      ["/skills/rr/SKILL.md", "/etc/passwd"],
      ["/skills/rr", "/skills/rr"],
    ])
    const res = await copySkillMarkdown(mkPorts({ disk, realpaths }), { name: "rr" })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.rejection.kind).toBe("path_jail")
  })

  test("a sibling-prefix dir does NOT count as inside (no bare string prefix)", async () => {
    const disk = new Map([["/skills/rr/SKILL.md", "x"]])
    // realpath of the file lands in /skills/rrEVIL (shares the /skills/rr prefix
    // as a bare string but is a DIFFERENT dir) — must be rejected.
    const realpaths = new Map([
      ["/skills/rr/SKILL.md", "/skills/rrEVIL/SKILL.md"],
      ["/skills/rr", "/skills/rr"],
    ])
    const res = await copySkillMarkdown(mkPorts({ disk, realpaths }), { name: "rr" })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.rejection.kind).toBe("path_jail")
  })

  test("an oversize file is a typed too_large refusal", async () => {
    const disk = new Map([["/skills/rr/SKILL.md", "0123456789"]])
    const res = await copySkillMarkdown(mkPorts({ disk }), { name: "rr", maxBytes: 4 })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.rejection.kind).toBe("too_large")
      if (res.rejection.kind === "too_large") {
        expect(res.rejection.bytes).toBe(10)
        expect(res.rejection.limit).toBe(4)
      }
    }
  })

  test("an in-jail file within bound copies OK", async () => {
    const disk = new Map([["/skills/rr/SKILL.md", "ok bytes"]])
    const res = await copySkillMarkdown(mkPorts({ disk }), { name: "rr" })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.markdown).toBe("ok bytes")
      expect(res.sourcePath).toBe("/skills/rr/SKILL.md")
    }
  })
})

/* ------------------------------------------------------------------------- *
 * (c) CAPABILITY-BASED reveal.
 * ------------------------------------------------------------------------- */

describe("F5 reveal — capability-based typed negative", () => {
  test("ABSENT reveal capability ⇒ typed unsupported (never a silent success)", async () => {
    const disk = new Map([["/skills/rr/SKILL.md", "x"]])
    const res = await revealSkill(mkPorts({ disk }), { name: "rr" }) // no reveal port
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.rejection.kind).toBe("unsupported")
  })

  test("PRESENT reveal capability reveals the action-time source path", async () => {
    const disk = new Map([["/skills/rr/SKILL.md", "x"]])
    const revealed: string[] = []
    const res = await revealSkill(mkPorts({ disk, reveal: async (p) => void revealed.push(p) }), {
      name: "rr",
    })
    expect(res.ok).toBe(true)
    expect(revealed).toEqual(["/skills/rr/SKILL.md"])
  })

  test("reveal throw ⇒ typed reveal_failed (distinct from unsupported)", async () => {
    const disk = new Map([["/skills/rr/SKILL.md", "x"]])
    const res = await revealSkill(
      mkPorts({
        disk,
        reveal: async () => {
          throw new Error("no display")
        },
      }),
      { name: "rr" },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.rejection.kind).toBe("reveal_failed")
  })

  test("unknown skill ⇒ typed unknown_skill (before the capability check)", async () => {
    const res = await revealSkill(mkPorts({ disk: new Map() }), { name: "ghost" })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.rejection.kind).toBe("unknown_skill")
  })
})

/* ------------------------------------------------------------------------- *
 * (d) CAS enable/disable + all-surface convergence.
 * ------------------------------------------------------------------------- */

/** Minimal kernel dispatch ctx exposing ONLY the skill host projection. */
const ctxWith = (host: Partial<SessionHost>): KernelDispatchContext =>
  ({ host }) as unknown as KernelDispatchContext

/** A host whose `setSkillEnabled` routes through the REAL shared authority via
 *  the production host adapter (mirrors `createRuntimeSessionHost`). */
const hostForAuthority = (authority: SkillRuntimeAuthority): Partial<SessionHost> => ({
  setSkillEnabled: async ({ name, enabled, expectedRevision }) => {
    const expected = expectedRevision ?? authority.read().revision
    const result = await authority.setEnabled(name, enabled, expected)
    if (result.ok) return { ok: true, revision: result.view.revision }
    const r = result.rejection
    switch (r.kind) {
      case "stale_revision":
        return { ok: false, kind: "stale_revision", expected: r.expected, actual: r.actual }
      case "unknown_skill":
        return { ok: false, kind: "unknown_skill", name: r.name }
      case "policy_denied":
        return { ok: false, kind: "policy_denied", name: r.name, reason: r.reason }
      case "persist_failed":
        return { ok: false, kind: "persist_failed", detail: r.detail }
    }
  },
})

describe("F5 enable/disable — CAS + all-surface convergence", () => {
  test("a stale-revision disable is REJECTED (RED (b))", async () => {
    const authority = buildAuthority([{ name: "a", scope: "user" }])
    const staleRev = authority.read().revision // 0
    // A concurrent writer advances the authority first.
    await setSkillEnabledAction(authority, {
      name: "a",
      enabled: false,
      expectedRevision: staleRev,
    })
    // The second writer at the now-STALE revision must be rejected.
    const stale = await setSkillEnabledAction(authority, {
      name: "a",
      enabled: true,
      expectedRevision: staleRev,
    })
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.rejection.kind).toBe("stale_revision")
  })

  test("SAME authority: CLI action disables, host command path re-enables — convergent", async () => {
    const authority = buildAuthority([
      { name: "a", scope: "user" },
      { name: "b", scope: "user" },
    ])
    // CLI surface path (in-process action).
    const disabled = await setSkillEnabledAction(authority, {
      name: "a",
      enabled: false,
      expectedRevision: authority.read().revision,
    })
    expect(disabled.ok).toBe(true)
    let view = authority.read()
    expect(view.active.map((s) => s.name)).toEqual(["b"]) // 'a' gone from active
    expect(view.searchable.map((e) => e.skill.name)).toEqual(["b"])
    const mgmtA = view.management.find((m) => m.name === "a")
    expect(mgmtA?.enabled).toBe(false) // management RETAINS the row + reason
    expect(mgmtA?.disableReason).toBe("user")

    // Web/authenticated command path over the SAME authority — re-enable at the
    // current skill revision.
    await applySkillCommand(
      ctxWith(hostForAuthority(authority)),
      buildSkillSetEnabled({ sessionId: "s", clock: { now: () => new Date(0) } }, "a", true, {
        expectedSkillRevision: authority.read().revision,
      }),
    )
    view = authority.read()
    expect(view.active.map((s) => s.name)).toEqual(["a", "b"]) // restored
    expect(view.management.find((m) => m.name === "a")?.enabled).toBe(true)
    expect(view.revision).toBeGreaterThan(0) // one authority, monotonic revision
  })

  test("host command path raises a TYPED conflict on a stale skill revision", async () => {
    const authority = buildAuthority([{ name: "a", scope: "user" }])
    const staleRev = authority.read().revision
    await setSkillEnabledAction(authority, {
      name: "a",
      enabled: false,
      expectedRevision: staleRev,
    })
    await expect(
      applySkillCommand(
        ctxWith(hostForAuthority(authority)),
        buildSkillSetEnabled(
          { sessionId: "s", clock: { now: () => new Date(0) } },
          "a",
          true,
          { expectedSkillRevision: staleRev }, // stale
        ),
      ),
    ).rejects.toBeInstanceOf(SessionSkillConflictError)
  })

  test("ABSENT host projection ⇒ typed unsupported (never a silent success)", async () => {
    await expect(
      applySkillCommand(
        ctxWith({}), // no setSkillEnabled
        buildSkillSetEnabled(
          { sessionId: "s", clock: { now: () => new Date(0) } },
          "a",
          false,
          undefined,
        ),
      ),
    ).rejects.toBeInstanceOf(SessionSkillUnsupportedError)
  })

  test("an unknown skill through the command path is a TYPED denial", async () => {
    const authority = buildAuthority([{ name: "a", scope: "user" }])
    await expect(
      applySkillCommand(
        ctxWith(hostForAuthority(authority)),
        buildSkillSetEnabled(
          { sessionId: "s", clock: { now: () => new Date(0) } },
          "ghost",
          false,
          { expectedSkillRevision: authority.read().revision },
        ),
      ),
    ).rejects.toBeInstanceOf(SessionSkillDeniedError)
  })
})

/* ------------------------------------------------------------------------- *
 * NO delete/uninstall (F6 PARKED).
 * ------------------------------------------------------------------------- */

describe("F5 — no destructive operation", () => {
  test("the F5 action surface exports NO delete/uninstall/remove verb", () => {
    const names = Object.keys(skillActionsModule)
    const destructive = names.filter((n) => /uninstall|delete|remove|rmSkill|destroy/i.test(n))
    expect(destructive).toEqual([])
    // The three built verbs ARE present.
    expect(names).toContain("copySkillMarkdown")
    expect(names).toContain("revealSkill")
    expect(names).toContain("setSkillEnabledAction")
  })
})
