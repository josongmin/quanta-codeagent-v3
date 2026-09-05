import { describe, expect, test } from "bun:test"
import { redactSecrets } from "@/security"
import { compositeSecretScanner, patternScanner } from "@/security/secret-detection"
import {
  SECRET_PATTERN_CATALOG,
  scanTextWithCatalog,
} from "@/security/secret-detection/pattern-scanner"
import { redactValue } from "@/shared"
import { BENIGN_SECRET_SHAPES, HIGH_VALUE_SECRET_SHAPES } from "../_support/secret-shape-corpus"

const namedKinds = (findings: readonly { kind: string }[]): string[] =>
  findings.map((f) => f.kind).filter((k) => k !== "generic-high-entropy")

describe("secret sink parity — corpus floors", () => {
  test("high-value corpus has at least 17 rows", () => {
    expect(HIGH_VALUE_SECRET_SHAPES.length).toBeGreaterThanOrEqual(17)
  })
  test("benign corpus has at least 8 rows", () => {
    expect(BENIGN_SECRET_SHAPES.length).toBeGreaterThanOrEqual(8)
  })
})

describe("secret sink parity — three planes", () => {
  for (const row of HIGH_VALUE_SECRET_SHAPES) {
    test(`${row.label}: both redactors change the sample`, () => {
      expect(redactValue(row.sample)).not.toBe(row.sample)
      expect(redactSecrets(row.sample, { origin: "tool_result" }).text).not.toBe(row.sample)
    })
    test(`${row.label}: pattern scanner names ${row.scannerKind}`, async () => {
      const hits = await patternScanner().scanText(row.sample)
      expect(namedKinds(hits)).toContain(row.scannerKind)
    })
    test(`${row.label}: composite with infinite entropy still names ${row.scannerKind}`, async () => {
      const hits = await compositeSecretScanner({
        entropyThreshold: Number.POSITIVE_INFINITY,
      }).scanText(row.sample)
      expect(namedKinds(hits)).toContain(row.scannerKind)
      expect(hits.some((h) => h.kind === row.scannerKind)).toBe(true)
    })
  }

  for (const row of BENIGN_SECRET_SHAPES) {
    test(`${row.label}: stays clean`, async () => {
      expect(redactValue(row.sample)).toBe(row.sample)
      expect(redactSecrets(row.sample, { origin: "tool_result" }).unchanged).toBe(true)
      expect(await patternScanner().scanText(row.sample)).toEqual([])
      expect(
        await compositeSecretScanner({ entropyThreshold: Number.POSITIVE_INFINITY }).scanText(
          row.sample,
        ),
      ).toEqual([])
    })
  }
})

describe("secret sink parity — mutation and allowlist", () => {
  test("removing one signature uncovers exactly its corpus row", () => {
    expect(SECRET_PATTERN_CATALOG.length).toBeGreaterThan(0)
    expect(HIGH_VALUE_SECRET_SHAPES.length).toBeGreaterThanOrEqual(17)
    for (const pat of SECRET_PATTERN_CATALOG) {
      const cloned = SECRET_PATTERN_CATALOG.filter((p) => p !== pat)
      const uncovered = HIGH_VALUE_SECRET_SHAPES.filter((row) => {
        if (row.scannerKind !== pat.kind) return false
        const remainingSameKind = cloned.filter((p) => p.kind === pat.kind)
        const hits = scanTextWithCatalog(row.sample, remainingSameKind, undefined, {})
        const stillCovered = hits.some((h) => h.kind === row.scannerKind)
        const original = scanTextWithCatalog(row.sample, SECRET_PATTERN_CATALOG, undefined, {})
        return original.some((h) => h.kind === row.scannerKind) && !stillCovered
      })
      if (uncovered.length === 0) continue
      expect(uncovered.every((u) => u.scannerKind === pat.kind)).toBe(true)
    }
  })

  test("mutation: drop url-userinfo signature → that row has zero named findings", async () => {
    const cloned = SECRET_PATTERN_CATALOG.filter((p) => p.kind !== "url-userinfo")
    const row = HIGH_VALUE_SECRET_SHAPES.find((r) => r.label === "url-userinfo")
    expect(row).toBeDefined()
    const hits = scanTextWithCatalog(row?.sample ?? "", cloned, undefined, {})
    expect(namedKinds(hits)).not.toContain("url-userinfo")
    const live = await patternScanner().scanText(row?.sample ?? "")
    expect(namedKinds(live)).toContain("url-userinfo")
  })

  test("allowlist suppresses composite but pattern scanner still sees the signature", async () => {
    const row = HIGH_VALUE_SECRET_SHAPES.find((r) => r.label === "gitlab-pat")
    expect(row).toBeDefined()
    const sample = row?.sample ?? ""
    const patternHits = await patternScanner().scanText(sample)
    expect(namedKinds(patternHits)).toContain("gitlab-pat")
    const compositeHits = await compositeSecretScanner({ allowlist: [sample] }).scanText(sample)
    expect(compositeHits).toEqual([])
  })
})
