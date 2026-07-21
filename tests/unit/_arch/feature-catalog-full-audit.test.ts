import { describe, expect, test } from "bun:test"
import {
  buildAuditSnapshot,
  priorityFor,
  validateAuditState,
} from "../../../tools/feature-catalog/full-audit/model"
import { digestAuditInputs } from "../../../tools/feature-catalog/full-audit/provenance"
import { AuditRecordSchema } from "../../../tools/feature-catalog/full-audit/schema"
import type { LoadedFeature } from "../../../tools/feature-catalog/schema"

const feature = (id: string, maturity: "L2" | "L3" | "L4" = "L3"): LoadedFeature => ({
  path: `tools/feature-catalog/features/01-agent-loop/${id}.yaml`,
  feature: {
    id,
    title: id,
    section: 1,
    subsystem: "test",
    order: 0,
    maturity,
    status: "stable",
    owners: ["@owner"],
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
    purpose: id,
    evidence: {
      code: [`src/${id}.ts`],
      adrs: [],
      tests: { unit: [], integration: [], contract: [] },
    },
    knobs: [],
    deliberate_hold: null,
  },
})

const inputDigests = () =>
  digestAuditInputs({
    catalog: [{ path: "tools/feature-catalog/features/01-agent-loop/a.yaml", content: "id: a\n" }],
    defaultOffLedger: "rows: []\n",
    baseline: "{}\n",
  })

describe("feature catalog full-audit", () => {
  test("priority is P0 reachability, P1 default-OFF, P2 L4+, then P3", () => {
    expect(priorityFor(feature("dead").feature, new Set(), new Set(["dead"]))).toBe("P0")
    expect(priorityFor(feature("off").feature, new Set(["off"]), new Set())).toBe("P1")
    expect(priorityFor(feature("strong", "L4").feature, new Set(), new Set())).toBe("P2")
    expect(priorityFor(feature("rest").feature, new Set(), new Set())).toBe("P3")
  })

  test("snapshot freezes every feature exactly once with priority counts", () => {
    const snapshot = buildAuditSnapshot({
      features: [feature("a"), feature("b", "L4")],
      defaultOffIds: new Set(["a"]),
      reachabilityGrandfatheredIds: new Set(),
      snapshotHead: "a".repeat(40),
      createdAt: "2026-07-19",
      inputDigests: inputDigests(),
    })
    expect(snapshot.catalog_total).toBe(2)
    expect(snapshot.priority_counts).toEqual({ P0: 0, P1: 1, P2: 1, P3: 0 })
  })

  test("PASS refuses missing consumer and ON efficacy proof", () => {
    const result = AuditRecordSchema.safeParse({
      version: 1,
      feature_id: "a",
      snapshot_head: "a".repeat(40),
      status: "closed",
      owner_seam: "src/a.ts",
      entrypoints: ["src/main.ts"],
      activation: [],
      effective_defaults: { cli: "off", web: "na", bench: "na", headless: "na", daemon: "na" },
      producer: ["src/a.ts:a"],
      consumer: [],
      reachable: "yes",
      surface_findings: ["cli audited"],
      off_identity_proof: null,
      on_efficacy_proof: null,
      failure_posture: "na",
      security_posture: "na",
      observability: "na",
      verdict: "pass",
      blocker: null,
      disposition: "keep",
      receipts: [
        {
          kind: "source",
          command: "rg a src",
          revision: "abcdef0",
          result: "pass",
          evidence: "live call",
        },
      ],
      audited_at: "2026-07-19",
      auditor: "a",
      review_state: "approved",
      reviewer: "b",
    })
    expect(result.success).toBe(false)
  })

  test("default-OFF PASS requires separate OFF proof", () => {
    const snapshot = buildAuditSnapshot({
      features: [feature("a")],
      defaultOffIds: new Set(["a"]),
      reachabilityGrandfatheredIds: new Set(),
      snapshotHead: "a".repeat(40),
      createdAt: "2026-07-19",
      inputDigests: inputDigests(),
    })
    const record = AuditRecordSchema.parse({
      version: 1,
      feature_id: "a",
      snapshot_head: "a".repeat(40),
      status: "closed",
      owner_seam: "src/a.ts",
      entrypoints: ["src/main.ts"],
      activation: ["ENV_A"],
      effective_defaults: { cli: "off", web: "na", bench: "na", headless: "na", daemon: "na" },
      producer: ["src/a.ts:a"],
      consumer: ["src/main.ts:run"],
      reachable: "yes",
      surface_findings: ["cli full"],
      off_identity_proof: null,
      on_efficacy_proof: {
        kind: "test",
        command: "bun test a",
        revision: "abcdef0",
        result: "pass",
        evidence: "effect observed",
      },
      failure_posture: "fail-closed",
      security_posture: "na",
      observability: "na",
      verdict: "pass",
      blocker: null,
      disposition: "keep",
      receipts: [
        {
          kind: "test",
          command: "bun test a",
          revision: "abcdef0",
          result: "pass",
          evidence: "effect observed",
        },
      ],
      audited_at: "2026-07-19",
      auditor: "a",
      review_state: "approved",
      reviewer: "b",
    })
    const report = validateAuditState(snapshot, [record], new Set(["a"]), inputDigests())
    expect(report.errors).toContain("default-OFF PASS lacks OFF identity proof: a")
  })

  test("snapshot provenance rejects a catalog mutation even when feature IDs match", () => {
    const snapshot = buildAuditSnapshot({
      features: [feature("a")],
      defaultOffIds: new Set(),
      reachabilityGrandfatheredIds: new Set(),
      snapshotHead: "a".repeat(40),
      createdAt: "2026-07-19",
      inputDigests: inputDigests(),
    })
    const mutations = [
      {
        field: "catalog_yaml",
        inputs: {
          catalog: [
            {
              path: "tools/feature-catalog/features/01-agent-loop/a.yaml",
              content: "id: a\nmaturity: L2\n",
            },
          ],
          defaultOffLedger: "rows: []\n",
          baseline: "{}\n",
        },
      },
      {
        field: "default_off_ledger",
        inputs: {
          catalog: [
            { path: "tools/feature-catalog/features/01-agent-loop/a.yaml", content: "id: a\n" },
          ],
          defaultOffLedger: "rows:\n  - feature_id: a\n",
          baseline: "{}\n",
        },
      },
      {
        field: "baseline",
        inputs: {
          catalog: [
            { path: "tools/feature-catalog/features/01-agent-loop/a.yaml", content: "id: a\n" },
          ],
          defaultOffLedger: "rows: []\n",
          baseline: '{"fc":{"l3_reachability_grandfathered":["a"]}}\n',
        },
      },
    ] as const
    for (const mutation of mutations) {
      const report = validateAuditState(
        snapshot,
        [],
        new Set(["a"]),
        digestAuditInputs(mutation.inputs),
      )
      expect(report.errors).toEqual([`audit snapshot input digest mismatch: ${mutation.field}`])
    }
  })

  test("non-runtime verdict cannot claim production reachability", () => {
    const result = AuditRecordSchema.safeParse({
      version: 1,
      feature_id: "policy-doc",
      snapshot_head: "a".repeat(40),
      status: "closed",
      owner_seam: "docs/decisions/0001-policy.md",
      entrypoints: [],
      activation: ["human review"],
      effective_defaults: { cli: "na", web: "na", bench: "na", headless: "na", daemon: "na" },
      producer: ["docs/decisions/0001-policy.md"],
      consumer: [],
      reachable: "yes",
      surface_findings: ["documentation only"],
      off_identity_proof: null,
      on_efficacy_proof: null,
      failure_posture: "na",
      security_posture: "na",
      observability: "na",
      verdict: "non-runtime",
      blocker: null,
      disposition: "keep",
      receipts: [
        {
          kind: "source",
          command: "test -f docs/decisions/0001-policy.md",
          revision: "abcdef0",
          result: "pass",
          evidence: "document exists",
        },
      ],
      audited_at: "2026-07-19",
      auditor: "a",
      review_state: "pending",
      reviewer: null,
    })
    expect(result.success).toBe(false)
  })
})
