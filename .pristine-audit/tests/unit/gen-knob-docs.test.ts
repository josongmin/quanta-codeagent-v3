/**
 * Unit tests for `tools/gen-knob-docs.ts` — pure builders + idempotent
 * README marker block.
 *
 * Test isolation: builds a HAND-MADE registry map and passes it to
 * `collectKnobsForDocs` (which accepts an optional registry DI seam).
 * This avoids touching the global knob registry — fragile under hellgate-
 * style suites that reset between tests.
 */
import { beforeAll, describe, expect, test } from "bun:test"
import {
  buildFeatureYaml,
  buildKnobsMarkdown,
  collectKnobsForDocs,
  replaceReadmeBlock,
} from "@/../tools/gen-knob-docs"
import type { AgentConfig } from "@/agent"
import type { AnyKnob, Knob, KnobCategory, Surface } from "@/runner/knobs"

/** Build a synthetic knob — same shape as the real ones. */
const mkKnob = (opts: {
  id: string
  envKey: string
  category?: KnobCategory
  surfaces?: readonly Surface[]
  costMultiplier?: number
  source?: string
  describe?: string
  conflicts?: readonly string[]
  requires?: readonly string[]
  help?: string
}): AnyKnob => {
  const knob: Knob<true> = {
    id: opts.id,
    envKey: opts.envKey,
    category: opts.category ?? "agent",
    surfaces: opts.surfaces ?? (["bench"] as readonly Surface[]),
    parse: (raw: string | undefined): true | undefined => (raw === undefined ? undefined : true),
    apply: (cfg: AgentConfig): AgentConfig => cfg,
    describe: opts.describe ?? `test knob ${opts.id}`,
    ...(opts.costMultiplier !== undefined ? { costMultiplier: opts.costMultiplier } : {}),
    ...(opts.source !== undefined ? { source: opts.source } : {}),
    ...(opts.conflicts !== undefined ? { conflicts: opts.conflicts } : {}),
    ...(opts.requires !== undefined ? { requires: opts.requires } : {}),
    ...(opts.help !== undefined ? { help: opts.help } : {}),
  }
  return knob as AnyKnob
}

/** Mirror the 12 framework knobs (same ids + envKeys + costMultipliers) so
 *  the docs builders' output is verifiably stable. */
const mockRegistry = (): ReadonlyMap<string, AnyKnob> => {
  const m = new Map<string, AnyKnob>()
  const add = (k: AnyKnob): void => {
    m.set(k.id, k)
  }
  add(
    mkKnob({
      id: "branch-search",
      envKey: "QUANTA_BENCH_BRANCH_SEARCH",
      costMultiplier: 8,
      source: "ADR-0084",
    }),
  )
  add(mkKnob({ id: "closeout-guard", envKey: "QUANTA_CLOSEOUT_GUARD", source: "ADR-0017" }))
  add(mkKnob({ id: "hooks", envKey: "QUANTA_BENCH_HOOKS", source: "Cursor hooks" }))
  add(
    mkKnob({
      id: "issue-hint",
      envKey: "QUANTA_BENCH_ISSUE_HINT",
      category: "hint",
      source: "Agentless paper",
    }),
  )
  add(
    mkKnob({
      id: "localize-phase",
      envKey: "QUANTA_BENCH_LOCALIZE_PHASE",
      conflicts: ["branch-search"],
      source: "Agentless absorption",
    }),
  )
  add(
    mkKnob({
      id: "lsp",
      envKey: "QUANTA_BENCH_LSP",
      category: "tool",
      costMultiplier: 1,
      source: "ADR-0015",
    }),
  )
  add(
    mkKnob({
      id: "must-pass",
      envKey: "QUANTA_BENCH_MUST_PASS",
      category: "verify",
      source: "RCA sanity",
    }),
  )
  add(
    mkKnob({
      id: "persona",
      envKey: "QUANTA_PERSONA",
      category: "hint",
      source: "ADR-0068",
    }),
  )
  add(
    mkKnob({
      id: "repro-test",
      envKey: "QUANTA_BENCH_REPRO_TEST",
      category: "validation",
      costMultiplier: 40,
      source: "Agentless §3.3.1",
    }),
  )
  add(mkKnob({ id: "skills", envKey: "QUANTA_BENCH_SKILLS", source: "ADR-0045" }))
  add(mkKnob({ id: "subagent", envKey: "QUANTA_BENCH_SUBAGENT", source: "Codex absorption" }))
  add(
    mkKnob({
      id: "working-state",
      envKey: "QUANTA_BENCH_WORKING_STATE",
      source: "Codex absorption",
    }),
  )
  return m
}

let knobs: readonly AnyKnob[] = []
beforeAll(async () => {
  knobs = await collectKnobsForDocs(mockRegistry())
})

describe("collectKnobsForDocs", () => {
  test("returns a non-empty list (12 framework knobs from mock)", () => {
    expect(knobs.length).toBe(12)
    const ids = knobs.map((k) => k.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("entries are sorted by id (stable doc output)", () => {
    const ids = knobs.map((k) => k.id)
    const sorted = [...ids].sort((a, b) => a.localeCompare(b))
    expect(ids).toEqual(sorted)
  })
})

describe("buildKnobsMarkdown", () => {
  test("starts with a header + generated timestamp", () => {
    const md = buildKnobsMarkdown(knobs, "2026-05-26T00:00:00.000Z")
    expect(md.startsWith("# Knob registry — auto-generated\n")).toBe(true)
    expect(md).toContain("Generated: 2026-05-26T00:00:00.000Z")
    expect(md).toContain("Run: `bun run tools/gen-knob-docs.ts`")
  })

  test("index section has a table header + separator + N data rows", () => {
    const md = buildKnobsMarkdown(knobs, "2026-05-26T00:00:00.000Z")
    expect(md).toContain(`## Index (${knobs.length} knobs)`)
    expect(md).toContain("| id | env | category | surfaces | cost | source |")
    expect(md).toContain("|---|---|---|---|---|---|")
    for (const k of knobs) {
      expect(md).toContain(`\`${k.id}\``)
      expect(md).toContain(`\`${k.envKey}\``)
    }
  })

  test("detail section appears once per knob — `## <id>` headers", () => {
    const md = buildKnobsMarkdown(knobs, "2026-05-26T00:00:00.000Z")
    for (const k of knobs) {
      expect(md).toContain(`## ${k.id}`)
      expect(md).toContain(`ENV: \`${k.envKey}\``)
    }
  })

  test("conflict knobs render a Conflicts: line in their detail block", () => {
    const md = buildKnobsMarkdown(knobs, "2026-05-26T00:00:00.000Z")
    expect(md).toMatch(/Conflicts: branch-search/)
  })

  test("cost defaults to 1× when absent; explicit costMultiplier appears verbatim", () => {
    const md = buildKnobsMarkdown(knobs, "2026-05-26T00:00:00.000Z")
    expect(md).toContain("Cost: 8× baseline")
    expect(md).toContain("Cost: 1× baseline")
  })

  test("deterministic — same input ⇒ identical output (idempotency contract)", () => {
    const md1 = buildKnobsMarkdown(knobs, "2026-05-26T00:00:00.000Z")
    const md2 = buildKnobsMarkdown(knobs, "2026-05-26T00:00:00.000Z")
    expect(md1).toBe(md2)
  })

  test("changing the timestamp changes ONLY the Generated line", () => {
    const md1 = buildKnobsMarkdown(knobs, "2026-05-26T00:00:00.000Z")
    const md3 = buildKnobsMarkdown(knobs, "2099-01-01T00:00:00.000Z")
    expect(md3).not.toBe(md1)
    expect(md3).toContain("Generated: 2099-01-01T00:00:00.000Z")
    const body1 = md1.slice(md1.indexOf("## Index"))
    const body3 = md3.slice(md3.indexOf("## Index"))
    expect(body1).toBe(body3)
  })
})

describe("buildFeatureYaml", () => {
  test("starts with id, title, section pinned by the brief", () => {
    const yaml = buildFeatureYaml(knobs)
    expect(yaml).toContain("id: bench-knobs")
    expect(yaml).toMatch(/^id: bench-knobs/m)
    expect(yaml).toContain("section: 2")
    expect(yaml).toContain("status: stable")
    expect(yaml).toContain("maturity: L4")
  })

  test("evidence.code points at the framework slice", () => {
    const yaml = buildFeatureYaml(knobs)
    expect(yaml).toContain("src/runner/knobs/registry.ts")
    expect(yaml).toContain("src/runner/knobs/knobs")
  })

  test("knobs block lists every id (rollup)", () => {
    const yaml = buildFeatureYaml(knobs)
    expect(yaml).toContain("knobs:")
    for (const k of knobs) {
      expect(yaml).toContain(`  - ${k.id}`)
    }
  })

  test("tests.unit points at the framework's per-knob test dir", () => {
    const yaml = buildFeatureYaml(knobs)
    expect(yaml).toContain("unit: [tests/unit/runner/knobs/]")
  })

  test("auto-generated notice at the bottom (idempotency hint)", () => {
    const yaml = buildFeatureYaml(knobs)
    expect(yaml).toContain("Auto-generated by tools/gen-knob-docs.ts")
  })

  test("deterministic — same input ⇒ identical YAML", () => {
    const yaml1 = buildFeatureYaml(knobs)
    const yaml2 = buildFeatureYaml(knobs)
    expect(yaml1).toBe(yaml2)
  })
})

describe("replaceReadmeBlock", () => {
  test("README without markers ⇒ no-op (input returned unchanged)", () => {
    const readme = "# My Project\n\nNo markers here.\n"
    expect(replaceReadmeBlock(readme, knobs)).toBe(readme)
  })

  test("README with markers ⇒ block replaced with knob index table", () => {
    const before =
      "# My Project\n\nstart prose\n\n<!-- knobs:start -->\nOLD CONTENT\n<!-- knobs:end -->\n\nfooter\n"
    const after = replaceReadmeBlock(before, knobs)
    expect(after).not.toBe(before)
    expect(after).toContain("<!-- knobs:start -->")
    expect(after).toContain("<!-- knobs:end -->")
    expect(after).not.toContain("OLD CONTENT")
    expect(after).toContain("| id | env | category | cost |")
    expect(after).toContain("QUANTA_BENCH_LSP")
  })

  test("idempotent — running twice produces the same body", () => {
    const before = "<!-- knobs:start -->\n<!-- knobs:end -->\n"
    const once = replaceReadmeBlock(before, knobs)
    const twice = replaceReadmeBlock(once, knobs)
    expect(twice).toBe(once)
  })

  test("malformed marker order (end before start) ⇒ no-op", () => {
    const malformed = "<!-- knobs:end -->\n<!-- knobs:start -->\n"
    expect(replaceReadmeBlock(malformed, knobs)).toBe(malformed)
  })

  test("only-start marker (no end) ⇒ no-op", () => {
    const oneSided = "<!-- knobs:start -->\nbody\n"
    expect(replaceReadmeBlock(oneSided, knobs)).toBe(oneSided)
  })

  test("only-end marker (no start) ⇒ no-op", () => {
    const oneSided = "body\n<!-- knobs:end -->\n"
    expect(replaceReadmeBlock(oneSided, knobs)).toBe(oneSided)
  })
})
