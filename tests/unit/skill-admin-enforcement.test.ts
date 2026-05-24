/**
 * ADR-0134 Phase C — Admin policy + install enforcement + audit log.
 *
 * Coverage (admin-policy.ts):
 *  1. parseAdminPolicy — valid manifest round-trip
 *  2. parseAdminPolicy — invalid JSON ⇒ ok:false
 *  3. parseAdminPolicy — unknown field ⇒ ok:false (strict mode)
 *  4. parseAdminPolicy — defaults: requiredSkills=[], bannedSkills=[], auditRequired=false
 *  5. validateAdminPolicy — required ∩ banned ⇒ error
 *  6. loadAdminPolicy — orgConfigDir=null ⇒ policy:null
 *  7. loadAdminPolicy — ENOENT ⇒ policy:null
 *  8. loadAdminPolicy — malformed manifest THROWS (loud failure invariant)
 *
 * Coverage (install-enforcement.ts):
 *  9. install admin scope + no policy ⇒ DENIED (admin scope disabled)
 * 10. install admin scope + policy loaded ⇒ ALLOWED + admin_install event
 * 11. install non-admin + banned skill ⇒ DENIED + banned_install_blocked
 * 12. install non-admin + non-banned ⇒ ALLOWED
 * 13. disable admin-required skill ⇒ DENIED + admin_attempt_disable
 * 14. disable non-required ⇒ ALLOWED
 * 15. remove admin scope + policy ⇒ ALLOWED + admin_remove
 * 16. remove admin scope + no policy ⇒ DENIED
 * 17. requiredAdminSkillNames / bannedSkillNames aggregators
 *
 * Coverage (audit-log.ts):
 * 18. buildAuditEntry — ts is ISO 8601, seq is monotonic
 * 19. memoryAuditWriter appendAuditEntry round-trip
 * 20. audit log line is one JSON object per line (JSONL contract)
 * 21. auditLogPathFor canonical path
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AdminPolicy, AuditClock } from "@/skill"
import {
  appendAuditEntry,
  auditLogPathFor,
  bannedSkillNames,
  buildAuditEntry,
  decideInstall,
  loadAdminPolicy,
  memoryAuditWriter,
  parseAdminPolicy,
  requiredAdminSkillNames,
  resetAuditSeqForTesting,
  validateAdminPolicy,
} from "@/skill"

beforeEach(() => resetAuditSeqForTesting())
afterEach(() => resetAuditSeqForTesting())

const fixedClock = (msArr: number[]): AuditClock => {
  let i = 0
  return {
    now: () => {
      const v = msArr[i] ?? msArr[msArr.length - 1] ?? 0
      i++
      return v
    },
  }
}

describe("parseAdminPolicy", () => {
  test("valid manifest round-trips with defaults", () => {
    const r = parseAdminPolicy('{"requiredSkills":["audit"],"bannedSkills":[]}')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.requiredSkills).toEqual(["audit"])
    expect(r.value.auditRequired).toBe(false)
  })

  test("defaults all fields when only some are supplied", () => {
    const r = parseAdminPolicy('{"requiredSkills":["x"]}')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.requiredSkills).toEqual(["x"])
    expect(r.value.bannedSkills).toEqual([])
    expect(r.value.auditRequired).toBe(false)
  })

  test("invalid JSON ⇒ ok:false", () => {
    const r = parseAdminPolicy("not json")
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("invalid JSON")
  })

  test("unknown field ⇒ ok:false (strict)", () => {
    const r = parseAdminPolicy('{"requiredSkills":[],"sneaky":true}')
    expect(r.ok).toBe(false)
  })

  test("auditRequired must be a boolean", () => {
    const r = parseAdminPolicy('{"auditRequired":"yes"}')
    expect(r.ok).toBe(false)
  })

  test("optional org field", () => {
    const r = parseAdminPolicy('{"org":"acme-corp"}')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.org).toBe("acme-corp")
  })
})

describe("validateAdminPolicy", () => {
  test("disjoint required/banned ⇒ ok", () => {
    const p: AdminPolicy = {
      requiredSkills: ["a", "b"],
      bannedSkills: ["c"],
      auditRequired: false,
    }
    expect(validateAdminPolicy(p)).toEqual({ ok: true })
  })

  test("overlap ⇒ error", () => {
    const p: AdminPolicy = {
      requiredSkills: ["a", "x"],
      bannedSkills: ["x"],
      auditRequired: false,
    }
    const r = validateAdminPolicy(p)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain("'x'")
  })
})

describe("loadAdminPolicy", () => {
  test("orgConfigDir absent ⇒ policy:null", async () => {
    const r = await loadAdminPolicy({ orgConfigDir: null })
    expect(r).toEqual({ policy: null, sourcePath: null })
    const r2 = await loadAdminPolicy({ orgConfigDir: undefined })
    expect(r2).toEqual({ policy: null, sourcePath: null })
  })

  test("ENOENT ⇒ policy:null (test seam)", async () => {
    const r = await loadAdminPolicy({
      orgConfigDir: "/nonexistent",
      readPolicyFile: async () => null,
    })
    expect(r.policy).toBeNull()
  })

  test("valid manifest ⇒ loaded with sourcePath", async () => {
    const r = await loadAdminPolicy({
      orgConfigDir: "/org",
      readPolicyFile: async (p) => {
        expect(p).toBe("/org/org-policy.json")
        return '{"requiredSkills":["audit"],"auditRequired":true}'
      },
    })
    expect(r.policy?.requiredSkills).toEqual(["audit"])
    expect(r.policy?.auditRequired).toBe(true)
    expect(r.sourcePath).toBe("/org/org-policy.json")
  })

  test("malformed manifest THROWS (loud failure)", async () => {
    await expect(
      loadAdminPolicy({
        orgConfigDir: "/org",
        readPolicyFile: async () => "not json",
      }),
    ).rejects.toThrow(/invalid JSON/)
  })

  test("cross-field invariant violation THROWS", async () => {
    await expect(
      loadAdminPolicy({
        orgConfigDir: "/org",
        readPolicyFile: async () => '{"requiredSkills":["x"],"bannedSkills":["x"]}',
      }),
    ).rejects.toThrow(/'x'/)
  })

  test("real filesystem ENOENT yields null", async () => {
    const dir = await mkdtemp(join(tmpdir(), "admin-policy-"))
    const r = await loadAdminPolicy({ orgConfigDir: dir })
    expect(r.policy).toBeNull()
  })

  test("real filesystem present file is read + parsed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "admin-policy-"))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "org-policy.json"), '{"requiredSkills":["pin"],"auditRequired":true}')
    const r = await loadAdminPolicy({ orgConfigDir: dir })
    expect(r.policy?.requiredSkills).toEqual(["pin"])
  })
})

describe("decideInstall — install kind", () => {
  test("admin scope + no policy ⇒ DENIED", () => {
    const d = decideInstall({ kind: "install", skillName: "x", requestedScope: "admin" }, null)
    expect(d.allowed).toBe(false)
    expect(d.reason).toContain("no org-policy.json")
    expect(d.auditEvent).toBeNull()
  })

  test("admin scope + policy ⇒ ALLOWED + admin_install audit", () => {
    const policy: AdminPolicy = { requiredSkills: [], bannedSkills: [], auditRequired: false }
    const d = decideInstall({ kind: "install", skillName: "x", requestedScope: "admin" }, policy)
    expect(d.allowed).toBe(true)
    expect(d.auditEvent).toBe("admin_install")
  })

  test("non-admin install + banned skill ⇒ DENIED + banned_install_blocked", () => {
    const policy: AdminPolicy = { requiredSkills: [], bannedSkills: ["bad"], auditRequired: true }
    const d = decideInstall({ kind: "install", skillName: "bad", requestedScope: "user" }, policy)
    expect(d.allowed).toBe(false)
    expect(d.auditEvent).toBe("banned_install_blocked")
    expect(d.reason).toContain("banned")
  })

  test("non-admin install + non-banned ⇒ ALLOWED, no audit", () => {
    const policy: AdminPolicy = { requiredSkills: [], bannedSkills: ["bad"], auditRequired: true }
    const d = decideInstall({ kind: "install", skillName: "good", requestedScope: "user" }, policy)
    expect(d.allowed).toBe(true)
    expect(d.auditEvent).toBeNull()
  })
})

describe("decideInstall — disable kind", () => {
  test("disable admin-required ⇒ DENIED + admin_attempt_disable", () => {
    const policy: AdminPolicy = {
      requiredSkills: ["pinned"],
      bannedSkills: [],
      auditRequired: true,
    }
    const d = decideInstall(
      { kind: "disable", skillName: "pinned", requestedScope: "admin" },
      policy,
    )
    expect(d.allowed).toBe(false)
    expect(d.auditEvent).toBe("admin_attempt_disable")
    expect(d.reason).toContain("admin-required")
  })

  test("disable non-required ⇒ ALLOWED", () => {
    const policy: AdminPolicy = {
      requiredSkills: ["other"],
      bannedSkills: [],
      auditRequired: false,
    }
    const d = decideInstall({ kind: "disable", skillName: "free", requestedScope: "user" }, policy)
    expect(d.allowed).toBe(true)
    expect(d.auditEvent).toBeNull()
  })
})

describe("decideInstall — remove kind", () => {
  test("admin remove + policy ⇒ ALLOWED + admin_remove", () => {
    const policy: AdminPolicy = { requiredSkills: [], bannedSkills: [], auditRequired: false }
    const d = decideInstall({ kind: "remove", skillName: "x", requestedScope: "admin" }, policy)
    expect(d.allowed).toBe(true)
    expect(d.auditEvent).toBe("admin_remove")
  })

  test("admin remove + no policy ⇒ DENIED", () => {
    const d = decideInstall({ kind: "remove", skillName: "x", requestedScope: "admin" }, null)
    expect(d.allowed).toBe(false)
    expect(d.auditEvent).toBeNull()
  })

  test("non-admin remove ⇒ ALLOWED, no audit", () => {
    const policy: AdminPolicy = { requiredSkills: [], bannedSkills: [], auditRequired: false }
    const d = decideInstall({ kind: "remove", skillName: "x", requestedScope: "user" }, policy)
    expect(d.allowed).toBe(true)
    expect(d.auditEvent).toBeNull()
  })
})

describe("aggregator helpers", () => {
  test("requiredAdminSkillNames + bannedSkillNames", () => {
    const policy: AdminPolicy = {
      requiredSkills: ["a", "b"],
      bannedSkills: ["x"],
      auditRequired: false,
    }
    expect(requiredAdminSkillNames(policy)).toEqual(["a", "b"])
    expect(bannedSkillNames(policy)).toEqual(["x"])
    expect(requiredAdminSkillNames(null)).toEqual([])
    expect(bannedSkillNames(null)).toEqual([])
  })
})

describe("audit log", () => {
  test("buildAuditEntry — ts is ISO 8601, seq monotonic", () => {
    const clock = fixedClock([1_700_000_000_000, 1_700_000_000_001])
    const e1 = buildAuditEntry({ event: "admin_install", skillName: "x" }, clock)
    const e2 = buildAuditEntry({ event: "admin_install", skillName: "y" }, clock)
    expect(e1.ts).toBe("2023-11-14T22:13:20.000Z")
    expect(e2.ts).toBe("2023-11-14T22:13:20.001Z")
    expect(e2.seq).toBe(e1.seq + 1)
  })

  test("appendAuditEntry → memory writer captures one JSON line", async () => {
    const writer = memoryAuditWriter()
    const clock = fixedClock([1_700_000_000_000])
    const e = await appendAuditEntry({
      logPath: "/repo/.quanta/audit/skill-install.log",
      event: { event: "admin_install", skillName: "audit-pin", admin: "acme" },
      clock,
      writer,
    })
    expect(writer.lines).toHaveLength(1)
    const line = writer.lines[0] ?? ""
    expect(line.endsWith("\n")).toBe(true)
    const parsed = JSON.parse(line.trimEnd())
    expect(parsed).toEqual({
      ts: "2023-11-14T22:13:20.000Z",
      seq: e.seq,
      event: "admin_install",
      skillName: "audit-pin",
      admin: "acme",
    })
  })

  test("appendAuditEntry — multiple events are append-only (in order)", async () => {
    const writer = memoryAuditWriter()
    const clock = fixedClock([1_700_000_000_000, 1_700_000_000_001, 1_700_000_000_002])
    await appendAuditEntry({
      logPath: "/x",
      event: { event: "admin_install", skillName: "a" },
      clock,
      writer,
    })
    await appendAuditEntry({
      logPath: "/x",
      event: { event: "banned_install_blocked", skillName: "b" },
      clock,
      writer,
    })
    await appendAuditEntry({
      logPath: "/x",
      event: { event: "admin_attempt_disable", skillName: "c" },
      clock,
      writer,
    })
    expect(writer.lines).toHaveLength(3)
    const events = writer.lines.map((l) => JSON.parse(l.trimEnd()).event)
    expect(events).toEqual(["admin_install", "banned_install_blocked", "admin_attempt_disable"])
  })

  test("auditLogPathFor canonical path", () => {
    expect(auditLogPathFor("/r")).toBe("/r/.quanta/audit/skill-install.log")
  })
})
