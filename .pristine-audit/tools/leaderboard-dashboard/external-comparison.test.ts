import { describe, expect, test } from "bun:test"
import { buildExternalBaselines } from "./external-baselines"
import { externalCoordFor, externalSotaFor, externalSotaLabel } from "./external-comparison"

// A small baselines artifact: live/verified (two models), live/lite (one), plus the
// curated pro/public-731 baselines that buildExternalBaselines always appends.
const baselines = buildExternalBaselines(
  [
    JSON.stringify({ name: "Live-lo", set: "verified", total: 500, resolved: 100 }), // 20%
    JSON.stringify({ name: "AMI+Claude", set: "verified", total: 500, resolved: 315 }), // 63%
    JSON.stringify({ name: "Lite-only", set: "lite", total: 300, resolved: 150 }), // 50%
    JSON.stringify({ name: "Solver-A", set: "verified", total: 4, resolved: ["x__1", "x__2"] }),
  ].join("\n"),
  "src",
)

describe("externalCoordFor — our family ⇒ external (dataset,set)", () => {
  test("verified ⇒ NO external comparison (R4 keeps verified its own surface)", () => {
    expect(externalCoordFor("verified")).toBeUndefined()
  })
  test("unknown family ⇒ NO comparison (degrade, never crash)", () => {
    expect(externalCoordFor("")).toBeUndefined()
    expect(externalCoordFor("weird")).toBeUndefined()
  })
  test("pro ⇒ pro/public-731", () => {
    expect(externalCoordFor("pro")).toEqual({ dataset: "pro", sets: ["public-731"] })
  })
  test("live ⇒ live, verified-then-lite fallback order", () => {
    expect(externalCoordFor("live")).toEqual({ dataset: "live", sets: ["verified", "lite"] })
  })
})

describe("externalSotaFor — top external model for a family", () => {
  test("live picks the TOP verified rate (AMI+Claude 63%, not Live-lo 20%)", () => {
    const top = externalSotaFor("live", baselines)!
    expect(top.name).toBe("AMI+Claude")
    expect(top.set).toBe("verified")
    expect(top.rate).toBeCloseTo(0.63)
  })

  test("live falls back to lite when verified is absent", () => {
    const liteOnly = buildExternalBaselines(
      JSON.stringify({ name: "Lite-X", set: "lite", total: 300, resolved: 150 }),
      "src",
    )
    const top = externalSotaFor("live", liteOnly)!
    expect(top.name).toBe("Lite-X")
    expect(top.set).toBe("lite")
  })

  test("pro picks the curated public-731 SOTA (>=59%)", () => {
    const top = externalSotaFor("pro", baselines)!
    expect(top.set).toBe("public-731")
    expect(top.rate).toBeGreaterThanOrEqual(0.59)
  })

  test("verified ⇒ undefined (no comparison)", () => {
    expect(externalSotaFor("verified", baselines)).toBeUndefined()
  })

  test("absent baselines ⇒ undefined (graceful degrade, file may be missing)", () => {
    expect(externalSotaFor("pro", null)).toBeUndefined()
    expect(externalSotaFor("pro", undefined)).toBeUndefined()
  })
})

describe("externalSotaLabel — structured ours-vs-ext label", () => {
  test("live ⇒ {oursPct, extPct, extModel, set} with rounded percents", () => {
    const label = externalSotaLabel("live", 1, 5, baselines)!
    expect(label.oursPct).toBe(20) // 1/5
    expect(label.extPct).toBe(63) // AMI+Claude
    expect(label.extModel).toBe("AMI+Claude")
    expect(label.set).toBe("verified")
  })

  test("ourTotal 0 ⇒ oursPct 0 (no divide-by-zero)", () => {
    const label = externalSotaLabel("pro", 0, 0, baselines)!
    expect(label.oursPct).toBe(0)
    expect(label.extPct).toBeGreaterThanOrEqual(59)
  })

  test("verified ⇒ null (caller renders nothing → byte-identical)", () => {
    expect(externalSotaLabel("verified", 3, 5, baselines)).toBeNull()
  })

  test("no external match / absent baselines ⇒ null (caller shows —)", () => {
    expect(externalSotaLabel("pro", 1, 5, null)).toBeNull()
    expect(externalSotaLabel("live", 1, 5, buildExternalBaselines("", "src"))).toBeNull()
  })

  test("the label fields are RAW external strings (model name carries through verbatim for the caller to esc)", () => {
    const hostile = buildExternalBaselines(
      JSON.stringify({
        name: "</script><b>x",
        set: "verified",
        total: 10,
        resolved: 9,
      }),
      "src",
    )
    const label = externalSotaLabel("live", 1, 2, hostile)!
    // The helper does NOT escape — that is the render layer's job. Prove it passes the
    // raw string through so the server.ts esc() boundary is the single XSS chokepoint.
    expect(label.extModel).toBe("</script><b>x")
  })
})
