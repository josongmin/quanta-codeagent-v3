/**
 * jun-30 T4 SSOT ratchet — the per-family backend behavior (parse / grade /
 * remote-env / on-box bootstrap / preflight / remote preset) must resolve from
 * the ONE `DatasetFamilyProfile` registry, NOT scattered raw `=== "pro"` /
 * `!== "pro"` / `=== "live"` family string-compares in CONSUMER modules. This is
 * the "adding a family touches one place" guard for T4 (ticket Stop rule).
 *
 * aug-22 MED-5 — WHY THIS WAS REWRITTEN. The previous version scanned exactly two
 * files (`run-main.ts`, `run-main-helpers.ts`) and its own header declared
 * `ec2-lifecycle.ts`, `dataset-preflight.ts` and `box-session.ts buildProEnv` to
 * be "SANCTIONED owners … NOT scanned" — i.e. it was scoped to exempt precisely
 * the three modules T4 says must stop string-comparing, so all of the surviving
 * debt was invisible to it. Its "red-on-injection" test only asserted that the
 * regex matched a string LITERAL; it never exercised the file scan, so a dead
 * walker (renamed file, broken path) would have passed silently.
 *
 * Now: the scan covers the WHOLE `src/apps/bench` tree (so moving an offending
 * branch one file sideways does not evade it), with exactly ONE exemption — the
 * registry itself, which is where family names are supposed to live — and every
 * other exemption must be an explicit {@link JUSTIFIED} entry carrying a reason.
 * Non-vacuity is proven against the REAL BYTES of each named consumer, not
 * against a hand-written literal.
 *
 * This is the SECONDARY rail. The primary, behavioral one is
 * `src/apps/bench/profiles/family-four-stop-rule.test.ts`, which registers a
 * synthetic family #4 and drives the real production entry point of every layer.
 */
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { stripComments } from "./_shared/strip-comments"

const REPO = join(import.meta.dir, "..", "..")
const BENCH_ROOT = join(REPO, "src", "apps", "bench")

/**
 * The ONE sanctioned owner: the profile registry is where family names ARE the
 * data (`DATASET_FAMILY_PROFILES` keys). Everything else is a consumer.
 * `dataset-family-token.ts` is NOT exempted — it lists the tokens, it does not
 * compare against them, so the scan must stay live over it.
 */
const SANCTIONED_OWNERS = new Set(["src/apps/bench/profiles/registry.ts"])

/**
 * Per-site exemptions. A consumer that genuinely must keep a family string needs
 * an entry here WITH A REASON — never a silent scope exclusion. Empty today: the
 * aug-22 HIGH-4 repair routed every remaining site (`buildProEnv`,
 * `assertProDatasetGradeable`, `isLiveRun`, `setupProHarnessIfNeeded`,
 * `resolveRemoteBenchExecutionPreset`, `localLiveGradeRefusal`) through the
 * profile. `staleJustifications` below keeps this map honest.
 */
const JUSTIFIED: ReadonlyArray<{
  readonly file: string
  /** Substring that must appear on the offending line for the exemption to apply. */
  readonly match: string
  readonly reason: string
}> = []

/**
 * Raw family string-compare detectors. Each must match a spelling a real author
 * would write — asserted non-vacuous below against the REAL bytes of the
 * consumers this repair fixed.
 */
/** The family tokens the detectors fire on. PMX-01 added `promax`; the quote
 *  anchors in each pattern mean `promax` must be listed EXPLICITLY (`"promax"`
 *  never matched `["']pro["']`), so a `family === "promax"` branch would have
 *  been invisible to this rail until it was added here. Longest-first so the
 *  alternation cannot prefix-match `pro` inside `promax`. */
const FAMILY_TOKEN_ALTERNATION = "verified|promax|live|pro"

const DETECTORS: ReadonlyArray<{ readonly name: string; readonly re: RegExp }> = [
  // `family === "pro"`, `x !== 'live'`, `(f ?? "").toLowerCase() === "live"`
  { name: "compare-rhs", re: new RegExp(`[!=]==\\s*["'](?:${FAMILY_TOKEN_ALTERNATION})["']`) },
  // `"pro" === family` (yoda / reversed operands)
  { name: "compare-lhs", re: new RegExp(`["'](?:${FAMILY_TOKEN_ALTERNATION})["']\\s*[!=]==`) },
  // `switch (family) { case "pro": … }`
  { name: "switch-case", re: new RegExp(`case\\s+["'](?:${FAMILY_TOKEN_ALTERNATION})["']\\s*:`) },
]

interface Offense {
  readonly file: string
  readonly line: number
  readonly detector: string
  readonly text: string
}

/** THE scanner — one implementation, used by the live scan AND by every
 *  non-vacuity/red-on-injection assertion, so the two cannot drift. */
const scanSource = (
  file: string,
  source: string,
  justified: typeof JUSTIFIED = JUSTIFIED,
): Offense[] => {
  const out: Offense[] = []
  // A synthetic JSDoc body may be supplied without its opening `/*`; the
  // shared parser correctly treats a bare `*` as code, so retain this fixture
  // normalization at the caller rather than weakening the canonical scanner.
  const codeLines = stripComments(source)
    .split("\n")
    .map((line) => (line.trimStart().startsWith("*") ? "" : line))
  source.split("\n").forEach((raw, i) => {
    const code = codeLines[i] ?? ""
    if (code.trim() === "") return
    for (const { name, re } of DETECTORS) {
      if (!re.test(code)) continue
      if (justified.some((j) => j.file === file && code.includes(j.match))) return
      out.push({ file, line: i + 1, detector: name, text: raw.trim() })
      return
    }
  })
  return out
}

const walk = (dir: string): string[] => {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry)
    if (statSync(abs).isDirectory()) {
      out.push(...walk(abs))
      continue
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue
    out.push(abs)
  }
  return out
}

const SCANNED = walk(BENCH_ROOT)
  .map((abs) => relative(REPO, abs))
  .filter((rel) => !SANCTIONED_OWNERS.has(rel))
  .sort()

/** The consumers this repair de-family-fied. Each is asserted PRESENT in the scan
 *  set (a renamed/moved file must fail loudly rather than drop out of scope) and
 *  each is proven red-on-injection against its REAL bytes below. */
const KNOWN_CONSUMERS = [
  "src/apps/bench/run-main.ts",
  "src/apps/bench/run-main-helpers.ts",
  "src/apps/bench/preset.ts",
  "src/apps/bench/python-swebench.ts",
  "src/apps/bench/python-verifier-wiring.ts",
  "src/apps/bench/remote/ssh.ts",
  "src/apps/bench/remote/full.ts",
  "src/apps/bench/remote/pool.ts",
  "src/apps/bench/remote/box-session.ts",
  "src/apps/bench/remote/box-session/ec2-lifecycle.ts",
  "src/apps/bench/remote/box-session/dataset-preflight.ts",
  // PMX-01 — the new family's own modules are CONSUMERS of the registry too
  // (only `registry.ts` is the sanctioned owner), so they are pinned in scope
  // and proven red-on-injection like every other consumer.
  "src/apps/bench/profiles/promax.ts",
  "src/apps/bench/profiles/promax-dataset-shape.ts",
  "src/apps/bench/profiles/promax-projection.ts",
  "src/apps/bench/profiles/plan.ts",
] as const

describe("T4 SSOT ratchet — known-item floor (a dead scan must FAIL, not pass)", () => {
  test("the walker really sees the bench tree", () => {
    expect(SCANNED.length).toBeGreaterThan(40)
    for (const rel of KNOWN_CONSUMERS) {
      expect(SCANNED, `${rel} dropped out of the scan set`).toContain(rel)
    }
    // the ONE sanctioned owner is excluded, and it really exists
    expect(SCANNED).not.toContain("src/apps/bench/profiles/registry.ts")
    expect(readFileSync(join(REPO, "src/apps/bench/profiles/registry.ts"), "utf8")).toContain(
      "DATASET_FAMILY_PROFILES",
    )
  })

  test("every scanned file was actually read (no silently-empty sources)", () => {
    const empty = SCANNED.filter((rel) => readFileSync(join(REPO, rel), "utf8").trim() === "")
    expect(empty).toEqual([])
  })
})

describe("T4 SSOT ratchet — no consumer branches on a raw family string", () => {
  test("the whole src/apps/bench tree is free of raw family string-compares", () => {
    const offenses = SCANNED.flatMap((rel) =>
      scanSource(rel, readFileSync(join(REPO, rel), "utf8")),
    )
    expect(
      offenses,
      "raw family string-compare(s) found — route the decision through " +
        "resolveDatasetFamilyProfile(family).<port> instead, or add a JUSTIFIED entry " +
        "with a reason:\n" +
        offenses.map((o) => `  ${o.file}:${o.line} [${o.detector}] ${o.text}`).join("\n"),
    ).toEqual([])
  })
})

describe("T4 SSOT ratchet — red-on-injection against the REAL bytes of each consumer", () => {
  // Realistic spellings, NOT just the one literal nobody would write: an aliased
  // local, a negated compare, a case-folded compare and a switch.
  const INJECTIONS: ReadonlyArray<{ readonly label: string; readonly code: string }> = [
    { label: "direct compare", code: 'if (family === "pro") { doProThing() }' },
    { label: "negated early-return", code: 'if (args.family !== "pro") return' },
    {
      label: "case-folded via an alias",
      code: 'const fam = params.datasetFamily; if ((fam ?? "").toLowerCase() === "live") useFork()',
    },
    { label: "yoda / reversed operands", code: 'if ("live" === resolvedFamily) useFork()' },
    { label: "switch", code: 'switch (family) { case "pro": return proThing() }' },
    // PMX-01: the NEW family must be covered by every spelling too, and `promax`
    // is not a substring match of the `pro` alternative (the quote anchors), so
    // these would have slipped through the pre-PMX-01 detectors.
    { label: "promax direct compare", code: 'if (family === "promax") usePinnedEvaluator()' },
    { label: "promax negated early-return", code: 'if (args.family !== "promax") return' },
    { label: "promax switch", code: 'switch (family) { case "promax": return proMaxThing() }' },
  ]

  for (const rel of KNOWN_CONSUMERS) {
    test(`${rel} — the scan goes RED for every realistic spelling`, () => {
      const real = readFileSync(join(REPO, rel), "utf8")
      // control: the file is clean as it stands
      expect(scanSource(rel, real)).toEqual([])
      for (const { label, code } of INJECTIONS) {
        const injected = `${real}\n${code}\n`
        const hits = scanSource(rel, injected)
        expect(hits.length, `${rel}: scan MISSED the injected "${label}" spelling`).toBe(1)
        expect(hits[0]?.text).toBe(code)
      }
    })
  }

  test("the scan does NOT fire on the sanctioned profile call or on family-free code", () => {
    const clean = [
      "const profile = resolveDatasetFamilyProfile(family)",
      "profile.harnessSpec({ datasetName }).pipSpec",
      'resolveDatasetFamilyProfile(family ?? "verified").setupBox({ ssh, log })',
      'const families = ["verified", "live", "pro", "promax"] as const',
      'if (datasetName === "SWE-bench-Live/SWE-bench-Live") {}',
      'log("dataset-family=pro but rows lack columns")',
      'log("dataset-family=promax but rows carry gold")',
      'const PROMAX_DATASET_NAME = "swe-bench-promax/SWE-Bench-ProMax"',
    ].join("\n")
    expect(scanSource("synthetic.ts", clean)).toEqual([])
  })

  test("DOC COMMENTS quoting the removed branch are not false-positives (but code is)", () => {
    const doc = ' * on `args.family !== "pro"` and then called a body the registry imported'
    expect(scanSource("synthetic.ts", doc)).toEqual([])
    expect(scanSource("synthetic.ts", '// if (family === "pro") return')).toEqual([])
    // …and the stripper does NOT swallow real code that merely contains a URL
    const url = 'const spec = "git+https://github.com/x"; if (family === "live") useFork()'
    expect(scanSource("synthetic.ts", url).length).toBe(1)
  })
})

describe("T4 SSOT ratchet — JUSTIFIED entries stay honest", () => {
  const staleJustifications = (
    entries: typeof JUSTIFIED,
    read: (file: string) => string,
  ): string[] =>
    entries.filter((j) => !read(j.file).includes(j.match)).map((j) => `${j.file} :: ${j.match}`)

  test("every justification points at a site that still exists", () => {
    expect(
      staleJustifications(JUSTIFIED, (f) => readFileSync(join(REPO, f), "utf8")),
      "a JUSTIFIED entry no longer matches any line — delete it rather than leaving a " +
        "standing exemption for code that is gone",
    ).toEqual([])
  })

  test("the staleness checker is live (it flags a justification for a vanished site)", () => {
    const stale = staleJustifications(
      [{ file: "x.ts", match: 'family === "gone"', reason: "test fixture" }],
      () => "no such code here",
    )
    expect(stale).toEqual(['x.ts :: family === "gone"'])
    // …and does NOT flag one that is still present
    expect(
      staleJustifications(
        [{ file: "x.ts", match: 'family === "gone"', reason: "test fixture" }],
        () => 'if (family === "gone") {}',
      ),
    ).toEqual([])
  })

  test("a JUSTIFIED entry suppresses exactly its ONE line and nothing else", () => {
    // The suppression MECHANISM is exercised as a pure function of the scanner, so
    // it is proven live even while the real JUSTIFIED list is empty.
    const src = 'if (family === "pro") a()\nif (family === "live") b()'
    expect(scanSource("z.ts", src)).toHaveLength(2)
    const suppressed = scanSource("z.ts", src, [
      { file: "z.ts", match: 'family === "pro"', reason: "test fixture" },
    ])
    expect(suppressed).toHaveLength(1)
    expect(suppressed[0]?.text).toBe('if (family === "live") b()')
    // …and a justification scoped to a DIFFERENT file suppresses nothing
    expect(
      scanSource("z.ts", src, [
        { file: "other.ts", match: 'family === "pro"', reason: "test fixture" },
      ]),
    ).toHaveLength(2)
  })
})
