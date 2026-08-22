/**
 * aug-22 residual G1 — there must be exactly ONE dataset-family union.
 *
 * `bench-actions.ts` used to declare its OWN `export type Family = "verified" |
 * "pro" | "live"` plus a private `FAMILIES` Set. That is a SECOND, independently
 * maintained registry of the same closed axis whose canonical owner is
 * `src/apps/bench/dataset-family-token.ts`. It had already drifted: `promax`
 * (PMX-01) was added to the canonical union and the dashboard copy silently kept
 * refusing it, so a web-launched ProMax campaign 400'd with "unknown dataset
 * family" while the CLI accepted the very same token.
 *
 * This rail has THREE independent legs, because the failure mode has three
 * shapes:
 *
 *  1. BEHAVIOURAL (the strongest): the real `buildLaunchAction` — the privilege
 *     boundary the dashboard server actually calls — must accept EVERY canonical
 *     family and refuse a non-family, bidirectionally. A family added to (or
 *     removed from) the canonical registry moves this test with no edit here.
 *  2. RUNTIME SET-EQUALITY over every OTHER live mirror of the axis (today:
 *     `runner/batch/report-envelope.ts`, which the canonical-report writer keys
 *     off). Bidirectional: an extra member OR a missing member is red.
 *  3. A SOURCE SCAN that finds a union literal anywhere under `src/` + `tools/`,
 *     so a FOURTH copy cannot appear without either an equality leg or an
 *     explicit {@link JUSTIFIED} entry. Proven red-on-injection against the REAL
 *     bytes of `bench-actions.ts`, using the exact spelling that was there.
 *
 * Leg 3 alone would be a decorative source rail; legs 1+2 bind live values.
 */
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import {
  DATASET_FAMILIES as CANONICAL_FAMILIES,
  type DatasetFamily,
} from "@/apps/bench/dataset-family-token"
import {
  DATASET_FAMILIES as ENVELOPE_FAMILIES,
  isDatasetFamily,
} from "@/runner/batch/report-envelope"
import { ActionError, buildLaunchAction, type Family } from "./bench-actions"

const REPO = join(import.meta.dir, "..", "..")
const PRESETS: ReadonlySet<string> = new Set(["agentless-v1"])
const specFor = (family: string): Parameters<typeof buildLaunchAction>[0] => ({
  family: family as Family,
  dataset: "/home/u/.quanta/bench/datasets/x.jsonl",
  preset: "agentless-v1",
  model: "gpt-5.5",
})

/** Compile-link: the dashboard's `Family` and the canonical `DatasetFamily` must
 *  be the SAME type, in both directions. A widened or narrowed copy fails to
 *  typecheck rather than drifting at runtime. (Assigned through function
 *  parameters so the check is not vacuously narrowed by a single literal.) */
const canonicalToDashboard = (f: DatasetFamily): Family => f
const dashboardToCanonical = (f: Family): DatasetFamily => f

describe("G1 leg 1 — the LIVE launch boundary accepts exactly the canonical families", () => {
  test("KNOWN-ITEM FLOOR — the canonical registry really is the four-family axis", () => {
    expect([...CANONICAL_FAMILIES].sort()).toEqual(["live", "pro", "promax", "verified"])
    // `promax` is the member the dashboard copy was missing; name it explicitly
    // so a silent shrink of the canonical list cannot make this rail vacuous.
    expect(CANONICAL_FAMILIES).toContain("promax")
    expect(CANONICAL_FAMILIES.length).toBeGreaterThanOrEqual(4)
  })

  test("EVERY canonical family is accepted and reaches argv + env unchanged", () => {
    for (const family of CANONICAL_FAMILIES) {
      const { argv, env } = buildLaunchAction(specFor(family), PRESETS)
      expect(argv, `${family} was not forwarded on argv`).toContain("--dataset-family")
      expect(argv[argv.indexOf("--dataset-family") + 1]).toBe(family)
      // the argv+env subprocess boundary serialization must keep working
      expect(env.QUANTA_SWEBENCH_DATASET_FAMILY).toBe(family)
      expect(canonicalToDashboard(family)).toBe(family)
      expect(dashboardToCanonical(family as Family)).toBe(family)
    }
  })

  test("PAIRED CONTROL — a NON-family token is still refused (the gate is not open)", () => {
    for (const bogus of ["", "prow", "PRO", " pro", "promaxx", "terminal-bench"]) {
      expect(() => buildLaunchAction(specFor(bogus), PRESETS), `${bogus} was accepted`).toThrow(
        ActionError,
      )
    }
  })
})

describe("G1 leg 2 — every other live mirror of the axis agrees, bidirectionally", () => {
  /** Each entry is a LIVE value imported from its module, never a literal. */
  const MIRRORS: ReadonlyArray<{ readonly name: string; readonly families: readonly string[] }> = [
    { name: "runner/batch/report-envelope.ts", families: ENVELOPE_FAMILIES },
  ]

  const diff = (
    a: readonly string[],
    b: readonly string[],
  ): { missing: string[]; extra: string[] } => ({
    missing: a.filter((x) => !b.includes(x)),
    extra: b.filter((x) => !a.includes(x)),
  })

  for (const mirror of MIRRORS) {
    test(`${mirror.name} — same members as the canonical registry`, () => {
      const { missing, extra } = diff(CANONICAL_FAMILIES, mirror.families)
      expect(missing, `${mirror.name} is MISSING canonical famil(ies)`).toEqual([])
      expect(extra, `${mirror.name} declares famil(ies) the canonical registry does not`).toEqual(
        [],
      )
      // …and its runtime membership predicate agrees with the canonical list.
      for (const family of CANONICAL_FAMILIES) expect(isDatasetFamily(family)).toBe(true)
      expect(isDatasetFamily("prow")).toBe(false)
    })
  }

  test("the differ is LIVE (it reports both directions)", () => {
    expect(diff(["a", "b"], ["b", "c"])).toEqual({ missing: ["a"], extra: ["c"] })
    expect(diff(["a"], ["a"])).toEqual({ missing: [], extra: [] })
  })
})

/**
 * Sites allowed to spell a family union literal. Anything else must consume the
 * canonical registry. Each entry carries a REASON; `staleJustifications` below
 * keeps the list honest.
 */
const JUSTIFIED: ReadonlyArray<{ readonly file: string; readonly reason: string }> = [
  {
    file: "src/apps/bench/dataset-family-token.ts",
    reason: "THE canonical owner — the union and its registry are the data here.",
  },
  {
    file: "src/runner/batch/report-envelope.ts",
    reason:
      "The batch layer's canonical-report mirror; it must not import the bench CLI surface, " +
      "so it re-declares the axis and is held to set-equality by leg 2 above.",
  },
  {
    file: "tools/leaderboard-dashboard/external-baselines.ts",
    reason:
      "NOT a family registry: the SUBSET of families for which a published external leaderboard " +
      "baseline exists (`pro` | `live`). Widening it to all families would assert baselines that " +
      "do not exist.",
  },
  {
    file: "tools/leaderboard-dashboard/external-comparison.ts",
    reason: "Same external-baseline coordinate domain as external-baselines.ts.",
  },
]

const FAMILY_TOKENS = "verified|promax|live|pro"
/** Two quoted family tokens joined by `|` (a type union) or `,` (an array/Set
 *  literal) — the two spellings every real copy of this axis has used. */
const UNION_RE = new RegExp(
  `["'](?:${FAMILY_TOKENS})["']\\s*[|,]\\s*["'](?:${FAMILY_TOKENS})["']`,
)

/** Drop comment content: every one of these modules DOCUMENTS the axis in prose. */
const stripComments = (line: string): string => {
  const t = line.trim()
  if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return ""
  return line.replace(/(^|[^:])\/\/.*$/, "$1")
}

interface Offense {
  readonly file: string
  readonly line: number
  readonly text: string
}

const scanSource = (file: string, source: string): Offense[] => {
  const out: Offense[] = []
  source.split("\n").forEach((raw, i) => {
    const code = stripComments(raw)
    if (code.trim() === "" || !UNION_RE.test(code)) return
    out.push({ file, line: i + 1, text: raw.trim() })
  })
  return out
}

const walk = (dir: string): string[] => {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue
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

const SCANNED = [...walk(join(REPO, "src")), ...walk(join(REPO, "tools"))]
  .map((abs) => relative(REPO, abs))
  .sort()

const JUSTIFIED_FILES = new Set(JUSTIFIED.map((j) => j.file))

describe("G1 leg 3 — no UNDECLARED second family union anywhere in src/ + tools/", () => {
  test("KNOWN-ITEM FLOOR — the walker really covers both trees", () => {
    expect(SCANNED.length).toBeGreaterThan(500)
    for (const rel of [
      "tools/leaderboard-dashboard/bench-actions.ts",
      "src/apps/bench/dataset-family-token.ts",
      "src/runner/batch/report-envelope.ts",
      "src/apps/bench/profiles/registry.ts",
    ]) {
      expect(SCANNED, `${rel} dropped out of the scan set`).toContain(rel)
    }
  })

  test("every union-literal site is a JUSTIFIED one", () => {
    const offenses = SCANNED.filter((rel) => !JUSTIFIED_FILES.has(rel)).flatMap((rel) =>
      scanSource(rel, readFileSync(join(REPO, rel), "utf8")),
    )
    expect(
      offenses,
      "a SECOND dataset-family union was declared — import DATASET_FAMILIES / DatasetFamily " +
        "from src/apps/bench/dataset-family-token.ts instead, or add a JUSTIFIED entry with a " +
        "reason:\n" +
        offenses.map((o) => `  ${o.file}:${o.line} ${o.text}`).join("\n"),
    ).toEqual([])
  })

  test("RED-ON-INJECTION — the exact spelling that was in bench-actions.ts is caught", () => {
    const rel = "tools/leaderboard-dashboard/bench-actions.ts"
    const real = readFileSync(join(REPO, rel), "utf8")
    // control: clean as it stands
    expect(scanSource(rel, real)).toEqual([])
    const INJECTIONS = [
      // verbatim what this repair removed
      'export type Family = "verified" | "pro" | "live"',
      'const FAMILIES: ReadonlySet<string> = new Set(["verified", "pro", "live"])',
      // and the shapes a re-introduction would plausibly take
      'export type Family = "verified" | "pro" | "live" | "promax"',
      'const ALLOWED = ["pro", "promax"] as const',
      "type F = 'live' | 'pro'",
    ]
    for (const code of INJECTIONS) {
      const hits = scanSource(rel, `${real}\n${code}\n`)
      expect(hits.length, `scan MISSED: ${code}`).toBe(1)
      expect(hits[0]?.text).toBe(code)
    }
  })

  test("the scan does NOT fire on canonical CONSUMPTION or on doc prose", () => {
    const clean = [
      'import { DATASET_FAMILIES } from "@/apps/bench/dataset-family-token"',
      "const FAMILIES: ReadonlySet<string> = new Set(DATASET_FAMILIES)",
      "must(FAMILIES.has(spec.family), `unknown dataset family: ${spec.family}`)",
      ' * ("verified" | "pro" | "live") to the right external coordinate',
      '// export type Family = "verified" | "pro" | "live"',
      'const suites = ["swe-bench", "terminal-bench"] as const',
    ].join("\n")
    expect(scanSource("synthetic.ts", clean)).toEqual([])
  })

  test("every JUSTIFIED entry still points at a real union site", () => {
    const stale = JUSTIFIED.filter(
      (j) => scanSource(j.file, readFileSync(join(REPO, j.file), "utf8")).length === 0,
    ).map((j) => j.file)
    expect(
      stale,
      "a JUSTIFIED entry no longer contains a family union — delete it rather than leaving a " +
        "standing exemption",
    ).toEqual([])
  })
})
