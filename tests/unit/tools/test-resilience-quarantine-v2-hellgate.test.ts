/**
 * HELLGATE — what a quarantine entry has to PROVE (TVH-15 item 7).
 *
 * The ledger used to carry `file`, `name`, `resourceClass`, `reason` and
 * nothing was checked against the world. Consequences, each of which has a case
 * below: no owner (the promise is to nobody), no expiry (the one live entry has
 * been quarantined since 2026-06-16 and nothing would ever have noticed), no
 * fingerprint (the test can start failing for a different reason and stay
 * excused), and no existence check (a renamed test leaves an entry that matches
 * NOTHING, indistinguishable from one doing its job).
 *
 * Every violation case is an INJECTION into the real ledger shape: the control
 * is the live ledger itself, which must validate clean. If validation were
 * vacuous the live ledger would pass and so would every injection.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  declaredTestNames,
  type QuarantineEntryV2,
  type QuarantineLedgerV2,
  validateQuarantineLedger,
} from "../../../tools/test-resilience/quarantine"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")
const LEDGER = JSON.parse(
  readFileSync(join(REPO_ROOT, "tools", "test-resilience", "quarantine.json"), "utf8"),
) as QuarantineLedgerV2

const readTestSource = (file: string): string | undefined => {
  try {
    return readFileSync(join(REPO_ROOT, file), "utf8")
  } catch {
    return undefined
  }
}

const NOW = Date.parse("2026-09-12T00:00:00Z")
const world = { nowMs: NOW, readTestSource }

const kinds = (ledger: QuarantineLedgerV2): readonly string[] =>
  validateQuarantineLedger(ledger, world).map((violation) => violation.kind)

const withEntry = (over: Partial<QuarantineEntryV2>): QuarantineLedgerV2 => ({
  maxCount: LEDGER.maxCount,
  entries: LEDGER.entries.map((entry, index) => (index === 0 ? { ...entry, ...over } : entry)),
})

describe("the live ledger is the control: it must validate clean", () => {
  test("no violations, and it is not empty", () => {
    // ANTI-VACUUM FLOOR: an empty ledger validates clean for free, so the floor
    // is what makes the clean result mean anything.
    expect(LEDGER.entries.length).toBeGreaterThanOrEqual(1)
    expect(validateQuarantineLedger(LEDGER, world)).toEqual([])
  })

  test("every entry carries the full provenance set", () => {
    for (const entry of LEDGER.entries) {
      expect(entry.owner.length).toBeGreaterThan(0)
      expect(entry.issue.length).toBeGreaterThan(0)
      expect(entry.firstSeenSha).toMatch(/^[a-f0-9]{40}$/)
      expect(entry.fingerprint).toMatch(/^[a-f0-9]{64}$/)
      expect(entry.resourceClaim.length).toBeGreaterThan(0)
      expect(Number.isNaN(Date.parse(entry.expiresAt))).toBe(false)
      expect(["blocking", "non-blocking"]).toContain(entry.criticality)
      expect(entry.reason.length).toBeGreaterThan(40)
    }
  })

  test("the one-directional ratchet still holds and stays low", () => {
    expect(LEDGER.entries.length).toBeLessThanOrEqual(LEDGER.maxCount)
    // Raising this is a reviewed act, not a convenience.
    expect(LEDGER.maxCount).toBeLessThanOrEqual(6)
  })
})

describe("RED on injection — each missing guarantee is its own violation", () => {
  test("an EXPIRED entry is red", () => {
    expect(kinds(withEntry({ expiresAt: "2026-01-01" }))).toContain("expired")
  })

  test("an entry expiring exactly NOW is red (the boundary is inclusive)", () => {
    expect(kinds(withEntry({ expiresAt: new Date(NOW).toISOString() }))).toContain("expired")
  })

  test("a missing OWNER is red", () => {
    expect(kinds(withEntry({ owner: "" }))).toContain("missing-field")
    expect(kinds(withEntry({ owner: "   " }))).toContain("missing-field")
  })

  test("a missing ISSUE, fingerprint, firstSeenSha, resourceClaim or criticality is red", () => {
    expect(kinds(withEntry({ issue: "" }))).toContain("missing-field")
    expect(kinds(withEntry({ fingerprint: "not-a-hash" }))).toContain("missing-field")
    expect(kinds(withEntry({ firstSeenSha: "abc" }))).toContain("missing-field")
    expect(kinds(withEntry({ resourceClaim: "" }))).toContain("missing-field")
    expect(kinds(withEntry({ criticality: "whenever" as unknown as "blocking" }))).toContain(
      "missing-field",
    )
  })

  test("an UNKNOWN test — renamed or deleted — is red", () => {
    expect(kinds(withEntry({ name: "this test name does not exist anywhere" }))).toContain(
      "unknown-test",
    )
    expect(kinds(withEntry({ file: "tests/unit/deleted-file.test.ts" }))).toContain("unknown-test")
  })

  test("an AMBIGUOUS entry — a substring matching several live tests — is red", () => {
    // Substring matching is how `-t` works, so a loose name silently
    // quarantines tests nobody reviewed. The expansion needs no edit to happen,
    // which is exactly why it has to be refused.
    expect(kinds(withEntry({ name: "a" }))).toContain("ambiguous-test")
  })

  test("a CRITICAL test can never be quarantined", () => {
    const critical = withEntry({ file: "tests/unit/bench-full-remote-hellgate.test.ts" })
    expect(kinds(critical)).toContain("critical-test")
  })

  test("more entries than maxCount is a ratchet breach", () => {
    const first = LEDGER.entries[0] as QuarantineEntryV2
    const doubled: QuarantineLedgerV2 = {
      maxCount: LEDGER.maxCount,
      entries: [first, { ...first, name: `${first.name} (copy)` }],
    }
    expect(kinds(doubled)).toContain("ratchet-breach")
  })

  test("a duplicate (file, name) is red", () => {
    const first = LEDGER.entries[0] as QuarantineEntryV2
    const duplicated: QuarantineLedgerV2 = { maxCount: 9, entries: [first, { ...first }] }
    expect(kinds(duplicated)).toContain("duplicate")
  })
})

describe("test existence is read from the AST, not from the text", () => {
  const SOURCE = `
import { describe, expect, test } from "bun:test"
// test("a commented-out name must not count")
describe("outer", () => {
  test("real one", () => { expect(1).toBe(1) })
  test.skipIf(process.platform === "win32")("real two", () => {})
  it("real three", () => {})
  test("no fixture is drawn from Math.random()", () => {
    expect("test(\\"quoted name inside a string\\")").toBeTruthy()
  })
})
const label = "test(\\"a name that only appears in data\\")"
`

  test("declared names are the literal first arguments of test/it calls", () => {
    const names = declaredTestNames("x.test.ts", SOURCE)
    expect(names).toContain("real one")
    expect(names).toContain("real two")
    expect(names).toContain("real three")
    expect(names).toContain("no fixture is drawn from Math.random()")
    // ANTI-VACUUM FLOOR: it really parsed something.
    expect(names.length).toBe(4)
  })

  test("a name that appears only in a comment or a string literal is NOT declared", () => {
    const names = declaredTestNames("x.test.ts", SOURCE)
    expect(names).not.toContain("a commented-out name must not count")
    expect(names).not.toContain("quoted name inside a string")
    expect(names).not.toContain("a name that only appears in data")
  })
})
