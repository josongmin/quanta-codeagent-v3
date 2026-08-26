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
  readonly orphanAdrs?: readonly (number | AuditReport["orphanAdrs"][number])[]
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
    orphanAdrs: (overrides.orphanAdrs ?? []).map((n) =>
      typeof n === "number"
        ? {
            number: n,
            path: `docs/decisions/${String(n).padStart(4, "0")}-x.md`,
            status: "Accepted",
          }
        : n,
    ),
    orphanSrcFiles: overrides.orphanSrcFiles ?? [],
    emptyStubs: overrides.emptyStubs ?? [],
    counts: { ...baseCounts, ...(overrides.counts ?? {}) },
  }
}

const ZERO_BASELINE: FcBaseline = {
  empty_stubs_max: 0,
  orphan_adr_paths_grandfathered: [],
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
      orphan_adr_paths_grandfathered: ["docs/decisions/0044-x.md"],
    })
    expect(r.ok).toBe(true)
  })

  test("fails on NEW orphan Accepted ADR (not grandfathered)", () => {
    const r = runLint(report({ orphanAdrs: [44, 88], counts: { orphanAdrs: 2 } }), {
      ...ZERO_BASELINE,
      orphan_adr_paths_grandfathered: ["docs/decisions/0044-x.md"],
    })
    expect(r.ok).toBe(false)
    expect(r.errors[0]).toContain("ADR-0088")
    expect(r.errors[0]).not.toContain("ADR-0044")
  })

  test("🔴 a NEW orphan REUSING a grandfathered ADR number is not forgiven", () => {
    // Not hypothetical: 25 ADR numbers are used by more than one file in this
    // repo (four separate files are ADR-0159). Grandfathering by NUMBER meant a
    // brand-new Accepted ADR that happened to reuse one of the 18 forgiven
    // numbers was silently absorbed — verified against the live tool: the orphan
    // count went 32 -> 33 and `lint` still printed `ok`.
    //
    // Forgiveness is therefore keyed on the ADR's PATH, which is unique per file.
    const r = runLint(
      report({
        orphanAdrs: [
          { number: 159, path: "docs/decisions/0159-linux-sandbox.md", status: "Accepted" },
          { number: 159, path: "docs/decisions/0159-brand-new.md", status: "Accepted" },
        ],
        counts: { orphanAdrs: 2 },
      }),
      {
        ...ZERO_BASELINE,
        orphan_adr_paths_grandfathered: ["docs/decisions/0159-linux-sandbox.md"],
      },
    )
    expect(r.ok).toBe(false)
    expect(r.errors[0]).toContain("0159-brand-new.md")
    expect(r.errors[0]).not.toContain("0159-linux-sandbox.md")
  })

  test("warns when grandfathered ADR was wired up — baseline should tighten", () => {
    const r = runLint(report({ orphanAdrs: [], counts: { orphanAdrs: 0 } }), {
      ...ZERO_BASELINE,
      orphan_adr_paths_grandfathered: ["docs/decisions/0044-x.md"],
    })
    expect(r.ok).toBe(true)
    expect(r.warnings.some((w) => w.includes("now wired up"))).toBe(true)
    expect(r.warnings.some((w) => w.includes("0044-x.md"))).toBe(true)
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
    expect(snap.orphan_adr_paths_grandfathered).toEqual([
      "docs/decisions/0044-x.md",
      "docs/decisions/0088-x.md",
      "docs/decisions/0090-x.md",
    ])
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
        orphan_adr_paths_grandfathered: ["a", "b", "c"],
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
    expect(loaded.orphan_adr_paths_grandfathered).toEqual([])
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
        { empty_stubs_max: 5, orphan_adr_paths_grandfathered: ["a"], updated_at: "now" },
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
