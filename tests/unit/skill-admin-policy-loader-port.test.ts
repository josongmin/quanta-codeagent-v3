/**
 * P1 cleanup — admin-policy loader port (closed-port DIP).
 *
 * Coverage:
 *  1. Port mock load succeeds — domain loader returns parsed policy
 *  2. Reader returns null (ENOENT-equivalent) → policy:null (no throw)
 *  3. Reader throws non-ENOENT error → propagates (loud failure invariant)
 *  4. Malformed JSON via port → descriptive throw (parse error verbatim)
 *  5. Schema violation via port → descriptive throw (zod field path)
 *  6. Cross-field invariant violation via port → descriptive throw
 *  7. Concurrent loads with the same port → no shared state corruption
 *  8. Default fs reader (no `readPolicyFile`) — real fs fallback works
 *  9. defaultAdminPolicyReader returns null on ENOENT
 * 10. createFsAdminPolicyReader returns a callable reader
 * 11. Large file content (~1MB) loads correctly through port
 *
 * Discipline: no node:fs calls in the domain-test path (tests 1-7) — every
 * I/O is via the injected reader, proving the port truly isolates the side
 * effect. Tests 8/9/10/11 deliberately exercise the fs adapter to confirm
 * the lazy-import wiring works in production.
 */
import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type AdminPolicyReader,
  createFsAdminPolicyReader,
  defaultAdminPolicyReader,
  loadAdminPolicy,
} from "@/skill"

describe("AdminPolicyReader port — domain isolation", () => {
  test("1. port mock load → parsed policy", async () => {
    const reader: AdminPolicyReader = async (path) => {
      expect(path).toBe("/org/org-policy.json")
      return '{"requiredSkills":["audit"],"auditRequired":true}'
    }
    const r = await loadAdminPolicy({ orgConfigDir: "/org", readPolicyFile: reader })
    expect(r.policy?.requiredSkills).toEqual(["audit"])
    expect(r.policy?.auditRequired).toBe(true)
    expect(r.sourcePath).toBe("/org/org-policy.json")
  })

  test("2. reader returns null (ENOENT-equivalent) → policy:null", async () => {
    const reader: AdminPolicyReader = async () => null
    const r = await loadAdminPolicy({ orgConfigDir: "/org", readPolicyFile: reader })
    expect(r.policy).toBeNull()
    expect(r.sourcePath).toBeNull()
  })

  test("3. reader throws non-ENOENT → propagates (loud failure)", async () => {
    const reader: AdminPolicyReader = async () => {
      const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException
      err.code = "EACCES"
      throw err
    }
    await expect(loadAdminPolicy({ orgConfigDir: "/org", readPolicyFile: reader })).rejects.toThrow(
      /EACCES/,
    )
  })

  test("4. malformed JSON via port → descriptive throw", async () => {
    const reader: AdminPolicyReader = async () => "{not valid"
    await expect(loadAdminPolicy({ orgConfigDir: "/org", readPolicyFile: reader })).rejects.toThrow(
      /invalid JSON/,
    )
  })

  test("5. schema violation (unknown field) via port → descriptive throw", async () => {
    const reader: AdminPolicyReader = async () => '{"requiredSkills":[],"sneaky":"extra"}'
    await expect(
      loadAdminPolicy({ orgConfigDir: "/org", readPolicyFile: reader }),
    ).rejects.toThrow()
  })

  test("6. cross-field invariant violation (required ∩ banned) → throws", async () => {
    const reader: AdminPolicyReader = async () => '{"requiredSkills":["x"],"bannedSkills":["x"]}'
    await expect(loadAdminPolicy({ orgConfigDir: "/org", readPolicyFile: reader })).rejects.toThrow(
      /'x'/,
    )
  })

  test("7. concurrent loads with the same reader → no state corruption", async () => {
    // The reader returns DIFFERENT content per call (sequenced) — if the
    // domain accidentally shared parser state across concurrent invocations,
    // we'd see crossed results.
    let call = 0
    const reader: AdminPolicyReader = async () => {
      const i = ++call
      return `{"requiredSkills":["s${i}"]}`
    }
    const [a, b, c] = await Promise.all([
      loadAdminPolicy({ orgConfigDir: "/o", readPolicyFile: reader }),
      loadAdminPolicy({ orgConfigDir: "/o", readPolicyFile: reader }),
      loadAdminPolicy({ orgConfigDir: "/o", readPolicyFile: reader }),
    ])
    const names = [a, b, c].map((r) => r.policy?.requiredSkills[0]).sort()
    expect(names).toEqual(["s1", "s2", "s3"])
  })
})

describe("AdminPolicyReader port — fs adapter (lazy default)", () => {
  test("8. omitted readPolicyFile → fs adapter loads from real tmpdir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "admin-policy-port-"))
    await writeFile(join(dir, "org-policy.json"), '{"requiredSkills":["fs-loaded"]}')
    const r = await loadAdminPolicy({ orgConfigDir: dir })
    expect(r.policy?.requiredSkills).toEqual(["fs-loaded"])
  })

  test("9. defaultAdminPolicyReader returns null on ENOENT", async () => {
    const out = await defaultAdminPolicyReader("/this/path/does/not/exist/policy.json")
    expect(out).toBeNull()
  })

  test("10. createFsAdminPolicyReader returns a callable reader", async () => {
    const reader = createFsAdminPolicyReader()
    expect(typeof reader).toBe("function")
    // Wire it manually through the domain — proves the factory output is a
    // drop-in for the `readPolicyFile` opt.
    const dir = await mkdtemp(join(tmpdir(), "admin-policy-factory-"))
    await writeFile(join(dir, "org-policy.json"), '{"requiredSkills":["from-factory"]}')
    const r = await loadAdminPolicy({ orgConfigDir: dir, readPolicyFile: reader })
    expect(r.policy?.requiredSkills).toEqual(["from-factory"])
  })

  test("11. large content (~1MB) round-trips through the port", async () => {
    // Build a syntactically valid policy with a large requiredSkills list.
    // The point: the parse path itself is bounded only by what zod accepts,
    // and the port should not impose its own size cap.
    const big = Array.from({ length: 50_000 }, (_, i) => `skill-${i}`)
    const raw = JSON.stringify({ requiredSkills: big })
    const reader: AdminPolicyReader = async () => raw
    const r = await loadAdminPolicy({ orgConfigDir: "/org", readPolicyFile: reader })
    expect(r.policy?.requiredSkills.length).toBe(50_000)
  })
})
