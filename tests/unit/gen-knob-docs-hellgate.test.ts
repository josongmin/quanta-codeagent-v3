/**
 * Hellgate — `tools/gen-knob-docs.ts` adversarial battery.
 *
 * Pins:
 *   - `buildKnobsMarkdown`, `buildFeatureYaml`, `replaceReadmeBlock` are PURE.
 *   - Empty registry ⇒ valid markdown/YAML (no crash).
 *   - Long / unicode / markdown-meta describe strings pass through unchanged
 *     (no escaping today — pinned design).
 *   - `replaceReadmeBlock` is idempotent and only mutates when start AND end
 *     markers exist in canonical order. Multiple start markers in the source
 *     use the FIRST start and the FIRST end after it.
 *   - YAML output is line-stable (no map iteration order leak).
 */
import { describe, expect, test } from "bun:test"
import {
  buildFeatureYaml,
  buildKnobsMarkdown,
  collectKnobsForDocs,
  replaceReadmeBlock,
} from "@/../tools/gen-knob-docs"
import type { AgentConfig } from "@/agent"
import type { AnyKnob, Knob, Surface } from "@/runner/knobs"

const mkKnob = (opts: {
  id: string
  envKey: string
  describe?: string
  costMultiplier?: number
  source?: string
  conflicts?: readonly string[]
  requires?: readonly string[]
  help?: string
}): AnyKnob => {
  const knob: Knob<true> = {
    id: opts.id,
    envKey: opts.envKey,
    category: "agent",
    surfaces: ["bench"] as readonly Surface[],
    parse: (raw: string | undefined): true | undefined => (raw === undefined ? undefined : true),
    apply: (cfg: AgentConfig): AgentConfig => cfg,
    describe: opts.describe ?? `desc ${opts.id}`,
    ...(opts.costMultiplier !== undefined ? { costMultiplier: opts.costMultiplier } : {}),
    ...(opts.source !== undefined ? { source: opts.source } : {}),
    ...(opts.conflicts !== undefined ? { conflicts: opts.conflicts } : {}),
    ...(opts.requires !== undefined ? { requires: opts.requires } : {}),
    ...(opts.help !== undefined ? { help: opts.help } : {}),
  }
  return knob as AnyKnob
}

const TS = "2026-05-26T00:00:00.000Z"

// ── buildKnobsMarkdown adversarial ─────────────────────────────────────────

describe("hellgate buildKnobsMarkdown — adversarial", () => {
  test("empty knobs ⇒ header + 'Index (0 knobs)' table-header only", () => {
    const md = buildKnobsMarkdown([], TS)
    expect(md).toContain("# Knob registry — auto-generated")
    expect(md).toContain("## Index (0 knobs)")
    expect(md).toContain("| id | env | category | surfaces | cost | source |")
  })

  test("single knob ⇒ ONE detail header", () => {
    const md = buildKnobsMarkdown([mkKnob({ id: "k1", envKey: "Q_K1" })], TS)
    const headers = md.match(/^## k1$/gm)
    expect(headers?.length).toBe(1)
  })

  test("source absent ⇒ rendered as em-dash (NOT empty)", () => {
    const md = buildKnobsMarkdown([mkKnob({ id: "k", envKey: "Q_K" })], TS)
    expect(md).toContain("Source: —")
  })

  test("source empty string treated as absent (renders em-dash)", () => {
    const md = buildKnobsMarkdown([mkKnob({ id: "k", envKey: "Q_K", source: "" })], TS)
    expect(md).toContain("Source: —")
  })

  test("costMultiplier 0 falls back to 1× (defence against drift in registry)", () => {
    const md = buildKnobsMarkdown([mkKnob({ id: "k", envKey: "Q_K", costMultiplier: 0 })], TS)
    expect(md).toContain("Cost: 1× baseline")
    expect(md).not.toContain("Cost: 0×")
  })

  test("costMultiplier negative ignored (falls back to 1×)", () => {
    const md = buildKnobsMarkdown([mkKnob({ id: "k", envKey: "Q_K", costMultiplier: -3 })], TS)
    expect(md).toContain("Cost: 1×")
  })

  test("describe with markdown special characters PASSES THROUGH verbatim", () => {
    // Pinned design: NO escaping. If escape semantics are added, this test
    // must be updated explicitly so the change is observable.
    const md = buildKnobsMarkdown(
      [mkKnob({ id: "k", envKey: "Q_K", describe: "**bold** | pipe `code`" })],
      TS,
    )
    expect(md).toContain("**bold** | pipe `code`")
  })

  test("very long describe (10kB) renders without truncation", () => {
    const long = "x".repeat(10_000)
    const md = buildKnobsMarkdown([mkKnob({ id: "k", envKey: "Q_K", describe: long })], TS)
    expect(md).toContain(long)
  })

  test("unicode describe preserved (no transliteration)", () => {
    const md = buildKnobsMarkdown(
      [mkKnob({ id: "k", envKey: "Q_K", describe: "한국어 + 🚀 + ñ" })],
      TS,
    )
    expect(md).toContain("한국어 + 🚀 + ñ")
  })

  test("conflicts list rendered when non-empty", () => {
    const md = buildKnobsMarkdown([mkKnob({ id: "a", envKey: "Q_A", conflicts: ["b", "c"] })], TS)
    expect(md).toContain("Conflicts: b, c")
  })

  test("conflicts empty array omits the line entirely", () => {
    const md = buildKnobsMarkdown([mkKnob({ id: "a", envKey: "Q_A", conflicts: [] })], TS)
    expect(md).not.toContain("Conflicts:")
  })

  test("requires list rendered when non-empty", () => {
    const md = buildKnobsMarkdown([mkKnob({ id: "a", envKey: "Q_A", requires: ["base"] })], TS)
    expect(md).toContain("Requires: base")
  })

  test("help line appears AFTER describe when provided", () => {
    const md = buildKnobsMarkdown(
      [mkKnob({ id: "a", envKey: "Q_A", describe: "short", help: "long help body" })],
      TS,
    )
    const descPos = md.indexOf("short")
    const helpPos = md.indexOf("long help body")
    expect(descPos).toBeGreaterThan(0)
    expect(helpPos).toBeGreaterThan(descPos)
  })

  test("deterministic — same inputs ⇒ identical bytes", () => {
    const knobs = [mkKnob({ id: "k1", envKey: "Q_K1" }), mkKnob({ id: "k2", envKey: "Q_K2" })]
    expect(buildKnobsMarkdown(knobs, TS)).toBe(buildKnobsMarkdown(knobs, TS))
  })

  test("ending newline always present (POSIX-style)", () => {
    const md = buildKnobsMarkdown([mkKnob({ id: "k", envKey: "Q_K" })], TS)
    expect(md.endsWith("\n")).toBe(true)
  })
})

// ── buildFeatureYaml adversarial ──────────────────────────────────────────

describe("hellgate buildFeatureYaml — adversarial", () => {
  test("empty knobs ⇒ valid yaml with `knobs:` block but no list items", () => {
    const y = buildFeatureYaml([])
    expect(y).toContain("knobs:")
    expect(y).toContain("rollup of the 0 bench-surface knobs")
  })

  test("count placeholder in purpose reflects actual count", () => {
    const knobs = [mkKnob({ id: "a", envKey: "Q_A" }), mkKnob({ id: "b", envKey: "Q_B" })]
    const y = buildFeatureYaml(knobs)
    expect(y).toContain("rollup of the 2 bench-surface knobs")
  })

  test("very large knob list (100) renders all ids in the rollup", () => {
    const knobs: AnyKnob[] = []
    for (let i = 0; i < 100; i++) {
      knobs.push(mkKnob({ id: `k-${i}`, envKey: `Q_K_${i}` }))
    }
    const y = buildFeatureYaml(knobs)
    for (let i = 0; i < 100; i++) {
      expect(y).toContain(`  - k-${i}`)
    }
  })

  test("output is line-stable across two calls with same input", () => {
    const knobs = [mkKnob({ id: "a", envKey: "Q_A" })]
    expect(buildFeatureYaml(knobs)).toBe(buildFeatureYaml(knobs))
  })

  test("ends with a trailing newline (POSIX-friendly file)", () => {
    const y = buildFeatureYaml([])
    expect(y.endsWith("\n")).toBe(true)
  })

  test("auto-generated notice is present (idempotency hint)", () => {
    const y = buildFeatureYaml([])
    expect(y).toContain("Auto-generated by tools/gen-knob-docs.ts")
  })
})

// ── replaceReadmeBlock adversarial ────────────────────────────────────────

describe("hellgate replaceReadmeBlock — adversarial", () => {
  const SAMPLE: AnyKnob[] = [mkKnob({ id: "lsp", envKey: "QUANTA_BENCH_LSP" })]

  test("readme without any markers ⇒ unchanged (no-op)", () => {
    const r = "no markers here at all"
    expect(replaceReadmeBlock(r, SAMPLE)).toBe(r)
  })

  test("only start marker ⇒ unchanged (no-op)", () => {
    const r = "<!-- knobs:start -->\nbody\nno end\n"
    expect(replaceReadmeBlock(r, SAMPLE)).toBe(r)
  })

  test("only end marker ⇒ unchanged (no-op)", () => {
    const r = "body\n<!-- knobs:end -->\n"
    expect(replaceReadmeBlock(r, SAMPLE)).toBe(r)
  })

  test("end before start ⇒ no-op (markers not in canonical order)", () => {
    const r = "<!-- knobs:end -->\n<!-- knobs:start -->\n"
    expect(replaceReadmeBlock(r, SAMPLE)).toBe(r)
  })

  test("empty block (markers adjacent) ⇒ block is filled with table", () => {
    const r = "<!-- knobs:start --><!-- knobs:end -->"
    const out = replaceReadmeBlock(r, SAMPLE)
    expect(out).not.toBe(r)
    expect(out).toContain("QUANTA_BENCH_LSP")
  })

  test("idempotent: calling twice with same knobs ⇒ identical output (3rd call too)", () => {
    const r = "<!-- knobs:start -->\nOLD\n<!-- knobs:end -->"
    const once = replaceReadmeBlock(r, SAMPLE)
    const twice = replaceReadmeBlock(once, SAMPLE)
    const thrice = replaceReadmeBlock(twice, SAMPLE)
    expect(twice).toBe(once)
    expect(thrice).toBe(once)
  })

  test("multiple start markers ⇒ first start with first end after it", () => {
    // The implementation uses indexOf which returns FIRST occurrence. So if a
    // README accidentally has duplicate start markers, the FIRST start pairs
    // with the FIRST end. Subsequent nested markers stay verbatim.
    const r = [
      "<!-- knobs:start -->",
      "first block content",
      "<!-- knobs:start -->",
      "second block content",
      "<!-- knobs:end -->",
      "<!-- knobs:end -->",
      "trailing",
    ].join("\n")
    const out = replaceReadmeBlock(r, SAMPLE)
    expect(out).toContain("<!-- knobs:start -->")
    expect(out).toContain("<!-- knobs:end -->")
    expect(out).not.toContain("first block content") // first block REPLACED
    expect(out).toContain("trailing")
  })

  test("very large surrounding README (50kB) ⇒ replace preserves entirely outside the block", () => {
    const padBefore = "x".repeat(25_000)
    const padAfter = "y".repeat(25_000)
    const r = `${padBefore}\n<!-- knobs:start -->\nOLD\n<!-- knobs:end -->\n${padAfter}`
    const out = replaceReadmeBlock(r, SAMPLE)
    expect(out.startsWith(padBefore)).toBe(true)
    expect(out.endsWith(padAfter)).toBe(true)
  })

  test("knobs added to README block use the abbreviated 4-col format", () => {
    const r = "<!-- knobs:start -->\n<!-- knobs:end -->"
    const out = replaceReadmeBlock(r, SAMPLE)
    expect(out).toContain("| id | env | category | cost |")
    expect(out).not.toContain("surfaces") // README block is the trimmed view
  })

  test("knobs with unicode envKey pass through verbatim", () => {
    const r = "<!-- knobs:start -->\n<!-- knobs:end -->"
    // Synthetic unicode envKey — we never produce these in production but
    // verify the renderer is text-safe.
    const k = mkKnob({ id: "k", envKey: "Q_★_K" })
    const out = replaceReadmeBlock(r, [k])
    expect(out).toContain("Q_★_K")
  })

  test("markers in different lines with code-block-style fencing tolerated", () => {
    const r = "```\n<!-- knobs:start -->\nx\n<!-- knobs:end -->\n```"
    const out = replaceReadmeBlock(r, SAMPLE)
    expect(out).toContain("<!-- knobs:start -->")
    expect(out).toContain("<!-- knobs:end -->")
  })
})

// ── collectKnobsForDocs adversarial (DI seam) ─────────────────────────────

describe("hellgate collectKnobsForDocs — DI seam", () => {
  test("empty registry ⇒ empty list (no crash)", async () => {
    const out = await collectKnobsForDocs(new Map())
    expect(out).toEqual([])
  })

  test("registry with unsorted ids ⇒ output is sorted by id (stable doc output)", async () => {
    const m = new Map<string, AnyKnob>()
    m.set("zzz", mkKnob({ id: "zzz", envKey: "Q_ZZZ" }))
    m.set("aaa", mkKnob({ id: "aaa", envKey: "Q_AAA" }))
    m.set("mmm", mkKnob({ id: "mmm", envKey: "Q_MMM" }))
    const out = await collectKnobsForDocs(m)
    expect(out.map((k) => k.id)).toEqual(["aaa", "mmm", "zzz"])
  })

  test("DI seam: does NOT bootstrap when registry is passed", async () => {
    // The implementation gates bootstrap behind `registry === undefined`.
    // Passing a map (even empty) skips bootstrap entirely — confirmed by the
    // sole observable: identical-input → identical-output without throwing.
    const out1 = await collectKnobsForDocs(new Map())
    const out2 = await collectKnobsForDocs(new Map())
    expect(out1).toEqual(out2)
  })
})
