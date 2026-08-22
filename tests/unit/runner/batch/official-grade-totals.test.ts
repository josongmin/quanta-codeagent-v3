/**
 * PMX-05 — the ONE official-grade aggregation owner (RED-first hellgate).
 *
 * The property under test is the HONEST DENOMINATOR: a campaign's `assigned` set
 * is a covering partition over the four PMX-03 states plus derived `missing`, and
 * the three rates are always reported together so a shrinking valid denominator
 * can never make a run look better without the coverage loss being visible.
 *
 * Every assertion below observes REAL behaviour of the shipped aggregator against
 * a real PMX-03 receipt built by the real fail-closed builder — never a
 * re-implementation of the arithmetic inside the test.
 */
import { describe, expect, test } from "bun:test"
import {
  buildOfficialGradeReceipt,
  OFFICIAL_GRADE_STATE_BY_REASON,
  type OfficialGradeDisposition,
  type OfficialGradeEvaluatorMeta,
  type OfficialGradeReason,
  type OfficialGradeReceipt,
  type OfficialGradeState,
} from "@/runner/batch/eval/official-grade"
import {
  aggregateOfficialGrade,
  assertOfficialGradeCoveringPartition,
  decodeOfficialGradeSection,
  formatOfficialGradeTotals,
  OFFICIAL_GRADE_RATE_UNAVAILABLE,
  type OfficialGradeInstanceMeta,
  OfficialGradePartitionError,
  type OfficialGradeSection,
  type OfficialGradeTotals,
  renderOfficialGradeCliLines,
  renderOfficialGradeMarkdown,
} from "@/runner/batch/report-official-grade"

// ── fixtures ────────────────────────────────────────────────────────────────

const hex = (seed: string): string =>
  Array.from(
    { length: 64 },
    (_, i) => "0123456789abcdef"[(seed.charCodeAt(i % seed.length) + i) % 16],
  ).join("")

const EVALUATOR: OfficialGradeEvaluatorMeta = {
  evaluatorId: "swe-bench-promax",
  upstreamCommit: "77041028bc4e2135644b63b504aa961a68aafbb6",
  evaluatorPath: "/opt/promax/test_run.py",
  evaluatorSha256: hex("evaluator"),
  argv: ["python", "test_run.py", "--predictions", "preds.jsonl"],
  cwd: "/opt/promax",
  exitCode: 0,
  stdout: "resolved 65/168",
  stderr: "",
  outputArtifact: { path: "/artifacts/pass_rate.json", sha256: hex("out"), byteLength: 4096 },
}

const disposition = (
  id: string,
  state: OfficialGradeState,
  reason: OfficialGradeReason,
): OfficialGradeDisposition => ({
  instanceId: id,
  state,
  reason,
  gradingValid: state === "resolved" || state === "model_miss",
  rawArtifact: { path: `/artifacts/${id}.json`, sha256: hex(id), byteLength: 128 },
  evaluator: {
    passed: state === "resolved",
    model: {
      finalResult: state === "resolved" ? "success" : "apply_failed",
      rawReason: state === "resolved" ? "success" : "apply_failed",
      returncode: state === "resolved" ? 0 : 1,
      scriptExitCode: state === "resolved" ? 0 : 1,
    },
    golden: {
      finalResult: state === "infra_invalid" ? "timeout_eval" : "success",
      rawReason: state === "infra_invalid" ? "timeout_eval" : "success",
      returncode: state === "infra_invalid" ? 1 : 0,
      scriptExitCode: state === "infra_invalid" ? 1 : 0,
    },
  },
})

/** The upstream language census (README: C 20, C++ 22, Go 23, Java 26, Python 29,
 *  Rust 22, TypeScript 28 = 170). Assigned ids are laid out in this order so the
 *  per-language table has a real, non-uniform distribution to sum. */
const LANGUAGE_CENSUS: readonly (readonly [string, number])[] = [
  ["C", 20],
  ["C++", 22],
  ["Go", 23],
  ["Java", 26],
  ["Python", 29],
  ["Rust", 22],
  ["TypeScript", 28],
]

const assignedIds = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `org__repo-${String(i).padStart(4, "0")}`)

const languageOf = (index: number): string => {
  let seen = 0
  for (const [language, count] of LANGUAGE_CENSUS) {
    if (index < seen + count) return language
    seen += count
  }
  return "unknown"
}

const instanceMeta = (ids: readonly string[]): Map<string, OfficialGradeInstanceMeta> => {
  const map = new Map<string, OfficialGradeInstanceMeta>()
  ids.forEach((id, i) => {
    map.set(id, {
      language: languageOf(i),
      predictionSha256: hex(`pred-${id}`),
      goldenSourceSha256: hex(`gs-${id}`),
      goldenDerivedSha256: hex(`gd-${id}`),
      evalSourceSha256: hex(`es-${id}`),
      evalDerivedSha256: hex(`ed-${id}`),
      image: {
        sourceRef: `ghcr.io/promax/${id}:v1`,
        registryDigest: `sha256:${hex(`img-${id}`)}`,
        localImageId: `sha256:${hex(`local-${id}`)}`,
        platform: "linux/arm64",
      },
      runId: "run-7",
      chunkId: "chunk-2",
      boxId: "i-0abc",
      attempts: 1,
    })
  })
  return map
}

const CAMPAIGN = {
  quantaSha: "9d5369d31",
  quantaDirty: true,
  provider: "openai",
  model: "gpt-5.5",
  reasoningEffort: "high",
  preset: "promax-v1",
  turnBudget: 40,
  tokenWall: 900_000,
  runId: "run-7",
} as const

/**
 * The canonical PMX-05 example: 170 assigned, 65 resolved, 103 model misses,
 * 2 infra-invalid, 0 ambiguous, 0 missing.
 */
const canonicalReceipt = (opts?: {
  readonly resolved?: number
  readonly modelMiss?: number
  readonly infra?: number
  readonly ambiguous?: number
}): { receipt: OfficialGradeReceipt; ids: string[] } => {
  const resolved = opts?.resolved ?? 65
  const modelMiss = opts?.modelMiss ?? 103
  const infra = opts?.infra ?? 2
  const ambiguous = opts?.ambiguous ?? 0
  const ids = assignedIds(170)
  const dispositions: OfficialGradeDisposition[] = []
  let cursor = 0
  const take = (n: number, state: OfficialGradeState, reason: OfficialGradeReason): void => {
    for (let i = 0; i < n; i += 1) {
      const id = ids[cursor]
      cursor += 1
      if (id === undefined) throw new Error("fixture ran past the assigned manifest")
      dispositions.push(disposition(id, state, reason))
    }
  }
  take(resolved, "resolved", "official_resolved")
  take(modelMiss, "model_miss", "test_failed")
  take(infra, "infra_invalid", "golden_timeout_eval")
  take(ambiguous, "ambiguous", "upstream_need_human_review")
  // Whatever the four states do NOT cover stays assigned-but-undispositioned —
  // i.e. `missing` is DERIVED by the aggregator, never declared by the fixture.
  const built = buildOfficialGradeReceipt({
    assignedInstanceIds: ids,
    dispositions,
    evaluator: EVALUATOR,
  })
  if (!built.ok) throw new Error(`fixture receipt refused: ${JSON.stringify(built.failures)}`)
  return { receipt: built.receipt, ids }
}

const canonicalSection = (opts?: Parameters<typeof canonicalReceipt>[0]): OfficialGradeSection => {
  const { receipt, ids } = canonicalReceipt(opts)
  return aggregateOfficialGrade({
    receipt,
    instanceMeta: instanceMeta(ids),
    campaign: CAMPAIGN,
  })
}

// ── the covering partition and the three rates ──────────────────────────────

describe("PMX-05 OfficialGradeTotals — the covering partition", () => {
  test("the canonical example: 65/168 valid, 168/170 coverage, 65/170 raw", () => {
    const totals = canonicalSection().totals
    expect(totals.assigned).toBe(170)
    expect(totals.resolved).toBe(65)
    expect(totals.model_miss).toBe(103)
    expect(totals.infra_invalid).toBe(2)
    expect(totals.ambiguous).toBe(0)
    expect(totals.missing).toBe(0)
    expect(totals.grading_valid).toBe(168)
    expect(totals.attempted).toBe(170)
    // The three rates, exact.
    expect(totals.official_valid_rate).toBe(65 / 168)
    expect(totals.coverage).toBe(168 / 170)
    expect(totals.raw_rate).toBe(65 / 170)
    // ...and they are NOT the same number, so a formula swap cannot hide here.
    expect(new Set([totals.official_valid_rate, totals.coverage, totals.raw_rate]).size).toBe(3)
  })

  test("assigned = resolved + model_miss + infra_invalid + ambiguous + missing (all four states live)", () => {
    const totals = canonicalSection({ resolved: 60, modelMiss: 90, infra: 5, ambiguous: 3 }).totals
    expect(totals.assigned).toBe(170)
    expect(totals.resolved).toBe(60)
    expect(totals.model_miss).toBe(90)
    expect(totals.infra_invalid).toBe(5)
    expect(totals.ambiguous).toBe(3)
    // 158 dispositions over a 170-id manifest ⇒ 12 assigned ids never graded.
    expect(totals.missing).toBe(12)
    expect(
      totals.resolved +
        totals.model_miss +
        totals.infra_invalid +
        totals.ambiguous +
        totals.missing,
    ).toBe(totals.assigned)
    expect(totals.attempted).toBe(totals.assigned - totals.missing)
    expect(totals.grading_valid).toBe(totals.resolved + totals.model_miss)
  })

  test("missing and ambiguous stay INSIDE assigned but OUTSIDE grading-valid", () => {
    const totals = canonicalSection({ resolved: 10, modelMiss: 10, infra: 0, ambiguous: 7 }).totals
    expect(totals.assigned).toBe(170)
    expect(totals.ambiguous).toBe(7)
    // 170 assigned, 27 dispositions ⇒ 143 assigned ids never graded.
    expect(totals.missing).toBe(143)
    expect(totals.grading_valid).toBe(20)
    // Neither ambiguous nor missing may leak into the valid denominator.
    expect(totals.grading_valid).toBe(totals.resolved + totals.model_miss)
    expect(totals.official_valid_rate).toBe(10 / 20)
    expect(totals.coverage).toBe(20 / 170)
    expect(totals.raw_rate).toBe(10 / 170)
  })

  test("raising infra while holding resolved fixed LOWERS coverage and cannot improve raw rate", () => {
    const base = canonicalSection({ resolved: 65, modelMiss: 103, infra: 2 }).totals
    // Convert 20 model misses into infra-invalid; `resolved` is untouched.
    const worse = canonicalSection({ resolved: 65, modelMiss: 83, infra: 22 }).totals
    expect(worse.resolved).toBe(base.resolved)
    expect(worse.assigned).toBe(base.assigned)
    // The flattering half: a smaller valid denominator DOES raise the valid rate…
    expect(worse.official_valid_rate ?? 0).toBeGreaterThan(base.official_valid_rate ?? 0)
    // …but coverage falls in the same breath, and the raw rate never improves.
    expect(worse.coverage ?? 1).toBeLessThan(base.coverage ?? 0)
    expect(worse.raw_rate).toBe(base.raw_rate)
    expect(worse.raw_rate ?? 0).toBeLessThanOrEqual(base.raw_rate ?? 0)
  })

  test("zero denominators are `null` — never 0, never NaN", () => {
    const empty = aggregateOfficialGrade({
      receipt: (() => {
        const built = buildOfficialGradeReceipt({
          assignedInstanceIds: [],
          dispositions: [],
          evaluator: EVALUATOR,
        })
        if (!built.ok) throw new Error("empty receipt refused")
        return built.receipt
      })(),
      instanceMeta: new Map(),
      campaign: CAMPAIGN,
    }).totals
    expect(empty.assigned).toBe(0)
    expect(empty.official_valid_rate).toBeNull()
    expect(empty.coverage).toBeNull()
    expect(empty.raw_rate).toBeNull()
    // A campaign where every row is infra-invalid: assigned > 0, valid == 0.
    const allInfra = canonicalSection({ resolved: 0, modelMiss: 0, infra: 170 }).totals
    expect(allInfra.grading_valid).toBe(0)
    expect(allInfra.official_valid_rate).toBeNull()
    expect(allInfra.coverage).toBe(0)
    expect(allInfra.raw_rate).toBe(0)
  })
})

// ── per-language + per-reason breakdowns ────────────────────────────────────

describe("PMX-05 breakdowns — per-language totals sum to the campaign totals", () => {
  test("by_language covers the FULL assigned manifest, invalid and missing rows included", () => {
    const totals = canonicalSection({ resolved: 60, modelMiss: 90, infra: 5, ambiguous: 3 }).totals
    const languages = Object.keys(totals.by_language).sort()
    expect(languages).toEqual(["C", "C++", "Go", "Java", "Python", "Rust", "TypeScript"])
    const sum = (pick: (v: OfficialGradeTotals["by_language"][string]) => number): number =>
      Object.values(totals.by_language).reduce((acc, v) => acc + pick(v), 0)
    expect(sum((v) => v.assigned)).toBe(totals.assigned)
    expect(sum((v) => v.resolved)).toBe(totals.resolved)
    expect(sum((v) => v.model_miss)).toBe(totals.model_miss)
    expect(sum((v) => v.infra_invalid)).toBe(totals.infra_invalid)
    expect(sum((v) => v.ambiguous)).toBe(totals.ambiguous)
    expect(sum((v) => v.missing)).toBe(totals.missing)
    expect(sum((v) => v.grading_valid)).toBe(totals.grading_valid)
    // Non-vacuity: the census really is the upstream one, not 7 buckets of ~24.
    expect(totals.by_language.Python?.assigned).toBe(29)
    expect(totals.by_language.C?.assigned).toBe(20)
    // And each per-language row obeys the SAME covering partition.
    for (const row of Object.values(totals.by_language)) {
      expect(row.resolved + row.model_miss + row.infra_invalid + row.ambiguous + row.missing).toBe(
        row.assigned,
      )
    }
  })

  test("by_reason counts every disposition exactly once, verbatim from PMX-03", () => {
    const totals = canonicalSection({ resolved: 60, modelMiss: 90, infra: 5, ambiguous: 3 }).totals
    expect(totals.by_reason).toEqual({
      official_resolved: 60,
      test_failed: 90,
      golden_timeout_eval: 5,
      upstream_need_human_review: 3,
    })
    const counted = Object.values(totals.by_reason).reduce((a, b) => a + b, 0)
    expect(counted).toBe(totals.attempted)
    // PMX-05 must NOT re-map upstream reasons: every key it emits belongs to the
    // PMX-03 table and keeps PMX-03's state.
    for (const reason of Object.keys(totals.by_reason)) {
      expect(OFFICIAL_GRADE_STATE_BY_REASON[reason as OfficialGradeReason]).toBeDefined()
    }
  })

  test("the reason drilldown reaches golden failures, model timeouts, image failures and human review", () => {
    const ids = assignedIds(6)
    const rows: readonly (readonly [OfficialGradeState, OfficialGradeReason])[] = [
      ["infra_invalid", "golden_apply_failed"],
      ["model_miss", "model_eval_timeout"],
      ["infra_invalid", "evaluator_unavailable"],
      ["ambiguous", "upstream_need_human_review"],
      ["resolved", "official_resolved"],
      ["model_miss", "test_failed"],
    ]
    const built = buildOfficialGradeReceipt({
      assignedInstanceIds: ids,
      dispositions: rows.map(([state, reason], i) => disposition(ids[i] ?? "", state, reason)),
      evaluator: EVALUATOR,
    })
    if (!built.ok) throw new Error("drilldown receipt refused")
    const display = formatOfficialGradeTotals(
      aggregateOfficialGrade({
        receipt: built.receipt,
        instanceMeta: new Map(),
        campaign: CAMPAIGN,
      }).totals,
    )
    const rendered = display.reasons.map((r) => `${r.state}/${r.reason}=${r.count}`)
    expect(rendered).toContain("infra_invalid/golden_apply_failed=1")
    expect(rendered).toContain("model_miss/model_eval_timeout=1")
    expect(rendered).toContain("infra_invalid/evaluator_unavailable=1")
    expect(rendered).toContain("ambiguous/upstream_need_human_review=1")
  })
})

// ── partition enforcement + red-on-injection ────────────────────────────────

describe("PMX-05 partition enforcement", () => {
  test("a well-formed totals object passes (non-vacuity control)", () => {
    expect(() => assertOfficialGradeCoveringPartition(canonicalSection().totals)).not.toThrow()
  })

  test("RED-ON-INJECTION: dropping ONE assigned row fails the partition assertion", () => {
    const totals = canonicalSection().totals
    const injected: OfficialGradeTotals = { ...totals, assigned: totals.assigned - 1 }
    expect(() => assertOfficialGradeCoveringPartition(injected)).toThrow(
      OfficialGradePartitionError,
    )
    expect(() => assertOfficialGradeCoveringPartition(injected)).toThrow(/assigned/)
  })

  test("RED-ON-INJECTION: every derived field is load-bearing, one mutation each", () => {
    const totals = canonicalSection({ resolved: 60, modelMiss: 90, infra: 5, ambiguous: 3 }).totals
    const mutations: readonly Partial<OfficialGradeTotals>[] = [
      { resolved: totals.resolved + 1 },
      { model_miss: totals.model_miss - 1 },
      { infra_invalid: totals.infra_invalid + 2 },
      { ambiguous: totals.ambiguous + 1 },
      { missing: totals.missing - 1 },
      { attempted: totals.attempted + 1 },
      { grading_valid: totals.grading_valid + 1 },
      { official_valid_rate: 0.99 },
      { coverage: 0.99 },
      { raw_rate: 0.99 },
    ]
    for (const mutation of mutations) {
      expect(() => assertOfficialGradeCoveringPartition({ ...totals, ...mutation })).toThrow(
        OfficialGradePartitionError,
      )
    }
  })

  test("RED-ON-INJECTION: a per-language row that no longer sums to the campaign fails", () => {
    const totals = canonicalSection().totals
    const python = totals.by_language.Python
    if (python === undefined) throw new Error("fixture lost its Python bucket")
    const injected: OfficialGradeTotals = {
      ...totals,
      by_language: { ...totals.by_language, Python: { ...python, resolved: python.resolved + 1 } },
    }
    expect(() => assertOfficialGradeCoveringPartition(injected)).toThrow(/by_language/)
  })
})

// ── per-instance receipt + round trip ───────────────────────────────────────

describe("PMX-05 per-instance receipt", () => {
  test("serializes the PMX-03 disposition VERBATIM plus the replay provenance", () => {
    const section = canonicalSection()
    expect(section.instances).toHaveLength(170)
    const first = section.instances[0]
    if (first === undefined) throw new Error("no instances")
    expect(first.state).toBe("resolved")
    expect(first.reason).toBe("official_resolved")
    expect(first.grading_valid).toBe(true)
    expect(first.language).toBe("C")
    expect(first.official.model_final_result).toBe("success")
    expect(first.official.golden_final_result).toBe("success")
    expect(first.raw_artifact?.sha256).toBe(hex(first.instance_id))
    expect(first.prediction_sha256).toBe(hex(`pred-${first.instance_id}`))
    expect(first.golden_digests?.source_sha256).toBe(hex(`gs-${first.instance_id}`))
    expect(first.eval_digests?.derived_sha256).toBe(hex(`ed-${first.instance_id}`))
    expect(first.evaluator.upstream_commit).toBe(EVALUATOR.upstreamCommit)
    expect(first.evaluator.sha256).toBe(EVALUATOR.evaluatorSha256)
    expect(first.image?.registry_digest).toBe(`sha256:${hex(`img-${first.instance_id}`)}`)
    expect(first.image?.local_image_id).toBe(`sha256:${hex(`local-${first.instance_id}`)}`)
    expect(first.image?.platform).toBe("linux/arm64")
    expect(first.quanta).toEqual({ sha: "9d5369d31", dirty: true })
    expect(first.run.provider).toBe("openai")
    expect(first.run.model).toBe("gpt-5.5")
    expect(first.run.reasoning_effort).toBe("high")
    expect(first.run.preset).toBe("promax-v1")
    expect(first.run.turn_budget).toBe(40)
    expect(first.run.token_wall).toBe(900_000)
    expect(first.run.run_id).toBe("run-7")
    expect(first.run.chunk_id).toBe("chunk-2")
    expect(first.run.box_id).toBe("i-0abc")
    expect(first.run.attempts).toBe(1)
  })

  test("unbounded grader streams are NEVER inlined — evidence is linked by digest", () => {
    const section = canonicalSection()
    const json = JSON.stringify(section)
    // The evaluator's wrapper streams are grader-only material; the per-instance
    // receipts carry a PATH + DIGEST, not the bytes.
    for (const instance of section.instances) {
      expect(instance).not.toHaveProperty("stdout")
      expect(instance).not.toHaveProperty("stderr")
      expect(instance.raw_artifact?.path).toMatch(/^\/artifacts\//)
      expect(instance.raw_artifact?.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
    expect(json).not.toContain("resolved 65/168")
  })

  test("missing rows are NAMED, not silently dropped from the campaign", () => {
    const section = canonicalSection({ resolved: 10, modelMiss: 10, infra: 0, ambiguous: 0 })
    expect(section.totals.missing).toBe(150)
    expect(section.missing_instance_ids).toHaveLength(150)
    // They are assigned ids with no disposition — and none of them shows up as a receipt.
    const receipted = new Set(section.instances.map((i) => i.instance_id))
    for (const id of section.missing_instance_ids) expect(receipted.has(id)).toBe(false)
  })

  test("round trip through JSON preserves EVERY provenance digest", () => {
    const section = canonicalSection({ resolved: 60, modelMiss: 90, infra: 5, ambiguous: 3 })
    const back = decodeOfficialGradeSection(JSON.parse(JSON.stringify(section)))
    expect(back).toEqual(section)
    // Explicit digest-by-digest check so a decoder that dropped a field cannot
    // pass via a lenient deep-equal on a smaller object.
    const digests = (s: OfficialGradeSection): string[] =>
      s.instances.flatMap((i) => [
        i.raw_artifact?.sha256 ?? "",
        i.prediction_sha256 ?? "",
        i.golden_digests?.source_sha256 ?? "",
        i.golden_digests?.derived_sha256 ?? "",
        i.eval_digests?.source_sha256 ?? "",
        i.eval_digests?.derived_sha256 ?? "",
        i.evaluator.sha256,
        i.image?.registry_digest ?? "",
        i.image?.local_image_id ?? "",
      ])
    expect(digests(back)).toEqual(digests(section))
    expect(digests(section).filter((d) => d !== "")).not.toHaveLength(0)
  })

  test("decode is FAIL-CLOSED: a persisted section whose partition broke is refused", () => {
    const section = canonicalSection()
    const raw = JSON.parse(JSON.stringify(section)) as { totals: Record<string, unknown> }
    raw.totals.assigned = 169
    expect(() => decodeOfficialGradeSection(raw)).toThrow(OfficialGradePartitionError)
  })
})

// ── one aggregation, many formatters ────────────────────────────────────────

describe("PMX-05 display — three rates always adjacent, zero denominators unavailable", () => {
  test("the CLI summary and the markdown export read the SAME persisted totals", () => {
    const section = canonicalSection()
    const cli = renderOfficialGradeCliLines(section).join("\n")
    const md = renderOfficialGradeMarkdown(section)
    for (const surface of [cli, md]) {
      expect(surface).toContain("170") // assigned
      expect(surface).toContain("168") // grading_valid
      expect(surface).toContain("65") // resolved
      expect(surface).toContain("38.7%") // 65/168
      expect(surface).toContain("98.8%") // 168/170
      expect(surface).toContain("38.2%") // 65/170
    }
  })

  test("the three rates are ADJACENT in every rendering", () => {
    const section = canonicalSection()
    const display = formatOfficialGradeTotals(section.totals)
    // Non-vacuity control: the three rendered rate strings are DISTINCT, so
    // "the row carrying this rate" is unambiguous and the adjacency claim below
    // cannot be satisfied by a single row that happens to match all three.
    expect(new Set([display.official_valid_rate, display.coverage, display.raw_rate]).size).toBe(3)
    for (const surface of [
      renderOfficialGradeCliLines(section).join("\n"),
      renderOfficialGradeMarkdown(section),
    ]) {
      const rows = surface.split("\n")
      const rowOf = (rate: string): number => {
        const at = rows.findIndex((row) => row.includes(rate))
        expect(at).toBeGreaterThanOrEqual(0)
        return at
      }
      const valid = rowOf(display.official_valid_rate)
      const coverage = rowOf(display.coverage)
      const raw = rowOf(display.raw_rate)
      // STRUCTURE, not a size budget: the three rates occupy three CONSECUTIVE
      // rows in this exact order. A renderer that interleaves anything between
      // them (a state tally, the evaluator line, a table header) — or that drops
      // one rate so the honest denominator can be read without its coverage —
      // moves these offsets off 1. Everything else in the surface may grow
      // freely without touching this assertion.
      expect([coverage - valid, raw - coverage]).toEqual([1, 1])
      // ...and the rate rows are the ONLY thing on their own rows that carries a
      // rate: no row outside the block repeats one of the three campaign rates.
      const carriers = rows.flatMap((row, i) =>
        [display.official_valid_rate, display.coverage, display.raw_rate].some((r) =>
          row.includes(r),
        )
          ? [i]
          : [],
      )
      expect(carriers).toEqual([valid, coverage, raw])
    }
  })

  test("a zero denominator renders as UNAVAILABLE, never as 0% success", () => {
    const section = canonicalSection({ resolved: 0, modelMiss: 0, infra: 170 })
    const display = formatOfficialGradeTotals(section.totals)
    expect(display.official_valid_rate).toContain(OFFICIAL_GRADE_RATE_UNAVAILABLE)
    expect(display.official_valid_rate).not.toContain("0.0%")
    // ...while a genuine ZERO (denominator > 0) still reads as 0.0%.
    expect(display.coverage).toContain("0.0%")
    expect(display.raw_rate).toContain("0.0%")
    const cli = renderOfficialGradeCliLines(section).join("\n")
    expect(cli).toContain(OFFICIAL_GRADE_RATE_UNAVAILABLE)
  })

  test("the display projection carries no denominator formula of its own", () => {
    // It is a pure formatting of the persisted totals: same totals ⇒ same strings,
    // and a totals object with DIFFERENT counts must move the strings.
    const a = formatOfficialGradeTotals(canonicalSection().totals)
    const b = formatOfficialGradeTotals(canonicalSection().totals)
    expect(a).toEqual(b)
    const c = formatOfficialGradeTotals(canonicalSection({ resolved: 66, modelMiss: 102 }).totals)
    expect(c.official_valid_rate).not.toBe(a.official_valid_rate)
    expect(c.score).not.toBe(a.score)
  })
})
