/**
 * PMX-06 — the SOURCE-OWNER AUDIT as an executable check.
 *
 * The ticket is explicit that the `rg` inventory is not acceptance proof:
 * *"The executable owner test asserts exact definition/registration counts, a
 * non-zero known-consumer floor, and red-on-injection for a duplicate profile,
 * aggregator, writer call bypass, and top-level ProMax projector."* And:
 * *"Unclassified duplicates block live spend."*
 *
 * So this file drives the REAL audit over the REAL repository tree (no fixture
 * corpus for the live rails), and every injection below is a synthetic file
 * spliced into the SAME scan the live rail uses — never a hand-written string
 * matched against a regex.
 *
 * ⚠️ HERMETIC: the audit reads source text. No Docker, no EC2, no network.
 */
import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import {
  assertOwnerAuditAdmitsLiveSpend,
  auditProMaxSourceOwners,
  collectOwnerAuditSources,
  PROMAX_LEAKAGE_CHECK_IDS,
  PROMAX_LEAKAGE_CHECKS,
  PROMAX_OWNER_AUDIT_BASELINE,
  PROMAX_OWNER_CLASSES,
  PROMAX_OWNER_ROLES,
} from "@/apps/bench/promax/campaign"

const REPO = join(import.meta.dir, "..", "..", "..", "..", "..")
const SOURCES = collectOwnerAuditSources(REPO)
const LIVE = auditProMaxSourceOwners(SOURCES)

const withInjected = (path: string, text: string) =>
  auditProMaxSourceOwners([...SOURCES, { path, text }])

describe("PMX-06 source-owner audit — the live scan", () => {
  test("the scan is NON-EMPTY and covers the declared roots (anti-vacuum floor)", () => {
    // A silently-broken walker (renamed root, bad join) would make every
    // assertion below pass by scanning nothing.
    expect(SOURCES.length).toBeGreaterThan(200)
    const paths = new Set(SOURCES.map((f) => f.path))
    for (const known of [
      "src/apps/bench/run-config.ts",
      "src/apps/bench/profiles/registry.ts",
      "src/apps/bench/harness/promax/adapter.ts",
      "src/runner/batch/eval/official-grade/types.ts",
      "src/runner/batch/report-official-grade.ts",
      "src/runner/batch/report-envelope.ts",
      "tools/leaderboard-dashboard/projectors/swe-bench/registry.ts",
    ]) {
      expect({ known, present: paths.has(known) }).toEqual({ known, present: true })
    }
    // …and it never scans its own test files.
    expect(SOURCES.filter((f) => f.path.endsWith(".test.ts"))).toEqual([])
  })

  test("every canonical owner is defined EXACTLY once, at its declared path", () => {
    for (const role of PROMAX_OWNER_ROLES) {
      expect({ role, count: LIVE.ownerCounts[role] }).toEqual({ role, count: 1 })
    }
  })

  test("the live tree has no unclassified hit — live spend is admitted", () => {
    expect(LIVE.unclassified).toEqual([])
    expect(LIVE.problems).toEqual([])
    expect(LIVE.ok).toBe(true)
    expect(() => assertOwnerAuditAdmitsLiveSpend(LIVE)).not.toThrow()
  })

  test("every hit carries one of the five declared classifications", () => {
    // Non-vacuity: there ARE hits. A scan that classified nothing would satisfy
    // "no unclassified hit" trivially.
    expect(LIVE.hits.length).toBeGreaterThan(0)
    const classes = new Set(PROMAX_OWNER_CLASSES as readonly string[])
    for (const hit of LIVE.hits) {
      expect({
        at: `${hit.path}:${hit.line}`,
        known: classes.has(String(hit.classification)),
      }).toEqual({ at: `${hit.path}:${hit.line}`, known: true })
      expect(typeof hit.why).toBe("string")
    }
  })

  test("the counters only go DOWN: final ≤ the recorded PMX-06 baseline", () => {
    expect(LIVE.baseline).toEqual(PROMAX_OWNER_AUDIT_BASELINE)
    expect(LIVE.final.rawFamilyEnvReads).toBeLessThanOrEqual(LIVE.baseline.rawFamilyEnvReads)
    expect(LIVE.final.promaxBranchesOutsideProfile).toBeLessThanOrEqual(
      LIVE.baseline.promaxBranchesOutsideProfile,
    )
    expect(LIVE.final.legacyVerdictConsumers).toBeLessThanOrEqual(
      LIVE.baseline.legacyVerdictConsumers,
    )
  })

  test("the receipt is content-addressed over what it actually saw", () => {
    expect(LIVE.digest).toMatch(/^[0-9a-f]{64}$/)
    const again = auditProMaxSourceOwners(SOURCES)
    expect(again.digest).toBe(LIVE.digest)
    const perturbed = withInjected("src/apps/bench/promax/noise.ts", "export const x = 1\n")
    expect(perturbed.digest).not.toBe(LIVE.digest)
  })
})

// ── RED-ON-INJECTION — each is a realistic duplicate an author would write ───

describe("PMX-06 source-owner audit — a duplicate owner blocks live spend", () => {
  const cases: ReadonlyArray<{
    readonly label: string
    readonly path: string
    readonly text: string
    readonly role: (typeof PROMAX_OWNER_ROLES)[number]
  }> = [
    {
      label: "a second family profile registry",
      path: "src/apps/bench/promax/family-registry.ts",
      text: [
        "import type { DatasetFamilyProfile } from '../profiles/types'",
        "export const DATASET_FAMILY_PROFILES: Readonly<Record<string, DatasetFamilyProfile>> = {}",
        "",
      ].join("\n"),
      role: "family_profile_registry",
    },
    {
      label: "a second official-grade aggregator",
      path: "src/apps/bench/promax/score.ts",
      text: [
        "export const aggregateOfficialGrade = (input: unknown): unknown => {",
        "  return input",
        "}",
        "",
      ].join("\n"),
      role: "official_grade_aggregation",
    },
    {
      label: "a ProMax report writer beside the canonical one",
      path: "src/apps/bench/promax/write-report.ts",
      text: [
        "export const writeReport = async (file: string, report: unknown): Promise<void> => {",
        "  await Bun.write(file, JSON.stringify(report))",
        "}",
        "",
      ].join("\n"),
      role: "canonical_report_writer",
    },
    {
      label: "a second typed bench config resolver",
      path: "src/apps/bench/promax/config.ts",
      text: ["export const resolveBenchRunConfig = (input: unknown): unknown => input", ""].join(
        "\n",
      ),
      role: "typed_config_resolver",
    },
    {
      label: "a second ProMax harness adapter",
      path: "src/apps/bench/promax/grade-adapter.ts",
      text: [
        "export const buildProMaxOfficialGradeReceipt = (input: unknown): unknown => input",
        "",
      ].join("\n"),
      role: "promax_harness_adapter",
    },
    {
      label: "a second generic remote grade-receipt contract",
      path: "src/apps/bench/remote/promax-receipt.ts",
      text: [
        "export interface OfficialGradeReceipt {",
        "  readonly assigned: number",
        "}",
        "",
      ].join("\n"),
      role: "remote_grade_receipt_contract",
    },
    {
      label: "a top-level ProMax projector registration",
      path: "tools/leaderboard-dashboard/projectors/promax.ts",
      text: [
        "import { registerProjector } from './registry'",
        "registerProjector({ suite: 'promax', label: 'ProMax' } as never)",
        "",
      ].join("\n"),
      role: "swe_projector_promax_registration",
    },
  ]

  for (const injection of cases) {
    test(`REFUSES ${injection.label}`, () => {
      const audited = withInjected(injection.path, injection.text)
      expect(audited.ok).toBe(false)
      // it names the ROLE that now has two owners — not a generic "audit failed"
      expect(audited.ownerCounts[injection.role]).toBe(2)
      expect(audited.problems.join(" | ")).toContain(injection.role)
      expect(audited.unclassified.some((u) => u.startsWith(injection.path))).toBe(true)
      expect(() => assertOwnerAuditAdmitsLiveSpend(audited)).toThrow(/live spend/i)
    })
  }

  test("REFUSES a scattered promax family branch outside the registered profile", () => {
    const audited = withInjected(
      "src/apps/bench/remote/promax-route.ts",
      [
        "export const routeFamily = (family: string): string => {",
        `  if (family ${"==="} ${'"promax"'}) return "promax-lane"`,
        "  return 'generic'",
        "}",
        "",
      ].join("\n"),
    )
    expect(audited.final.promaxBranchesOutsideProfile).toBeGreaterThan(
      LIVE.final.promaxBranchesOutsideProfile,
    )
    expect(audited.ok).toBe(false)
    expect(audited.problems.join(" | ")).toMatch(/promaxBranchesOutsideProfile/)
  })

  test("REFUSES a NEW raw family env read (the counter ratchets down, never up)", () => {
    const audited = withInjected(
      "src/apps/bench/remote/family-env.ts",
      [
        "export const familyOf = (env: NodeJS.ProcessEnv): string =>",
        "  env.QUANTA_SWEBENCH_DATASET_FAMILY ?? 'verified'",
        "",
      ].join("\n"),
    )
    expect(audited.final.rawFamilyEnvReads).toBe(LIVE.final.rawFamilyEnvReads + 1)
    expect(audited.ok).toBe(false)
    expect(audited.problems.join(" | ")).toMatch(/rawFamilyEnvReads/)
  })

  test("REFUSES a new legacy verdict-bucket consumer", () => {
    const audited = withInjected(
      "src/apps/bench/promax/legacy-view.ts",
      [
        "import { projectLegacyBuckets } from '@/runner/batch/eval/official-grade'",
        "export const rate = (receipt: never): number => {",
        "  const b = projectLegacyBuckets(receipt)",
        "  return b.resolved.length / (b.resolved.length + b.unresolved.length)",
        "}",
        "",
      ].join("\n"),
    )
    expect(audited.final.legacyVerdictConsumers).toBeGreaterThan(LIVE.final.legacyVerdictConsumers)
    expect(audited.ok).toBe(false)
  })

  test("a classified duplicate is NOT a refusal — the table is what decides", () => {
    // PAIRED CONTROL. Without this, "any second occurrence fails" would pass
    // every injection above while making the classification table decorative.
    const benign = withInjected(
      "src/apps/bench/promax/notes.ts",
      [
        "// A doc comment that quotes the owner names:",
        "//   export const aggregateOfficialGrade = …",
        "//   export const writeReport = …",
        "export const NOTE = 'promax owner notes'",
        "",
      ].join("\n"),
    )
    expect(benign.ok).toBe(true)
    expect(benign.ownerCounts.official_grade_aggregation).toBe(1)
  })
})

describe("PMX-06 leakage checks name SHIPPED guards", () => {
  test("each declared leakage check is DEFINED and CALLED in production source", () => {
    // Gate 2 requires "the agent/grader leakage check enabled". That flag is
    // only meaningful if each id it lists corresponds to a guard that exists and
    // is wired — otherwise a run could claim the check by naming it.
    expect(PROMAX_LEAKAGE_CHECK_IDS.length).toBe(3)
    for (const id of PROMAX_LEAKAGE_CHECK_IDS) {
      const symbol = PROMAX_LEAKAGE_CHECKS[id].symbol
      const definedIn = SOURCES.filter((f) =>
        new RegExp(`^export const ${symbol}\\b`, "m").test(f.text),
      )
      // A CALL is any `symbol(` on a code line that is not the definition
      // itself — including a call inside the defining module, which is how
      // `assertGraderBundleOutsideAgentRoot` is wired (its writer invokes it).
      const calledIn = SOURCES.filter((f) =>
        f.text.split("\n").some((line) => {
          const t = line.trim()
          if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return false
          if (new RegExp(`^export const ${symbol}\\b`).test(t)) return false
          return new RegExp(`\\b${symbol}\\s*\\(`).test(line)
        }),
      )
      expect({ id, defined: definedIn.length }).toEqual({ id, defined: 1 })
      expect({ id, called: calledIn.length > 0 }).toEqual({ id, called: true })
    }
  })

  test("the symbol detector is not vacuous", () => {
    const symbols = PROMAX_LEAKAGE_CHECK_IDS.map((id) => PROMAX_LEAKAGE_CHECKS[id].symbol)
    // a symbol that does not exist must NOT be found by the same matcher
    const bogus = "assertNothingWhatsoeverEverywhere"
    expect(symbols).not.toContain(bogus)
    expect(
      SOURCES.filter((f) => new RegExp(`^export const ${bogus}\\b`, "m").test(f.text)),
    ).toEqual([])
  })
})

describe("PMX-06 source-owner audit — the detectors actually detect", () => {
  test("each owner detector fires on a real definition and NOT on a call site", () => {
    const definition = withInjected(
      "src/apps/bench/promax/dupe.ts",
      "export const aggregateOfficialGrade = (x: unknown): unknown => x\n",
    )
    expect(definition.ownerCounts.official_grade_aggregation).toBe(2)

    const callSite = withInjected(
      "src/apps/bench/promax/caller.ts",
      [
        "import { aggregateOfficialGrade } from '@/runner/batch/report-official-grade'",
        "export const use = (x: never): unknown => aggregateOfficialGrade(x)",
        "",
      ].join("\n"),
    )
    // a CALL is composition wiring, not a second definition
    expect(callSite.ownerCounts.official_grade_aggregation).toBe(1)
    expect(callSite.ok).toBe(true)
  })

  test("assertOwnerAuditAdmitsLiveSpend is a REAL failure, not prose", () => {
    const bad = withInjected(
      "src/apps/bench/promax/second-writer.ts",
      "export const writeReport = async (): Promise<void> => {}\n",
    )
    let thrown: unknown = null
    try {
      assertOwnerAuditAdmitsLiveSpend(bad)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(Error)
    expect(String(thrown)).toContain("canonical_report_writer")
  })
})
