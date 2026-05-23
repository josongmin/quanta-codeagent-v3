import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AuditCounts, AuditReport } from "../../tools/feature-catalog/audit"
import {
  type FcBaseline,
  loadFcBaseline,
  runLint,
  saveFcBaseline,
  snapshotBaseline,
} from "../../tools/feature-catalog/lint"

interface ReportOverrides {
  readonly orphanAdrs?: readonly number[]
  readonly orphanSrcFiles?: readonly string[]
  readonly emptyStubs?: AuditReport["emptyStubs"]
  readonly counts?: Partial<AuditCounts>
}

function report(overrides: ReportOverrides = {}): AuditReport {
  const baseCounts: AuditCounts = {
    orphanAdrs: 0,
    orphanSrcFiles: 0,
    emptyStubs: 0,
    totalFeatures: 0,
    totalAdrs: 0,
    totalSrcFiles: 0,
  }
  return {
    orphanAdrs: overrides.orphanAdrs ?? [],
    orphanSrcFiles: overrides.orphanSrcFiles ?? [],
    emptyStubs: overrides.emptyStubs ?? [],
    counts: { ...baseCounts, ...(overrides.counts ?? {}) },
  }
}

const ZERO_BASELINE: FcBaseline = {
  empty_stubs_max: 0,
  orphan_adrs_grandfathered: [],
  updated_at: "1970-01-01T00:00:00.000Z",
}

describe("runLint — empty stub ratchet", () => {
  test("ok when stub count equals baseline", () => {
    const r = runLint(
      report({ emptyStubs: [{ id: "x", title: "x", path: "p" }], counts: { emptyStubs: 1 } }),
      {
        ...ZERO_BASELINE,
        empty_stubs_max: 1,
      },
    )
    expect(r.ok).toBe(true)
    expect(r.errors).toEqual([])
  })

  test("fails when stub count exceeds baseline", () => {
    const r = runLint(report({ counts: { emptyStubs: 5 } }), {
      ...ZERO_BASELINE,
      empty_stubs_max: 3,
    })
    expect(r.ok).toBe(false)
    expect(r.errors[0]).toContain("empty stubs: 5 > baseline 3")
  })

  test("warns (does NOT fail) when stub count is below baseline — ratchet can tighten", () => {
    const r = runLint(report({ counts: { emptyStubs: 1 } }), {
      ...ZERO_BASELINE,
      empty_stubs_max: 3,
    })
    expect(r.ok).toBe(true)
    expect(r.warnings.some((w) => w.includes("can tighten"))).toBe(true)
  })
})

describe("runLint — orphan Accepted ADR ratchet", () => {
  test("ok when all orphans are grandfathered", () => {
    const r = runLint(report({ orphanAdrs: [44], counts: { orphanAdrs: 1 } }), {
      ...ZERO_BASELINE,
      orphan_adrs_grandfathered: [44],
    })
    expect(r.ok).toBe(true)
  })

  test("fails on NEW orphan Accepted ADR (not grandfathered)", () => {
    const r = runLint(report({ orphanAdrs: [44, 88], counts: { orphanAdrs: 2 } }), {
      ...ZERO_BASELINE,
      orphan_adrs_grandfathered: [44],
    })
    expect(r.ok).toBe(false)
    expect(r.errors[0]).toContain("ADR-0088")
    expect(r.errors[0]).not.toContain("ADR-0044")
  })

  test("warns when grandfathered ADR was wired up — baseline should tighten", () => {
    const r = runLint(report({ orphanAdrs: [], counts: { orphanAdrs: 0 } }), {
      ...ZERO_BASELINE,
      orphan_adrs_grandfathered: [44],
    })
    expect(r.ok).toBe(true)
    expect(r.warnings.some((w) => w.includes("now wired up"))).toBe(true)
    expect(r.warnings.some((w) => w.includes("ADR-0044"))).toBe(true)
  })
})

describe("snapshotBaseline", () => {
  test("captures current empty_stubs count and sorted orphan ADRs", () => {
    const snap = snapshotBaseline(
      report({
        orphanAdrs: [88, 44, 90],
        emptyStubs: [
          { id: "a", title: "a", path: "pa" },
          { id: "b", title: "b", path: "pb" },
        ],
        counts: { orphanAdrs: 3, emptyStubs: 2 },
      }),
      () => new Date("2026-05-23T00:00:00.000Z"),
    )
    expect(snap.empty_stubs_max).toBe(2)
    expect(snap.orphan_adrs_grandfathered).toEqual([44, 88, 90])
    expect(snap.updated_at).toBe("2026-05-23T00:00:00.000Z")
  })
})

describe("loadFcBaseline / saveFcBaseline — round trip", () => {
  test("round trip preserves all fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fc-baseline-"))
    try {
      const path = join(dir, "baseline.json")
      const original: FcBaseline = {
        empty_stubs_max: 12,
        orphan_adrs_grandfathered: [3, 7, 9],
        updated_at: "2026-05-23T00:00:00.000Z",
      }
      await saveFcBaseline(original, path)
      const loaded = await loadFcBaseline(path)
      expect(loaded).toEqual(original)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("returns strict-zero default for missing file", async () => {
    const loaded = await loadFcBaseline("/nonexistent/baseline.json")
    expect(loaded.empty_stubs_max).toBe(0)
    expect(loaded.orphan_adrs_grandfathered).toEqual([])
  })

  test("preserves other top-level keys in baseline.json (no clobber)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fc-baseline-"))
    try {
      const path = join(dir, "baseline.json")
      await writeFile(
        path,
        JSON.stringify({ tests: { pass: 100 }, tsc: { errors: 0 } }, null, 2),
        "utf8",
      )
      await saveFcBaseline(
        { empty_stubs_max: 5, orphan_adrs_grandfathered: [1], updated_at: "now" },
        path,
      )
      const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
      expect(raw.tests).toEqual({ pass: 100 })
      expect(raw.tsc).toEqual({ errors: 0 })
      expect(raw.fc).toMatchObject({ empty_stubs_max: 5 })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("returns default when fc subobject is malformed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fc-baseline-"))
    try {
      const path = join(dir, "baseline.json")
      await writeFile(path, JSON.stringify({ fc: { empty_stubs_max: "not-a-number" } }), "utf8")
      const loaded = await loadFcBaseline(path)
      expect(loaded.empty_stubs_max).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
