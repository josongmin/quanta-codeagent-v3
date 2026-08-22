/**
 * PMX-06 — the FROZEN CAMPAIGN RECORD.
 *
 * The ticket's "Frozen campaign inputs" section is a precondition, not a
 * document: *"Before PMX-7, record: PMX manifest digests and ordered nested
 * sample IDs; exact Quanta clean SHA; control and candidate preset names plus
 * resolved knob snapshots; provider, model, reasoning effort, turn/token/wall
 * budgets; patch-generation and grading concurrency; continuation rule from
 * PMX-40 to Full-170; retry and upstream-exception policy"* — and *"Do not use
 * the implicit current default preset."*
 *
 * Every assertion below drives the REAL freeze function over REAL sample
 * manifests built by the production sampler (`buildProMaxSampleFamily`) from a
 * 170-row synthetic corpus, so "the manifest digests are recorded" is checked
 * against digests the production code actually computes rather than literals a
 * fixture invented.
 *
 * ⚠️ HERMETIC: pure data in, pure record out. No Docker, no EC2, no network, no
 * `~/.quanta` write. Nothing here can spend.
 */
import { describe, expect, test } from "bun:test"
import { CURRENT_BENCH_BASE_PRESET } from "@/apps/bench/preset"
import {
  type FreezeProMaxCampaignInput,
  freezeProMaxCampaignRecord,
  PROMAX_CAMPAIGN_RECORD_FAILURE_CODES,
  PROMAX_OWNER_AUDIT_BASELINE,
  type ProMaxCampaignRecordFailureCode,
  type ProMaxFrozenCampaignRecord,
  parseProMaxCampaignRecord,
  serializeProMaxCampaignRecord,
} from "@/apps/bench/promax/campaign"
import {
  buildProMaxSampleFamily,
  PROMAX_SAMPLE_SPECS,
  type ProMaxSampleManifest,
} from "@/apps/bench/promax/corpus"
import { PROMAX_V1_SNAPSHOT } from "@/apps/bench/promax/provenance"
import { buildSyntheticProMaxCorpus } from "./promax-corpus-fixture"

// ── fixtures ────────────────────────────────────────────────────────────────

const CORPUS = buildSyntheticProMaxCorpus()

const SAMPLES: readonly ProMaxSampleManifest[] = buildProMaxSampleFamily({
  candidates: CORPUS.rows.map((row) => ({
    instanceId: String(row.instance_id),
    language: String(row.language),
  })),
  datasetRevision: PROMAX_V1_SNAPSHOT.hf_dataset_revision,
})

/** An owner-audit receipt in its ADMITTING shape. The audit itself is proven in
 *  `promax-source-owner-audit.test.ts`; here it is an input like any other. */
const OWNER_AUDIT_OK = {
  ok: true,
  digest: "a".repeat(64),
  unclassified: [] as readonly string[],
  // the RATCHET counters the freeze records; `final` at (not above) baseline is
  // the honest steady state, so a rise below is a deliberate change of one number
  baseline: PROMAX_OWNER_AUDIT_BASELINE,
  final: { ...PROMAX_OWNER_AUDIT_BASELINE },
}

const baseInput = (): FreezeProMaxCampaignInput => ({
  campaignId: "pmx-2026-08-22-a",
  frozenAt: "2026-08-22T00:00:00.000Z",
  quanta: { sha: `${"0".repeat(39)}f`, dirty: false },
  upstream: PROMAX_V1_SNAPSHOT,
  samples: SAMPLES,
  arms: [
    {
      role: "control",
      name: "pmx-control-agentless-v1",
      preset: "agentless-v1",
      knobs: { lsp: "1" },
    },
    {
      role: "candidate",
      name: "pmx-candidate-agentless-v1-subagent",
      preset: "agentless-v1",
      knobs: { lsp: "1", subagent: "1" },
    },
  ],
  model: {
    provider: "openai",
    model: "gpt-5.4",
    surface: "openai-responses",
    reasoningEffortRequested: "high",
  },
  budgets: { maxTurns: 40, maxTokens: 400_000, wallClockMs: 1_800_000 },
  concurrency: { patchGeneration: 4, grading: 1 },
  continuationRule: {
    declaredAt: "2026-08-21T00:00:00.000Z",
    text: "continue to Full-170 only if the candidate resolves at least 3 more PMX-40 instances than control at no more than +$40 total",
    minPairedInstances: 40,
    minResolvedDelta: 3,
    maxCostUsdDelta: 40,
  },
  retryPolicy: { maxChunkAttempts: 2, exhaustedDisposition: "missing", maxUngradedAssigned: 0 },
  exceptionPolicy: {
    manifestVersion: 1,
    requiresOwner: true,
    requiresUpstreamReference: true,
    deletesFromAssigned: false,
  },
  ownerAudit: OWNER_AUDIT_OK,
})

const freezeOk = (input: FreezeProMaxCampaignInput): ProMaxFrozenCampaignRecord => {
  const result = freezeProMaxCampaignRecord(input)
  if (!result.ok) {
    throw new Error(
      `fixture gap — freeze refused: ${result.failures.map((f) => f.code).join(", ")}`,
    )
  }
  return result.record
}

const codesOf = (input: FreezeProMaxCampaignInput): readonly ProMaxCampaignRecordFailureCode[] => {
  const result = freezeProMaxCampaignRecord(input)
  return result.ok ? [] : result.failures.map((f) => f.code)
}

// ── the PAIRED CONTROL: the honest campaign freezes ──────────────────────────

describe("PMX-06 frozen campaign record — the honest input freezes", () => {
  test("the fixture family is the real nested one (non-vacuity floor)", () => {
    expect(SAMPLES.map((s) => s.name)).toEqual(PROMAX_SAMPLE_SPECS.map((s) => s.name))
    expect(SAMPLES.map((s) => s.instanceIds.length)).toEqual([7, 14, 40, 170])
  })

  test("a complete, explicit, clean campaign is accepted", () => {
    const record = freezeOk(baseInput())
    expect(record.record_version).toBe(1)
    expect(record.campaign_id).toBe("pmx-2026-08-22-a")
  })

  test("it records the manifest DIGESTS and the ORDERED nested sample ids", () => {
    const record = freezeOk(baseInput())
    expect(record.samples.map((s) => s.name)).toEqual(["PMX-7", "PMX-14", "PMX-40", "PMX-170"])
    expect(record.samples.map((s) => s.sha256)).toEqual(SAMPLES.map((s) => s.sha256))
    // ORDERED, verbatim — not a set, not re-sorted.
    expect(record.samples[0]?.instanceIds).toEqual(SAMPLES[0]?.instanceIds ?? [])
    expect(record.samples[3]?.instanceIds).toEqual(SAMPLES[3]?.instanceIds ?? [])
    expect(record.samples[0]?.parentSubsetSha256).toBeNull()
    expect(record.samples[1]?.parentSubsetSha256).toBe(SAMPLES[0]?.sha256 ?? "")
  })

  test("it records both ARMS with their preset AND resolved knob snapshot", () => {
    const record = freezeOk(baseInput())
    const roles = record.arms.map((a) => a.role)
    expect(roles).toEqual(["control", "candidate"])
    expect(record.arms[0]?.preset).toBe("agentless-v1")
    expect(record.arms[1]?.knobs).toEqual({ lsp: "1", subagent: "1" })
    // separately NAMED, per "Product A/B arms are separately named and frozen"
    expect(record.arms[0]?.name).not.toBe(record.arms[1]?.name)
  })

  test("it records budgets, concurrency, retry and exception policy verbatim", () => {
    const record = freezeOk(baseInput())
    expect(record.budgets).toEqual({ maxTurns: 40, maxTokens: 400_000, wallClockMs: 1_800_000 })
    expect(record.concurrency).toEqual({ patchGeneration: 4, grading: 1 })
    expect(record.retry_policy.maxChunkAttempts).toBe(2)
    expect(record.retry_policy.exhaustedDisposition).toBe("missing")
    expect(record.exception_policy.deletesFromAssigned).toBe(false)
  })

  test("the record is content-addressed and round-trips through its own parser", () => {
    const record = freezeOk(baseInput())
    expect(record.sha256).toMatch(/^[0-9a-f]{64}$/)
    const parsed = parseProMaxCampaignRecord(serializeProMaxCampaignRecord(record))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error("unreachable")
    expect(parsed.record.sha256).toBe(record.sha256)
    expect(parsed.record.samples.map((s) => s.sha256)).toEqual(record.samples.map((s) => s.sha256))
  })

  test("an EDITED record fails its own digest — the file cannot be tuned after the fact", () => {
    const record = freezeOk(baseInput())
    const doc = JSON.parse(serializeProMaxCampaignRecord(record)) as Record<string, unknown>
    // the realistic edit: relax the continuation rule after the numbers are in
    ;(doc.continuation_rule as Record<string, unknown>).minResolvedDelta = 0
    const parsed = parseProMaxCampaignRecord(JSON.stringify(doc))
    expect(parsed.ok).toBe(false)
    if (parsed.ok) throw new Error("unreachable")
    expect(parsed.failures.map((f) => f.code)).toContain("record_digest_mismatch")
  })
})

// ── the REFUSALS, one clause per test ───────────────────────────────────────

describe("PMX-06 frozen campaign record — refuses an unfreezable campaign", () => {
  test("REFUSES the implicit default preset (the ticket's named hazard)", () => {
    const implicit = baseInput()
    const codes = codesOf({
      ...implicit,
      arms: [{ ...implicit.arms[0], preset: undefined }, implicit.arms[1]] as never,
    })
    expect(codes).toContain("preset_implicit")
  })

  test("REFUSES the current repo default preset by NAME — it is the Pyright-only strict gate", () => {
    const input = baseInput()
    const codes = codesOf({
      ...input,
      arms: [{ ...input.arms[0], preset: CURRENT_BENCH_BASE_PRESET }, input.arms[1]] as never,
    })
    // it is refused for the REASON the ticket gives (it requires live LSP grounding),
    // not merely because its name matches a blocklist
    expect(codes).toContain("preset_not_portable")
  })

  test("REFUSES a preset name no preset registry defines (a typo resolves to nothing)", () => {
    const input = baseInput()
    const codes = codesOf({
      ...input,
      arms: [{ ...input.arms[0], preset: "agentless-v1-typo" }, input.arms[1]] as never,
    })
    expect(codes).toContain("preset_unknown")
  })

  test("REFUSES a reasoning effort the provider will never receive", () => {
    // `max` is the SESSION vocabulary, not the Responses wire vocabulary.
    expect(
      codesOf({ ...baseInput(), model: { ...baseInput().model, reasoningEffortRequested: "max" } }),
    ).toContain("reasoning_effort_dishonest")
    // …and an effort requested on a surface with NO effort field at all.
    expect(
      codesOf({
        ...baseInput(),
        model: { ...baseInput().model, surface: "anthropic-messages" },
      }),
    ).toContain("reasoning_effort_dishonest")
  })

  test("records the effort DECISION, not the requested string", () => {
    const record = freezeOk(baseInput())
    expect(record.model.reasoning_effort.requested).toBe("high")
    expect(record.model.reasoning_effort.decision).toBe("delivered")
    expect(record.model.reasoning_effort.delivered).toBe("high")

    const absent = freezeOk({
      ...baseInput(),
      model: { ...baseInput().model, reasoningEffortRequested: undefined },
    })
    expect(absent.model.reasoning_effort.decision).toBe("absent")
    expect(absent.model.reasoning_effort.delivered).toBeNull()
  })

  test("REFUSES a dirty tree and a non-exact Quanta SHA", () => {
    expect(codesOf({ ...baseInput(), quanta: { sha: "0".repeat(40), dirty: true } })).toContain(
      "quanta_tree_dirty",
    )
    expect(codesOf({ ...baseInput(), quanta: { sha: "abc1234", dirty: false } })).toContain(
      "quanta_sha_not_exact",
    )
  })

  test("REFUSES upstream identity drift from the frozen snapshot", () => {
    const codes = codesOf({
      ...baseInput(),
      upstream: { ...PROMAX_V1_SNAPSHOT, dataset_sha256: "f".repeat(64) },
    })
    expect(codes).toContain("upstream_snapshot_drift")
  })

  test("REFUSES an incomplete sample family and a broken nesting chain", () => {
    expect(codesOf({ ...baseInput(), samples: SAMPLES.slice(0, 3) })).toContain(
      "sample_family_incomplete",
    )

    // the realistic corruption: PMX-14 redrawn under a different seed, so it no
    // longer CONTAINS PMX-7 — the digest chain and the subset both break.
    const redrawn = buildProMaxSampleFamily({
      candidates: CORPUS.rows.map((row) => ({
        instanceId: String(row.instance_id),
        language: String(row.language),
      })),
      datasetRevision: PROMAX_V1_SNAPSHOT.hf_dataset_revision,
      seed: "a-different-seed",
    })
    const spliced = [SAMPLES[0], redrawn[1], SAMPLES[2], SAMPLES[3]] as ProMaxSampleManifest[]
    const codes = codesOf({ ...baseInput(), samples: spliced })
    expect(codes).toContain("sample_not_nested")
    expect(codes).toContain("sample_parent_digest_broken")
  })

  test("REFUSES a hand-edited sample manifest (its own digest no longer holds)", () => {
    const tampered = SAMPLES.map((s, i) =>
      i === 0 ? { ...s, instanceIds: [...s.instanceIds.slice(1), "promax__c-020"] } : s,
    )
    expect(codesOf({ ...baseInput(), samples: tampered })).toContain("sample_digest_invalid")
  })

  test("REFUSES a manifest drawn from another dataset revision", () => {
    const other = buildProMaxSampleFamily({
      candidates: CORPUS.rows.map((row) => ({
        instanceId: String(row.instance_id),
        language: String(row.language),
      })),
      datasetRevision: "0".repeat(40),
    })
    expect(codesOf({ ...baseInput(), samples: other })).toContain("sample_revision_mismatch")
  })

  test("REFUSES arms that are not exactly one control and one candidate", () => {
    const input = baseInput()
    expect(codesOf({ ...input, arms: [input.arms[0]] as never })).toContain("arm_roles_invalid")
    expect(
      codesOf({ ...input, arms: [input.arms[0], { ...input.arms[1], role: "control" }] as never }),
    ).toContain("arm_roles_invalid")
  })

  test("REFUSES two arms that are the same configuration (a paired run with no variable)", () => {
    const input = baseInput()
    const codes = codesOf({
      ...input,
      arms: [input.arms[0], { ...input.arms[1], knobs: { ...input.arms[0]?.knobs } }] as never,
    })
    expect(codes).toContain("arms_indistinguishable")
  })

  test("REFUSES a continuation rule written AFTER the campaign was frozen", () => {
    const input = baseInput()
    const codes = codesOf({
      ...input,
      continuationRule: { ...input.continuationRule, declaredAt: "2026-08-23T00:00:00.000Z" },
    })
    expect(codes).toContain("continuation_rule_not_predeclared")
  })

  test("REFUSES unusable budgets, concurrency and retry policy", () => {
    expect(codesOf({ ...baseInput(), budgets: { ...baseInput().budgets, maxTurns: 0 } })).toContain(
      "budget_invalid",
    )
    expect(codesOf({ ...baseInput(), concurrency: { patchGeneration: 4, grading: 0 } })).toContain(
      "concurrency_invalid",
    )
    expect(
      codesOf({
        ...baseInput(),
        retryPolicy: {
          maxChunkAttempts: 0,
          exhaustedDisposition: "missing",
          maxUngradedAssigned: 0,
        },
      }),
    ).toContain("retry_policy_invalid")
  })

  test("REFUSES a campaign whose source-owner audit left an unclassified duplicate", () => {
    const codes = codesOf({
      ...baseInput(),
      ownerAudit: {
        ...OWNER_AUDIT_OK,
        ok: false,
        unclassified: ["src/apps/bench/promax/second-registry.ts:12"],
      },
    })
    expect(codes).toContain("owner_audit_unclassified")
  })

  test("every declared failure code is REACHABLE from a real input (no decorative codes)", () => {
    // The union is the SSOT of "what can refuse a campaign". A code nobody can
    // produce is a lie about the gate's coverage.
    const reachable = new Set<string>([
      ...codesOf({
        ...baseInput(),
        campaignId: "  ",
        quanta: { sha: "nope", dirty: true },
        upstream: { ...PROMAX_V1_SNAPSHOT, ids_sha256: "0".repeat(64) },
        samples: SAMPLES.slice(0, 2),
        arms: [{ ...baseInput().arms[0], preset: undefined }] as never,
        model: { ...baseInput().model, reasoningEffortRequested: "max" },
        budgets: { maxTurns: 0, maxTokens: 0, wallClockMs: 0 },
        concurrency: { patchGeneration: 0, grading: 0 },
        retryPolicy: {
          maxChunkAttempts: 0,
          exhaustedDisposition: "missing",
          maxUngradedAssigned: 0,
        },
        continuationRule: {
          ...baseInput().continuationRule,
          declaredAt: "2026-09-01T00:00:00.000Z",
        },
        ownerAudit: { ...OWNER_AUDIT_OK, ok: false, unclassified: ["x:1"] },
      }),
      // the ratchet clause: counters supplied by hand that ROSE above baseline
      ...codesOf({
        ...baseInput(),
        ownerAudit: {
          ...OWNER_AUDIT_OK,
          final: {
            ...PROMAX_OWNER_AUDIT_BASELINE,
            rawFamilyEnvReads: PROMAX_OWNER_AUDIT_BASELINE.rawFamilyEnvReads + 1,
          },
        },
      }),
      // the two clauses only a well-formed input can reach
      ...codesOf({
        ...baseInput(),
        arms: [
          { ...baseInput().arms[0], preset: CURRENT_BENCH_BASE_PRESET },
          baseInput().arms[1],
        ] as never,
      }),
      ...codesOf({
        ...baseInput(),
        arms: [
          { ...baseInput().arms[0], preset: "agentless-v1-typo" },
          baseInput().arms[1],
        ] as never,
      }),
      ...codesOf({
        ...baseInput(),
        arms: [
          baseInput().arms[0],
          { ...baseInput().arms[1], knobs: { ...baseInput().arms[0]?.knobs } },
        ] as never,
      }),
      ...codesOf({
        ...baseInput(),
        samples: SAMPLES.map((s, i) =>
          i === 0 ? { ...s, instanceIds: s.instanceIds.slice(1) } : s,
        ),
      }),
      ...codesOf({
        ...baseInput(),
        samples: buildProMaxSampleFamily({
          candidates: CORPUS.rows.map((row) => ({
            instanceId: String(row.instance_id),
            language: String(row.language),
          })),
          datasetRevision: "0".repeat(40),
        }),
      }),
      // a sample redrawn under another seed: no longer contained, chain broken
      ...codesOf({
        ...baseInput(),
        samples: [
          SAMPLES[0],
          buildProMaxSampleFamily({
            candidates: CORPUS.rows.map((row) => ({
              instanceId: String(row.instance_id),
              language: String(row.language),
            })),
            datasetRevision: PROMAX_V1_SNAPSHOT.hf_dataset_revision,
            seed: "a-different-seed",
          })[1],
          SAMPLES[2],
          SAMPLES[3],
        ] as ProMaxSampleManifest[],
      }),
      ...codesOf({
        ...baseInput(),
        continuationRule: { ...baseInput().continuationRule, text: "   ", minResolvedDelta: NaN },
      }),
      // parse-side codes
      ...(() => {
        const bad = parseProMaxCampaignRecord("{not json")
        return bad.ok ? [] : bad.failures.map((f) => f.code)
      })(),
      ...(() => {
        const record = freezeOk(baseInput())
        const doc = JSON.parse(serializeProMaxCampaignRecord(record)) as Record<string, unknown>
        doc.campaign_id = "renamed-after-the-fact"
        const bad = parseProMaxCampaignRecord(JSON.stringify(doc))
        return bad.ok ? [] : bad.failures.map((f) => f.code)
      })(),
    ])
    const orphan = PROMAX_CAMPAIGN_RECORD_FAILURE_CODES.filter((c) => !reachable.has(c))
    expect(orphan).toEqual([])
  })
})
