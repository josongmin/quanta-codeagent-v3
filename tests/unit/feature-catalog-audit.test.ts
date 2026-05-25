// meta-test: exercises tools/feature-catalog/* (lives outside src/, no @/ alias).
import { describe, expect, test } from "bun:test"
import {
  type AuditInputs,
  formatAuditReport,
  isEmptyStub,
  parseAdrStatus,
  runAudit,
} from "../../tools/feature-catalog/audit"
import type { Feature, LoadedFeature } from "../../tools/feature-catalog/schema"

function feature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: "x",
    title: "x",
    section: 1,
    subsystem: "x",
    order: 0,
    maturity: "L4",
    status: "stable",
    owners: [],
    labels: [],
    depends_on: [],
    lifecycle_stage: "active",
    supersedes: [],
    ui_surfaces: [],
    monitoring: "n-a",
    modes: [],
    configurable: "n-a",
    telemetry_keys: [],
    config_refs: {},
    purpose: "x",
    evidence: {
      code: [],
      adrs: [],
      tests: { unit: [], integration: [], contract: [] },
    },
    knobs: [],
    deliberate_hold: null,
    ...overrides,
  }
}

function loaded(f: Feature, path = "tools/feature-catalog/features/x.yaml"): LoadedFeature {
  return { feature: f, path }
}

describe("isEmptyStub", () => {
  test("true when all evidence arrays are empty", () => {
    expect(isEmptyStub(feature())).toBe(true)
  })
  test("false when code is non-empty", () => {
    expect(
      isEmptyStub(
        feature({
          evidence: {
            code: ["src/x.ts"],
            adrs: [],
            tests: { unit: [], integration: [], contract: [] },
          },
        }),
      ),
    ).toBe(false)
  })
  test("false when adrs is non-empty", () => {
    expect(
      isEmptyStub(
        feature({
          evidence: { code: [], adrs: [1], tests: { unit: [], integration: [], contract: [] } },
        }),
      ),
    ).toBe(false)
  })
  test("false when any test array is non-empty", () => {
    expect(
      isEmptyStub(
        feature({
          evidence: {
            code: [],
            adrs: [],
            tests: { unit: ["t.test.ts"], integration: [], contract: [] },
          },
        }),
      ),
    ).toBe(false)
    expect(
      isEmptyStub(
        feature({
          evidence: {
            code: [],
            adrs: [],
            tests: { unit: [], integration: ["t.test.ts"], contract: [] },
          },
        }),
      ),
    ).toBe(false)
    expect(
      isEmptyStub(
        feature({
          evidence: {
            code: [],
            adrs: [],
            tests: { unit: [], integration: [], contract: ["t.test.ts"] },
          },
        }),
      ),
    ).toBe(false)
  })
})

describe("parseAdrStatus", () => {
  test("English status line", () => {
    expect(parseAdrStatus("# ADR-0001\n\n- **Status**: Accepted\n")).toBe("Accepted")
  })
  test("Korean status line", () => {
    expect(parseAdrStatus("# ADR-0001\n\n- **상태**: Accepted (note)\n")).toBe("Accepted")
  })
  test("multi-word status returns first token only", () => {
    expect(parseAdrStatus("- **Status**: Reference-only\n")).toBe("Reference-only")
  })
  test("returns empty string when absent", () => {
    expect(parseAdrStatus("# ADR-0001\n\nBody without status.\n")).toBe("")
  })
  test("only looks at first 30 lines", () => {
    const body = `# ADR\n${"\n".repeat(40)}- **Status**: Accepted\n`
    expect(parseAdrStatus(body)).toBe("")
  })
})

describe("runAudit — orphan ADRs", () => {
  test("Accepted ADRs not referenced are orphans", () => {
    const inputs: AuditInputs = {
      features: [
        loaded(
          feature({
            evidence: {
              code: [],
              adrs: [1, 2],
              tests: { unit: [], integration: [], contract: [] },
            },
          }),
        ),
      ],
      srcFiles: [],
      adrs: [
        { number: 1, status: "Accepted" },
        { number: 2, status: "Accepted" },
        { number: 3, status: "Accepted" },
      ],
    }
    expect(runAudit(inputs).orphanAdrs).toEqual([3])
  })

  test("string ADR references count when they encode the ADR number", () => {
    const inputs: AuditInputs = {
      features: [
        loaded(
          feature({
            evidence: {
              code: [],
              adrs: ["7", "docs/decisions/0008-sample.md"],
              tests: { unit: [], integration: [], contract: [] },
            },
          }),
        ),
      ],
      srcFiles: [],
      adrs: [
        { number: 7, status: "Accepted" },
        { number: 8, status: "Accepted" },
        { number: 9, status: "Accepted" },
      ],
    }
    expect(runAudit(inputs).orphanAdrs).toEqual([9])
  })

  test("Proposed / Skipped / Reference-only ADRs are NOT considered orphans", () => {
    const inputs: AuditInputs = {
      features: [],
      srcFiles: [],
      adrs: [
        { number: 1, status: "Proposed" },
        { number: 2, status: "Skipped" },
        { number: 3, status: "Reference-only" },
        { number: 4, status: "" },
      ],
    }
    expect(runAudit(inputs).orphanAdrs).toEqual([])
  })

  test("returns sorted ascending", () => {
    const inputs: AuditInputs = {
      features: [],
      srcFiles: [],
      adrs: [
        { number: 5, status: "Accepted" },
        { number: 2, status: "Accepted" },
        { number: 9, status: "Accepted" },
      ],
    }
    expect(runAudit(inputs).orphanAdrs).toEqual([2, 5, 9])
  })
})

describe("runAudit — orphan src files", () => {
  test("files not in any code: evidence are orphans", () => {
    const inputs: AuditInputs = {
      features: [
        loaded(
          feature({
            evidence: {
              code: ["src/a.ts"],
              adrs: [],
              tests: { unit: [], integration: [], contract: [] },
            },
          }),
        ),
      ],
      srcFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
      adrs: [],
    }
    expect(runAudit(inputs).orphanSrcFiles).toEqual(["src/b.ts", "src/c.ts"])
  })

  test("multiple features contribute to the referenced set", () => {
    const inputs: AuditInputs = {
      features: [
        loaded(
          feature({
            id: "f1",
            evidence: {
              code: ["src/a.ts"],
              adrs: [],
              tests: { unit: [], integration: [], contract: [] },
            },
          }),
        ),
        loaded(
          feature({
            id: "f2",
            evidence: {
              code: ["src/b.ts"],
              adrs: [],
              tests: { unit: [], integration: [], contract: [] },
            },
          }),
        ),
      ],
      srcFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
      adrs: [],
    }
    expect(runAudit(inputs).orphanSrcFiles).toEqual(["src/c.ts"])
  })
})

describe("runAudit — empty stubs", () => {
  test("collects fully-empty features", () => {
    const empty = feature({ id: "e1" })
    const nonEmpty = feature({
      id: "n1",
      evidence: {
        code: ["src/x.ts"],
        adrs: [],
        tests: { unit: [], integration: [], contract: [] },
      },
    })
    const inputs: AuditInputs = {
      features: [loaded(empty, "p1"), loaded(nonEmpty, "p2")],
      srcFiles: [],
      adrs: [],
    }
    const report = runAudit(inputs)
    expect(report.emptyStubs).toEqual([{ id: "e1", title: "x", path: "p1" }])
  })

  test("counts match the lists", () => {
    const inputs: AuditInputs = {
      features: [loaded(feature({ id: "e1" }), "p1"), loaded(feature({ id: "e2" }), "p2")],
      srcFiles: ["src/x.ts"],
      adrs: [{ number: 99, status: "Accepted" }],
    }
    const report = runAudit(inputs)
    expect(report.counts).toEqual({
      orphanAdrs: 1,
      orphanSrcFiles: 1,
      emptyStubs: 2,
      totalFeatures: 2,
      totalAdrs: 1,
      totalSrcFiles: 1,
    })
  })
})

describe("formatAuditReport", () => {
  test("renders all three sections + counts", () => {
    const report = runAudit({
      features: [loaded(feature({ id: "e1" }), "p1")],
      srcFiles: ["src/x.ts"],
      adrs: [{ number: 5, status: "Accepted" }],
    })
    const text = formatAuditReport(report)
    expect(text).toContain("1 features / 1 ADRs / 1 src files")
    expect(text).toContain("orphan ADRs (Accepted, no fc reference): 1")
    expect(text).toContain("ADR-0005")
    expect(text).toContain("empty stubs")
    expect(text).toContain("orphan src files")
    expect(text).toContain("src/x.ts")
  })

  test("truncates lists over 20 items with summary line", () => {
    const srcFiles = Array.from({ length: 25 }, (_, i) => `src/f${i}.ts`)
    const report = runAudit({
      features: [],
      srcFiles,
      adrs: [],
    })
    const text = formatAuditReport(report)
    expect(text).toContain("... and 5 more")
  })
})
