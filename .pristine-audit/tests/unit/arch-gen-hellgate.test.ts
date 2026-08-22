/**
 * Hellgate for `tools/arch-gen` — ADR walker, slice scanner, renderer.
 *
 * Each block (A/B/C) seals a closed invariant of the auto-generator. We use
 * a tmpdir so the suite is hermetic — no dependency on the real
 * docs/decisions/ / src/ tree.
 *
 * Sibling of ADR-0190 (architecture generator).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs, runGenerator } from "../../tools/arch-gen/main"
import { render } from "../../tools/arch-gen/render"
import { parseAdr, scanAdrs } from "../../tools/arch-gen/scan-adrs"
import {
  extractAdrReferences,
  extractExports,
  extractPurpose,
  scanSlices,
} from "../../tools/arch-gen/scan-slices"

let ROOT: string

beforeAll(async () => {
  ROOT = await mkdtemp(join(tmpdir(), "arch-gen-hellgate-"))
})

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true })
})

// ─────────────────────────────────────────────────────────────────────────────
// A. scanAdrs — 5 cases
// ─────────────────────────────────────────────────────────────────────────────

describe("A. scanAdrs", () => {
  test("[A-1] single ADR parsed: number, title, date, status", () => {
    const text = [
      "# ADR-0042: Hexagonal port for foo",
      "",
      "- **상태**: Accepted",
      "- **날짜**: 2026-05-24",
      "",
      "## body",
    ].join("\n")
    const r = parseAdr("0042-hex-foo.md", text)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.adr.number).toBe("0042")
      expect(r.adr.title).toBe("Hexagonal port for foo")
      expect(r.adr.date).toBe("2026-05-24")
      expect(r.adr.status).toBe("Accepted")
    }
  })

  test("[A-2] related ADRs extracted from `**관련**:` line", () => {
    const text = [
      "# ADR-0100: Some thing",
      "- **상태**: Accepted",
      "- **날짜**: 2026-05-25",
      "- **관련**: ADR-0042 (parent), ADR-0050 (sibling), ADR-0042 (dup)",
    ].join("\n")
    const r = parseAdr("0100-some.md", text)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.adr.related).toEqual(["0042", "0050"])
    }
  })

  test("[A-3] status detection: Accepted / Proposed / Superseded", () => {
    for (const status of ["Accepted", "Proposed", "Superseded"]) {
      const text = `# ADR-0010: Title\n- **Status**: ${status}\n- **Date**: 2026-05-24\n`
      const r = parseAdr("0010-x.md", text)
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.adr.status).toBe(status)
    }
  })

  test("[A-4] Korean `**날짜**:` AND English `**Date**:` both supported", () => {
    const kr = "# ADR-0001: A\n- **상태**: Accepted\n- **날짜**: 2026-05-24\n"
    const en = "# ADR-0002: B\n- **Status**: Accepted\n- **Date**: 2026-05-25\n"
    const a = parseAdr("0001.md", kr)
    const b = parseAdr("0002.md", en)
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    if (a.ok && b.ok) {
      expect(a.adr.date).toBe("2026-05-24")
      expect(b.adr.date).toBe("2026-05-25")
    }
  })

  test("[A-5] malformed ADR → diagnostic + skip (not crash)", async () => {
    const dir = join(ROOT, "adrs-a5")
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "0001-good.md"), "# ADR-0001: Good\n- **상태**: Accepted\n")
    await writeFile(join(dir, "0002-bad.md"), "missing the title header entirely\n")
    await writeFile(join(dir, "README.md"), "should be ignored")
    await writeFile(join(dir, "0003-no-title.md"), "## not the right level\n")
    const r = await scanAdrs(dir)
    expect(r.adrs.length).toBe(1)
    expect(r.adrs[0]?.number).toBe("0001")
    expect(r.skipped.length).toBe(2)
    expect(r.skipped.some((s) => s.filename === "0002-bad.md")).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// B. scanSlices — 5 cases
// ─────────────────────────────────────────────────────────────────────────────

describe("B. scanSlices", () => {
  test("[B-6] single slice index.ts → purpose, exports, ADR refs extracted", async () => {
    const root = join(ROOT, "b6")
    const text = [
      "/**",
      " * Slice for the foo subsystem (ADR-0042, ADR-0050).",
      " * Provides typed ports.",
      " */",
      'export { Foo } from "./foo"',
      'export type { FooOpts } from "./types"',
    ].join("\n")
    await mkdir(join(root, "src/foo"), { recursive: true })
    await mkdir(join(root, "tests"), { recursive: true })
    await writeFile(join(root, "src/foo/index.ts"), text)
    const slices = await scanSlices({
      rootSrc: join(root, "src"),
      testsDir: join(root, "tests"),
    })
    expect(slices.length).toBe(1)
    const s = slices[0]
    expect(s?.slicePath).toBe("src/foo")
    expect(s?.purpose).toContain("foo subsystem")
    expect(s?.publicExports).toContain("Foo")
    expect(s?.publicExports).toContain("FooOpts")
    expect(s?.adrReferences).toEqual(["0042", "0050"])
  })

  test("[B-7] slice without doc-comment → purpose='(no description)'", async () => {
    const root = join(ROOT, "b7")
    await mkdir(join(root, "src/bare"), { recursive: true })
    await writeFile(join(root, "src/bare/index.ts"), "export const X = 1\n")
    const slices = await scanSlices({ rootSrc: join(root, "src"), testsDir: join(root, "tests") })
    expect(slices.length).toBe(1)
    expect(slices[0]?.purpose).toBe("(no description)")
  })

  test("[B-8] slice with matching test file → testFile populated", async () => {
    const root = join(ROOT, "b8")
    await mkdir(join(root, "src/widget"), { recursive: true })
    await mkdir(join(root, "tests-unit"), { recursive: true })
    await writeFile(join(root, "src/widget/index.ts"), "export const Z = 1\n")
    await writeFile(join(root, "tests-unit/widget-hellgate.test.ts"), "// test")
    await writeFile(join(root, "tests-unit/widget-foo-hellgate.test.ts"), "// other")
    const slices = await scanSlices({
      rootSrc: join(root, "src"),
      testsDir: join(root, "tests-unit"),
    })
    expect(slices.length).toBe(1)
    expect(slices[0]?.testFile).toBeTruthy()
    expect(slices[0]?.testFile).toContain("widget")
    expect(slices[0]?.testFile).toContain("hellgate.test.ts")
  })

  test("[B-9] slice without index.ts → skipped", async () => {
    const root = join(ROOT, "b9")
    await mkdir(join(root, "src/withbarrel"), { recursive: true })
    await mkdir(join(root, "src/nobarrel"), { recursive: true })
    await writeFile(join(root, "src/withbarrel/index.ts"), "export const A = 1\n")
    await writeFile(join(root, "src/nobarrel/other.ts"), "export const B = 1\n")
    const slices = await scanSlices({ rootSrc: join(root, "src"), testsDir: join(root, "tests") })
    expect(slices.length).toBe(1)
    expect(slices[0]?.slicePath).toBe("src/withbarrel")
  })

  test("[B-10] multi-export barrel → all exports captured", () => {
    const text = [
      "/** Multi barrel. */",
      'export { A, B as C } from "./a"',
      'export type { D, E } from "./d"',
      "export const F = 1",
      "export function G() {}",
      "export class H {}",
      'export * as ns from "./ns"',
    ].join("\n")
    const exports = extractExports(text)
    for (const name of ["A", "C", "D", "E", "F", "G", "H", "ns"]) {
      expect(exports).toContain(name)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C. render — 5 cases
// ─────────────────────────────────────────────────────────────────────────────

describe("C. render", () => {
  test("[C-11] empty inputs → minimal template", () => {
    const md = render([], [], { today: "2026-05-25" })
    expect(md).toContain("# Quanta — Architecture (Generated)")
    expect(md).toContain("Slices (0 total)")
    expect(md).toContain("ADR catalogue by plane (0 entries")
    expect(md).toContain("Dependency Graph")
    expect(md).toContain("Catalog parity")
  })

  test("[C-12] ADR list sorted by number within a plane", () => {
    const md = render(
      [
        {
          number: "0050",
          title: "B port",
          date: "2026-05-24",
          status: "Accepted",
          related: [],
          slicePaths: [],
          plane: "domain",
          filename: "0050-b.md",
        },
        {
          number: "0010",
          title: "A port",
          date: "2026-05-23",
          status: "Accepted",
          related: [],
          slicePaths: [],
          plane: "domain",
          filename: "0010-a.md",
        },
      ],
      [],
      { today: "2026-05-25" },
    )
    const idx0010 = md.indexOf("ADR-0010")
    const idx0050 = md.indexOf("ADR-0050")
    expect(idx0010).toBeGreaterThan(-1)
    expect(idx0050).toBeGreaterThan(-1)
    expect(idx0010).toBeLessThan(idx0050)
  })

  test("[C-13] plane clustering: title 'metric/telemetry' → observability (heuristic + render integration)", () => {
    // Seal both edges: parseAdr's keyword heuristic AND render's grouping.
    const text =
      "# ADR-0301: Wired-gauge metric for skill\n- **상태**: Accepted\n- **날짜**: 2026-05-20\n"
    const parsed = parseAdr("0301-x.md", text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.adr.plane).toBe("observability")
    const md = render([parsed.adr], [], { today: "2026-05-25" })
    const obsHeader = md.indexOf("### Observability / Telemetry")
    expect(obsHeader).toBeGreaterThan(-1)
    const adrLine = md.indexOf("Wired-gauge metric for skill")
    expect(adrLine).toBeGreaterThan(obsHeader)
  })

  test("[C-14] ADR cross-references resolved (link to actual file)", () => {
    const md = render(
      [
        {
          number: "0099",
          title: "X",
          date: "2026-05-24",
          status: "Accepted",
          related: [],
          slicePaths: [],
          plane: "domain",
          filename: "0099-x.md",
        },
      ],
      [],
      { today: "2026-05-25" },
    )
    expect(md).toContain("[ADR-0099](./decisions/0099-x.md)")
  })

  test("[C-15] footer carries total counts incl. collisions", () => {
    const md = render(
      [
        {
          number: "0010",
          title: "A",
          date: "2026-05-24",
          status: "Accepted",
          related: [],
          slicePaths: [],
          plane: "domain",
          filename: "0010-a.md",
        },
        {
          number: "0010",
          title: "A dup",
          date: "2026-05-24",
          status: "Accepted",
          related: [],
          slicePaths: [],
          plane: "domain",
          filename: "0010-dup.md",
        },
      ],
      [
        {
          slicePath: "src/x",
          purpose: "p",
          publicExports: ["A"],
          adrReferences: [],
        },
      ],
      { today: "2026-05-25" },
    )
    expect(md).toContain("Total ADR files: 2")
    expect(md).toContain("Distinct ADR numbers: 1")
    expect(md).toContain("ADR collisions: 1")
    expect(md).toContain("Total slices: 1")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// D. CLI integration (bonus seals for main.ts)
// ─────────────────────────────────────────────────────────────────────────────

describe("D. main / CLI", () => {
  test("[D-16] parseArgs reads --output and --today", () => {
    const args = parseArgs([
      "--output",
      "x/y.md",
      "--today",
      "2026-05-25",
      "--docs",
      "d",
      "--src",
      "s",
      "--tests",
      "t",
    ])
    expect(args.output).toBe("x/y.md")
    expect(args.today).toBe("2026-05-25")
    expect(args.docsDir).toBe("d")
    expect(args.srcDir).toBe("s")
    expect(args.testsDir).toBe("t")
  })

  test("[D-17] runGenerator writes file with header + body", async () => {
    const root = join(ROOT, "d17")
    const docs = join(root, "adrs")
    const src = join(root, "src")
    const tests = join(root, "tests")
    await mkdir(docs, { recursive: true })
    await mkdir(join(src, "alpha"), { recursive: true })
    await mkdir(tests, { recursive: true })
    await writeFile(
      join(docs, "0001-a.md"),
      "# ADR-0001: First\n- **상태**: Accepted\n- **날짜**: 2026-05-24\n",
    )
    await writeFile(join(src, "alpha/index.ts"), "/** Alpha slice. */\nexport const ALPHA = 1\n")
    const out = join(root, "ARCH.generated.md")
    const r = await runGenerator({
      output: out,
      docsDir: docs,
      srcDir: src,
      testsDir: tests,
      today: "2026-05-25",
    })
    expect(r.adrCount).toBe(1)
    expect(r.sliceCount).toBe(1)
    expect(r.bytesWritten).toBeGreaterThan(100)
    // Reading back through node:fs to keep test pure.
    const { readFile } = await import("node:fs/promises")
    const body = await readFile(out, "utf8")
    expect(body).toContain("# Quanta — Architecture (Generated)")
    expect(body).toContain("ADR-0001")
    expect(body).toContain("`@/alpha`")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// E. Pure helpers — defensive coverage
// ─────────────────────────────────────────────────────────────────────────────

describe("E. helpers", () => {
  test("[E-18] extractPurpose handles `//`-only block when no `/** */`", () => {
    const text = "// First line.\n// Second line.\n\nexport const X = 1\n"
    expect(extractPurpose(text)).toContain("First line")
  })

  test("[E-19] extractAdrReferences scans only header zone, sorts unique", () => {
    const text = "/** ADR-0042 and ADR-0100 and ADR-0042. */\nexport const X = 1\n"
    expect(extractAdrReferences(text)).toEqual(["0042", "0100"])
  })
})
