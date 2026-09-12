// meta-test: exercises tools/feature-catalog/* (lives outside src/, no @/ alias).
import { describe, expect, test } from "bun:test"
import {
  buildEvidenceSummary,
  buildMetaLines,
  isBaselineFresh,
  renderCatalog,
} from "../../tools/feature-catalog/render"
import type { Feature, LoadedFeature } from "../../tools/feature-catalog/schema"

function makeFeature(over: Partial<Feature> = {}): Feature {
  const base: Feature = {
    id: "x",
    title: "X",
    section: 1,
    subsystem: "1.1",
    order: 0,
    maturity: "L3",
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
    surface_integration: { cli: "unknown", web: "unknown", evidence: {}, method: "unverified" },
    purpose: "do a thing",
    evidence: {
      code: [],
      adrs: [],
      tests: { unit: [], integration: [], contract: [] },
    },
    knobs: [],
    deliberate_hold: null,
  }
  return { ...base, ...over }
}

function asLoaded(f: Feature): LoadedFeature {
  return { feature: f, path: `mem://${f.id}` }
}

describe("buildEvidenceSummary — thin summary line", () => {
  test("renders code + ADR + tests + knobs", () => {
    const f = makeFeature({
      evidence: {
        code: ["src/runtime/sandbox.ts", "src/runtime/policy.ts"],
        adrs: [6, 11],
        tests: {
          unit: ["tests/unit/a.test.ts"],
          integration: ["tests/integration/b.test.ts", "tests/integration/c.test.ts"],
          contract: ["tests/contract/d.test.ts"],
        },
      },
      knobs: ["QUANTA_DOCKER"],
    })
    expect(buildEvidenceSummary(f)).toBe(
      "src/runtime/sandbox.ts, src/runtime/policy.ts · ADR-6,11 · 1u/2i/1c · ⚙️QUANTA_DOCKER",
    )
  })

  test("skips empty buckets", () => {
    const f = makeFeature({
      evidence: {
        code: ["src/a.ts"],
        adrs: [],
        tests: { unit: ["tests/unit/a.test.ts"], integration: [], contract: [] },
      },
    })
    expect(buildEvidenceSummary(f)).toBe("src/a.ts · 1u")
  })

  test("emits empty string when nothing", () => {
    const f = makeFeature()
    expect(buildEvidenceSummary(f)).toBe("")
  })
})

describe("buildMetaLines — Tier-3 integration axes", () => {
  test("emits no Tier-3 lines when all fields are defaults / [n-a]", () => {
    const f = makeFeature({
      ui_surfaces: ["n-a"],
      monitoring: "n-a",
      modes: ["n-a"],
      configurable: "n-a",
      telemetry_keys: [],
      config_refs: {},
    } as Partial<Feature>)
    const out = buildMetaLines(f)
    expect(out).not.toContain("**UI**")
    expect(out).not.toContain("**Monitoring**")
    expect(out).not.toContain("**Modes**")
    expect(out).not.toContain("**Configurable**")
  })

  test("renders **UI** when ui_surfaces has real signal, drops `n-a`", () => {
    const f = makeFeature({
      ui_surfaces: ["cli", "n-a", "ide"],
    } as Partial<Feature>)
    expect(buildMetaLines(f)).toContain("**UI**: cli, ide")
  })

  test("renders **Monitoring** with top-3 telemetry keys when integrated", () => {
    const f = makeFeature({
      monitoring: "integrated",
      telemetry_keys: ["k1", "k2", "k3", "k4"],
    } as Partial<Feature>)
    const out = buildMetaLines(f)
    expect(out).toContain("**Monitoring**: integrated · keys: k1, k2, k3")
    expect(out).not.toContain("k4")
  })

  test("renders **Monitoring** without keys when telemetry_keys empty", () => {
    const f = makeFeature({
      monitoring: "partial",
      telemetry_keys: [],
    } as Partial<Feature>)
    expect(buildMetaLines(f)).toContain("**Monitoring**: partial")
  })

  test("suppresses **Modes** when all 6 modes listed (no selectivity)", () => {
    const f = makeFeature({
      modes: ["interactive", "headless", "batch", "daemon", "ide", "ci-bot"],
    } as Partial<Feature>)
    expect(buildMetaLines(f)).not.toContain("**Modes**")
  })

  test("renders **Modes** when subset listed, caps at top 3", () => {
    const f = makeFeature({
      modes: ["interactive", "headless", "batch", "daemon"],
    } as Partial<Feature>)
    const out = buildMetaLines(f)
    expect(out).toContain("**Modes**: interactive, headless, batch")
    expect(out).not.toContain("daemon")
  })

  test("renders **Configurable** with top-3 env vars when integrated", () => {
    const f = makeFeature({
      configurable: "integrated",
      config_refs: { env: ["A", "B", "C", "D"] },
    } as Partial<Feature>)
    const out = buildMetaLines(f)
    expect(out).toContain("**Configurable**: integrated · env: A, B, C")
    expect(out).not.toContain("D")
  })

  test("suppresses **Configurable** when status is none / static / planned", () => {
    for (const c of ["none", "static", "planned", "n-a"] as const) {
      const f = makeFeature({
        configurable: c,
        config_refs: { env: ["X"] },
      } as Partial<Feature>)
      expect(buildMetaLines(f)).not.toContain("**Configurable**")
    }
  })

  test("Tier-3 lines append after owners / labels / depends_on", () => {
    const f = makeFeature({
      owners: ["@a"],
      labels: ["t:core"],
      depends_on: ["dep1"],
      ui_surfaces: ["cli"],
      monitoring: "integrated",
      telemetry_keys: ["k1"],
      configurable: "integrated",
      config_refs: { env: ["E1"] },
    } as Partial<Feature>)
    const out = buildMetaLines(f)
    expect(out).toBe(
      [
        "**소유자**: @a",
        "**Labels**: t:core",
        "**의존**: dep1",
        "**UI**: cli",
        "**Monitoring**: integrated · keys: k1",
        "**Configurable**: integrated · env: E1",
      ].join("<br>"),
    )
  })
})

describe("renderCatalog — full output structure", () => {
  test("emits header + auto-gen comment + intro prose", () => {
    const md = renderCatalog({
      features: [],
      prose: { intro: "Some intro paragraph.", trailers: [] },
      baseline: null,
    })
    expect(md.startsWith("<!-- AUTO-GENERATED")).toBe(true)
    expect(md).toContain("# 10. 기능 카탈로그")
    expect(md).toContain("Some intro paragraph.")
    expect(md).toContain("## E2E 통합 커버리지")
    expect(md).toContain("## 등급 분포 요약")
    expect(md).toContain("## 잔류 deliberate-boundary")
  })

  test("groups features by section into tables, hides repeating subsystem", () => {
    const features: LoadedFeature[] = [
      asLoaded(
        makeFeature({
          id: "loop-fsm",
          section: 1,
          subsystem: "1.1 턴 상태머신",
          title: "단일 while 루프",
          maturity: "L5",
        }),
      ),
      asLoaded(
        makeFeature({
          id: "loop-maxturns",
          section: 1,
          subsystem: "1.1 턴 상태머신",
          title: "maxTurns",
          maturity: "L5",
        }),
      ),
      asLoaded(
        makeFeature({
          id: "tool-dispatch",
          section: 2,
          subsystem: "2.1 코어 도구",
          title: "9종 코어 도구",
          maturity: "L5",
        }),
      ),
    ]
    const md = renderCatalog({
      features,
      prose: { intro: "", trailers: [] },
      baseline: null,
    })
    expect(md).toContain("## 대 1. 에이전트 코어 루프 (ReAct)")
    expect(md).toContain("## 대 2. 도구 시스템")
    // Second entry in section 1 should have empty subsystem cell (collapse)
    const sec1 = md.split("## 대 2.")[0] ?? ""
    expect(sec1).toContain("| 1.1 턴 상태머신 | 단일 while 루프 |")
    expect(sec1).toContain("|  | maxTurns |")
  })

  test("E2E coverage section collects integration tests ending in -e2e.test.ts", () => {
    const features: LoadedFeature[] = [
      asLoaded(
        makeFeature({
          id: "feat-a",
          title: "Feature A",
          evidence: {
            code: [],
            adrs: [],
            tests: {
              unit: [],
              integration: [
                "tests/integration/closeout-e2e.test.ts",
                "tests/integration/other.test.ts",
              ],
              contract: [],
            },
          },
        }),
      ),
    ]
    const md = renderCatalog({
      features,
      prose: { intro: "", trailers: [] },
      baseline: null,
    })
    expect(md).toContain("- closeout · Feature A")
    expect(md).not.toContain("- other ·")
  })

  test("maturity distribution counts and lists titles", () => {
    const features: LoadedFeature[] = [
      asLoaded(makeFeature({ id: "a", title: "A", maturity: "L5" })),
      asLoaded(makeFeature({ id: "b", title: "B", maturity: "L5" })),
      asLoaded(makeFeature({ id: "c", title: "C", maturity: "L3" })),
    ]
    const md = renderCatalog({
      features,
      prose: { intro: "", trailers: [] },
      baseline: null,
    })
    // Thin distribution: L5/L4 show count only (long tail noise); L3/L2/L1
    // show counts + titles + section tag (the "what's not finished" set).
    expect(md).toContain("- **L5** (2)")
    expect(md).toContain("- **L3** (1): C (대 1)")
    expect(md).toContain("- **L4** (0)")
  })

  test("deliberate_hold section lists held features only", () => {
    const features: LoadedFeature[] = [
      asLoaded(
        makeFeature({
          id: "a",
          title: "Active",
          deliberate_hold: null,
        }),
      ),
      asLoaded(
        makeFeature({
          id: "h",
          title: "Held One",
          maturity: "L2",
          deliberate_hold: { reason: "advisory only", promotion_path: "ship after benchmark" },
        }),
      ),
    ]
    const md = renderCatalog({
      features,
      prose: { intro: "", trailers: [] },
      baseline: null,
    })
    expect(md).toContain("- **Held One** (L2) — advisory only → ship after benchmark")
    expect(md).not.toContain("**Active**")
  })

  test("footer includes baseline numbers when provided", () => {
    const md = renderCatalog({
      features: [],
      prose: { intro: "", trailers: [] },
      baseline: {
        pass: 1952,
        fail: 0,
        skip: 2,
        expect: 5624,
        files: 154,
        generated_at: "2026-05-21",
        measured_at_commit: "cafe1234",
        tsc: { exit: 0, errors: 0 },
        biome: { exit: 0, errors: 0 },
      },
      commit: "cafe1234",
    })
    expect(md).toContain("1952/0/2/5624 (154 files). 측정 시각: 2026-05-21 (커밋 cafe1234).")
  })

  test("trailer prose is inserted before footer", () => {
    const md = renderCatalog({
      features: [],
      prose: {
        intro: "INTRO_HEADER",
        trailers: [
          { name: "50-x.md", content: "TRAILER_FIFTY" },
          { name: "99-y.md", content: "TRAILER_NINETYNINE" },
        ],
      },
      baseline: null,
    })
    const introIdx = md.indexOf("INTRO_HEADER")
    const fiftyIdx = md.indexOf("TRAILER_FIFTY")
    const ninetyIdx = md.indexOf("TRAILER_NINETYNINE")
    const footerIdx = md.indexOf("검증 베이스라인")
    expect(introIdx).toBeGreaterThan(0)
    expect(fiftyIdx).toBeGreaterThan(introIdx)
    expect(ninetyIdx).toBeGreaterThan(fiftyIdx)
    expect(footerIdx).toBeGreaterThan(ninetyIdx)
  })

  test("golden snapshot — small fixtures set", () => {
    const features: LoadedFeature[] = [
      asLoaded(
        makeFeature({
          id: "loop-fsm",
          section: 1,
          subsystem: "1.1 턴 상태머신",
          title: "단일 while 루프",
          maturity: "L5",
          purpose: "ReAct 루프 진입점. 단일 while로 모든 분기를 표현.",
          evidence: {
            code: ["src/agent/loop.ts"],
            adrs: [4, 11],
            tests: { unit: ["tests/unit/loop.test.ts"], integration: [], contract: [] },
          },
        }),
      ),
      asLoaded(
        makeFeature({
          id: "verify-guard",
          section: 1,
          subsystem: "1.4 Verify-guard",
          title: "변경 후 검증 강제",
          maturity: "L4",
          purpose: "mutating 도구 후 verify 없이 finish 시 1턴 강제.",
          evidence: {
            code: ["src/agent/verify-guard.ts"],
            adrs: [13],
            tests: {
              unit: ["tests/unit/verify-guard.test.ts"],
              integration: ["tests/integration/verify-guard-e2e.test.ts"],
              contract: [],
            },
          },
          knobs: ["QUANTA_VERIFY_GUARD"],
        }),
      ),
    ]
    const md = renderCatalog({
      features,
      prose: {
        intro: "Round-1 baseline.",
        trailers: [{ name: "99-policy.md", content: "Policy." }],
      },
      baseline: {
        pass: 10,
        fail: 0,
        skip: 0,
        expect: 30,
        files: 3,
        generated_at: "2026-01-01",
        measured_at_commit: "abc123",
        tsc: { exit: 0, errors: 0 },
        biome: { exit: 0, errors: 0 },
      },
      commit: "abc123",
    })
    const expected = [
      "<!-- AUTO-GENERATED from tools/feature-catalog/. Do not edit. Run `bun fc build`. -->",
      "",
      "# 10. 기능 카탈로그 (Feature Catalog)",
      "",
      "Round-1 baseline.",
      "",
      "---",
      "",
      "## 대 1. 에이전트 코어 루프 (ReAct)",
      "",
      "| 중 | 소 | 등급 | 핵심 |",
      "|---|---|---|---|",
      "| 1.1 턴 상태머신 | 단일 while 루프 | **L5** `[C]` | ReAct 루프 진입점. 단일 while로 모든 분기를 표현. · src/agent/loop.ts · ADR-4,11 · 1u |",
      "| 1.4 Verify-guard | 변경 후 검증 강제 | **L4** `[C]` | mutating 도구 후 verify 없이 finish 시 1턴 강제. · src/agent/verify-guard.ts · ADR-13 · 1u/1i · ⚙️QUANTA_VERIFY_GUARD |",
      "",
      "---",
      "",
      "## E2E 통합 커버리지",
      "",
      "- verify-guard · 변경 후 검증 강제",
      "",
      "## 등급 분포 요약",
      "",
      "- **L5** (1)",
      "- **L4** (1)",
      "- **L3** (0)",
      "- **L2** (0)",
      "- **L1** (0)",
      "",
      "## 잔류 deliberate-boundary",
      "",
      "_(없음)_",
      "",
      "---",
      "",
      "Policy.",
      "",
      "---",
      "",
      "> 검증 베이스라인: tsc clean · biome clean · 10/0/0/30 (3 files). 측정 시각: 2026-01-01 (커밋 abc123).",
      "",
    ].join("\n")
    expect(md).toBe(expected)
  })
})

/**
 * Hellgate — the footer's toolchain verdict is RENDERED FROM THE MEASUREMENT,
 * never asserted.
 *
 * WHY THIS EXISTS. `renderCatalog` emitted the literal string `tsc 0 · biome
 * clean` while `baseline.json` recorded `tsc {exit:2, errors:38}` and `biome
 * {exit:1, errors:14}`. The loader made the claim unfalsifiable by construction:
 * it flattened only the test totals and dropped the toolchain block, so the data
 * that contradicted the sentence never reached the renderer. The generated
 * `docs/10.feature-catalog.md` is then byte-pinned by the `fc-ci` diff gate and
 * by CI, so the repo actively PRESERVED a false statement about its own health.
 *
 * Contract: clean is claimed only for exit 0 AND zero errors. A non-zero exit or
 * a non-zero error count renders a FAIL carrying both numbers. An absent or
 * malformed block renders `unknown` — fail-closed, because "we did not measure"
 * must never read the same as "we measured and it was clean".
 */
describe("baseline footer renders the measured toolchain verdict (P0-2)", () => {
  const footer = (
    tsc: { exit: number; errors: number } | null,
    biome: { exit: number; errors: number } | null,
  ): string =>
    renderCatalog({
      features: [],
      prose: { intro: "", trailers: [] },
      baseline: {
        pass: 1,
        fail: 0,
        skip: 0,
        expect: 1,
        files: 1,
        generated_at: "2026-01-01",
        measured_at_commit: "deadbeef",
        tsc,
        biome,
      },
      commit: "deadbeef",
    })

  /**
   * A verdict is only asserted for the tree it was measured on.
   *
   * The first fix here replaced a hardcoded `tsc 0 · biome clean` with a value
   * rendered from `baseline.json`. That removed one falsehood and installed its
   * mirror: the recorded measurement was from 2026-05-29 and the tree at render
   * time measured tsc exit 0 / 0 errors and biome exit 0 / 0 errors, so the
   * generated doc asserted two toolchain failures that did not exist — and the
   * `fc-ci` diff gate pinned that byte-for-byte. Deriving from data is not the
   * same as being true; the data has to be about this tree.
   */
  const staleFooter = (measuredAt: string | null, renderedAt: string | null): string =>
    renderCatalog({
      features: [],
      prose: { intro: "", trailers: [] },
      baseline: {
        pass: 1,
        fail: 0,
        skip: 0,
        expect: 1,
        files: 1,
        generated_at: "2026-05-29",
        measured_at_commit: measuredAt,
        tsc: { exit: 2, errors: 38 },
        biome: { exit: 1, errors: 14 },
      },
      commit: renderedAt,
    })

  test("a baseline measured at another commit asserts NOTHING", () => {
    const md = staleFooter("aaaaaaa", "bbbbbbb")
    expect(md).toContain("STALE")
    expect(md).toContain("판정을 주장하지 않는다")
    // The measurement is still reported, so the reader can see what was recorded.
    expect(md).toContain("FAIL(exit 2, errors 38)")
    expect(md).toContain("aaaaaaa")
  })

  test("an unrecorded measurement commit is stale, not fresh", () => {
    expect(staleFooter(null, "bbbbbbb")).toContain("STALE")
    expect(staleFooter(null, "bbbbbbb")).toContain("미기록")
  })

  test("an unknown rendering commit is stale — a dirty tree cannot certify", () => {
    expect(staleFooter("aaaaaaa", null)).toContain("STALE")
    expect(staleFooter("aaaaaaa", "")).toContain("STALE")
  })

  test("matching commits DO assert the verdict — the stale path is not universal", () => {
    const md = staleFooter("aaaaaaa", "aaaaaaa")
    expect(md).not.toContain("STALE")
    expect(md).toContain("검증 베이스라인: tsc FAIL(exit 2, errors 38)")
  })

  test("isBaselineFresh is exact, never a prefix or substring match", () => {
    const b = {
      pass: 1,
      fail: 0,
      skip: 0,
      expect: 1,
      files: 1,
      generated_at: "x",
      measured_at_commit: "abc1234",
      tsc: null,
      biome: null,
    }
    expect(isBaselineFresh(b, "abc1234")).toBe(true)
    expect(isBaselineFresh(b, "abc12345")).toBe(false)
    expect(isBaselineFresh(b, "abc123")).toBe(false)
    expect(isBaselineFresh(b, "")).toBe(false)
    expect(isBaselineFresh(b, null)).toBe(false)
    expect(isBaselineFresh({ ...b, measured_at_commit: null }, "abc1234")).toBe(false)
    expect(isBaselineFresh({ ...b, measured_at_commit: "" }, "abc1234")).toBe(false)
  })

  test("a failing tsc/biome baseline is NEVER rendered as clean", () => {
    const md = footer({ exit: 2, errors: 38 }, { exit: 1, errors: 14 })
    expect(md).not.toContain("tsc 0")
    expect(md).not.toContain("biome clean")
    expect(md).toContain("tsc FAIL(exit 2, errors 38)")
    expect(md).toContain("biome FAIL(exit 1, errors 14)")
  })

  test("both numbers travel — a mutated count cannot hide behind the verdict word", () => {
    const md = footer({ exit: 1, errors: 7 }, { exit: 3, errors: 0 })
    expect(md).toContain("tsc FAIL(exit 1, errors 7)")
    // exit != 0 with zero errors is still a FAIL: the tool refused to answer.
    expect(md).toContain("biome FAIL(exit 3, errors 0)")
  })

  test("errors without a failing exit is still a FAIL (fail-closed on either axis)", () => {
    const md = footer({ exit: 0, errors: 5 }, { exit: 0, errors: 0 })
    expect(md).toContain("tsc FAIL(exit 0, errors 5)")
    expect(md).toContain("biome clean")
  })

  test("PAIRED CONTROL — a genuinely clean baseline renders clean", () => {
    const md = footer({ exit: 0, errors: 0 }, { exit: 0, errors: 0 })
    expect(md).toContain("tsc clean · biome clean")
    expect(md).not.toContain("FAIL")
  })

  test("an absent toolchain block renders unknown, never clean", () => {
    const md = footer(null, null)
    expect(md).toContain("tsc unknown · biome unknown")
    expect(md).not.toContain("clean")
  })

  test("one side unknown does not contaminate the other", () => {
    const md = footer(null, { exit: 0, errors: 0 })
    expect(md).toContain("tsc unknown")
    expect(md).toContain("biome clean")
  })
})
