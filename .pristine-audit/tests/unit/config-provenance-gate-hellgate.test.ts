/**
 * HELLGATE — config-provenance gate (ADR-0470). SECURITY 🔴.
 *
 * Proves the supply-chain / privilege-escalation invariant: a REPO-controllable
 * source (`per-repo` checked-in policy OR agent `frontmatter`) may only NARROW,
 * never WIDEN, a grant-capable security axis — while TRUSTED sources
 * (`per-user`, `team-admin`, `default`) keep full grant authority.
 *
 *   - MALICIOUS per-repo tries to grant `approval.mode:"auto"` (AFK auto-approve)
 *     → dropped + `scalar-widen` telemetry; the merge never sees it.
 *   - MALICIOUS per-repo widens network egress (deny-all → allow-all) → dropped.
 *   - MALICIOUS per-repo APPENDS a host to the allow-list (same mode) →
 *     `allow-list-widen` drop (the set axis the scalar rank can't see).
 *   - MALICIOUS per-repo loosens the sandbox (workspaceWrite on / osSandbox none /
 *     readOnly off / networkIsolated off) → dropped.
 *   - MALICIOUS per-repo suppresses prompting (promptUser:false at same mode) →
 *     dropped (independent loosening axis).
 *   - FRONTMATTER provenance is treated identically to per-repo (telemetry names it).
 *   - LEGITIMATE grant by per-user / team-admin / default PASSES untouched.
 *   - DEFENSE-IN-DEPTH: a per-repo MORE-restrictive contribution is KEPT.
 *   - acknowledgedRisk:true OPT-OUT disables the guard (input passes through,
 *     same array reference, zero drops).
 *   - DETERMINISM + byte-identity: nothing-to-drop returns the SAME array ref.
 *   - DIFFERENTIAL MATRIX: every grant-capable field × all 4 sources.
 *
 * Pure unit test — no IO, no env, no LLM.
 */
import { describe, expect, test } from "bun:test"
import type { PermissionProfile } from "@/permission/permission-profile"
import {
  GRANT_CAPABLE_FIELDS,
  guardProvenance,
  isGrantCapableField,
  isRepoControllable,
  type ProvenancedLayer,
  type ProvenanceSource,
  REPO_CONTROLLABLE_SOURCES,
} from "@/permission/policy-layers/provenance-guard"

/* -------------------------------------------------------------------------- */
/* Fixtures — partial pillar values at known widen-ranks.                      */
/* -------------------------------------------------------------------------- */

const approvalWide: PermissionProfile["approval"] = { mode: "auto", promptUser: false }
const approvalStrict: PermissionProfile["approval"] = { mode: "always", promptUser: true }
const approvalSuppressOnly: PermissionProfile["approval"] = { mode: "always", promptUser: false }

const netWide: PermissionProfile["network"] = { mode: "allow-all" }
const netDeny: PermissionProfile["network"] = { mode: "deny-all" }
const netList = (hosts: string[]): PermissionProfile["network"] => ({
  mode: "allow-list",
  allowHosts: hosts,
})

const sandboxWide: PermissionProfile["sandbox"] = {
  osSandbox: "none",
  readOnly: false,
  workspaceWrite: true,
  networkIsolated: false,
}
const sandboxLocked: PermissionProfile["sandbox"] = {
  osSandbox: "seatbelt",
  readOnly: true,
  workspaceWrite: false,
  networkIsolated: true,
}

const layer = (source: ProvenanceSource, value: Partial<PermissionProfile>): ProvenancedLayer => ({
  source,
  value,
})

/* -------------------------------------------------------------------------- */
/* Closed-set sanity                                                          */
/* -------------------------------------------------------------------------- */

describe("provenance — closed sets", () => {
  test("only per-repo + frontmatter are repo-controllable", () => {
    expect([...REPO_CONTROLLABLE_SOURCES].sort()).toEqual(["frontmatter", "per-repo"])
    expect(isRepoControllable("per-repo")).toBe(true)
    expect(isRepoControllable("frontmatter")).toBe(true)
    expect(isRepoControllable("per-user")).toBe(false)
    expect(isRepoControllable("team-admin")).toBe(false)
    expect(isRepoControllable("default")).toBe(false)
  })

  test("grant-capable fields are exactly approval/network/sandbox", () => {
    expect([...GRANT_CAPABLE_FIELDS].sort()).toEqual(["approval", "network", "sandbox"])
    expect(isGrantCapableField("approval")).toBe(true)
    expect(isGrantCapableField("fileSystem")).toBe(false)
    expect(isGrantCapableField("control")).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/* Malicious repo widens — DROPPED                                            */
/* -------------------------------------------------------------------------- */

describe("repo widen → dropped + telemetry", () => {
  test("per-repo grants auto-mode over a trusted strict baseline → dropped", () => {
    const layers = [
      layer("per-user", { approval: approvalStrict }),
      layer("per-repo", { approval: approvalWide }),
    ]
    const r = guardProvenance(layers)
    // repo approval contribution removed
    const repo = r.layers.find((l) => l.source === "per-repo")
    expect(repo?.value.approval).toBeUndefined()
    // user contribution untouched
    expect(r.layers.find((l) => l.source === "per-user")?.value.approval).toEqual(approvalStrict)
    expect(r.dropped).toHaveLength(1)
    expect(r.dropped[0]).toMatchObject({
      kind: "scalar-widen",
      field: "approval",
      source: "per-repo",
    })
  })

  test("per-repo widens network egress → dropped", () => {
    const r = guardProvenance([
      layer("per-user", { network: netDeny }),
      layer("per-repo", { network: netWide }),
    ])
    expect(r.layers.find((l) => l.source === "per-repo")?.value.network).toBeUndefined()
    expect(r.dropped[0]).toMatchObject({
      kind: "scalar-widen",
      field: "network",
      source: "per-repo",
    })
  })

  test("per-repo appends a host to the allow-list at same mode → allow-list-widen drop", () => {
    const r = guardProvenance([
      layer("per-user", { network: netList(["api.internal"]) }),
      layer("per-repo", { network: netList(["api.internal", "evil.example.com"]) }),
    ])
    expect(r.layers.find((l) => l.source === "per-repo")?.value.network).toBeUndefined()
    expect(r.dropped[0]).toMatchObject({
      kind: "allow-list-widen",
      field: "network",
      source: "per-repo",
    })
  })

  test("per-repo loosens the sandbox → dropped", () => {
    const r = guardProvenance([
      layer("per-user", { sandbox: sandboxLocked }),
      layer("per-repo", { sandbox: sandboxWide }),
    ])
    expect(r.layers.find((l) => l.source === "per-repo")?.value.sandbox).toBeUndefined()
    expect(r.dropped[0]).toMatchObject({
      kind: "scalar-widen",
      field: "sandbox",
      source: "per-repo",
    })
  })

  test("per-repo TRADES sandbox protections (sum ≤ baseline, one axis loosened) → sandbox-axis-widen drop", () => {
    // Baseline (per-user) removes 2 protections (readOnly off + workspaceWrite on);
    // repo removes only 1 (networkIsolated off) so the SCALAR SUM is LOWER — a naive
    // sum compare would KEEP it. But repo turns OFF networkIsolated that the baseline
    // had LOCKED: a per-axis widen the sum can't see. Must be dropped.
    const baselineSandbox: PermissionProfile["sandbox"] = {
      osSandbox: "seatbelt",
      readOnly: false,
      workspaceWrite: true,
      networkIsolated: true,
    }
    const repoTradeSandbox: PermissionProfile["sandbox"] = {
      osSandbox: "seatbelt",
      readOnly: true,
      workspaceWrite: false,
      networkIsolated: false, // ← the smuggled widen
    }
    const r = guardProvenance([
      layer("per-user", { sandbox: baselineSandbox }),
      layer("per-repo", { sandbox: repoTradeSandbox }),
    ])
    expect(r.layers.find((l) => l.source === "per-repo")?.value.sandbox).toBeUndefined()
    expect(r.dropped[0]).toMatchObject({
      kind: "sandbox-axis-widen",
      field: "sandbox",
      source: "per-repo",
    })
  })

  test("per-repo loosens osSandbox to none while tightening other bits → sandbox-axis-widen drop", () => {
    const baselineSandbox: PermissionProfile["sandbox"] = {
      osSandbox: "seatbelt",
      readOnly: false,
      workspaceWrite: true,
      networkIsolated: false,
    }
    const repoDropOsSandbox: PermissionProfile["sandbox"] = {
      osSandbox: "none", // ← removes the OS sandbox
      readOnly: true,
      workspaceWrite: false,
      networkIsolated: true,
    }
    const r = guardProvenance([
      layer("per-user", { sandbox: baselineSandbox }),
      layer("per-repo", { sandbox: repoDropOsSandbox }),
    ])
    expect(r.layers.find((l) => l.source === "per-repo")?.value.sandbox).toBeUndefined()
    expect(r.dropped[0]?.kind).toBe("sandbox-axis-widen")
  })

  test("per-repo drops OS sandbox with no trusted peer → dropped against locked floor", () => {
    // No trusted layer sets sandbox → floor is the fully-locked sandbox. A repo
    // setting osSandbox:none (everything else locked) still loosens one axis.
    const r = guardProvenance([
      layer("per-repo", {
        sandbox: {
          osSandbox: "none",
          readOnly: true,
          workspaceWrite: false,
          networkIsolated: true,
        },
      }),
    ])
    // With no trusted peer the scalar floor (0 removed) catches the osSandbox
    // removal as a `scalar-widen` before the per-axis check; either way it drops.
    expect(r.layers[0]?.value.sandbox).toBeUndefined()
    const droppedKind = r.dropped[0]?.kind
    expect(droppedKind).toBeDefined()
    expect(["scalar-widen", "sandbox-axis-widen"]).toContain(droppedKind as string)
  })

  test("per-repo suppresses prompting at same mode → dropped (independent axis)", () => {
    const r = guardProvenance([
      layer("per-user", { approval: approvalStrict }),
      layer("per-repo", { approval: approvalSuppressOnly }),
    ])
    expect(r.layers.find((l) => l.source === "per-repo")?.value.approval).toBeUndefined()
    expect(r.dropped[0]).toMatchObject({ kind: "scalar-widen", field: "approval" })
  })

  test("frontmatter widen is treated identically to per-repo (telemetry names it)", () => {
    const r = guardProvenance([
      layer("per-user", { approval: approvalStrict }),
      layer("frontmatter", { approval: approvalWide }),
    ])
    expect(r.layers.find((l) => l.source === "frontmatter")?.value.approval).toBeUndefined()
    expect(r.dropped[0]?.source).toBe("frontmatter")
  })

  test("repo with NO trusted peer cannot bootstrap a grant from nothing", () => {
    // No per-user/team-admin/default sets approval → narrowest floor applies.
    const r = guardProvenance([layer("per-repo", { approval: approvalWide })])
    expect(r.layers[0]?.value.approval).toBeUndefined()
    expect(r.dropped[0]).toMatchObject({ kind: "scalar-widen", field: "approval" })
  })
})

/* -------------------------------------------------------------------------- */
/* Legitimate grants + defense-in-depth — KEPT                                */
/* -------------------------------------------------------------------------- */

describe("trusted grant + repo narrowing → kept", () => {
  test("per-user / team-admin / default grants pass untouched (same ref)", () => {
    const layers = [
      layer("default", { approval: approvalStrict }),
      layer("per-user", { approval: approvalWide }),
      layer("team-admin", { network: netWide }),
    ]
    const r = guardProvenance(layers)
    expect(r.dropped).toHaveLength(0)
    expect(r.layers).toBe(layers) // reference-identical ⇒ byte-identical merge
  })

  test("per-repo MORE-restrictive contribution is KEPT (defense-in-depth)", () => {
    const layers = [
      layer("per-user", { approval: approvalWide, network: netWide, sandbox: sandboxWide }),
      layer("per-repo", { approval: approvalStrict, network: netDeny, sandbox: sandboxLocked }),
    ]
    const r = guardProvenance(layers)
    expect(r.dropped).toHaveLength(0)
    const repo = r.layers.find((l) => l.source === "per-repo")
    expect(repo?.value.approval).toEqual(approvalStrict)
    expect(repo?.value.network).toEqual(netDeny)
    expect(repo?.value.sandbox).toEqual(sandboxLocked)
  })

  test("per-repo matching the baseline exactly is KEPT (no widen)", () => {
    const layers = [
      layer("per-user", { network: netList(["api.internal"]) }),
      layer("per-repo", { network: netList(["api.internal"]) }),
    ]
    const r = guardProvenance(layers)
    expect(r.dropped).toHaveLength(0)
  })

  test("per-repo deny-all with no trusted peer is KEPT (narrows to floor)", () => {
    const r = guardProvenance([layer("per-repo", { network: netDeny })])
    expect(r.dropped).toHaveLength(0)
    expect(r.layers[0]?.value.network).toEqual(netDeny)
  })

  test("per-repo fully-locked sandbox with no trusted peer is KEPT (matches the locked floor)", () => {
    const r = guardProvenance([layer("per-repo", { sandbox: sandboxLocked })])
    expect(r.dropped).toHaveLength(0)
    expect(r.layers[0]?.value.sandbox).toEqual(sandboxLocked)
  })

  test("non-grant pillars (fileSystem / control) pass through from a repo layer", () => {
    const repoVal: Partial<PermissionProfile> = {
      fileSystem: { type: "restricted", entries: [] },
      control: { auditRequired: false },
    }
    const r = guardProvenance([layer("per-repo", repoVal)])
    expect(r.dropped).toHaveLength(0)
    expect(r.layers[0]?.value).toEqual(repoVal)
  })
})

/* -------------------------------------------------------------------------- */
/* Mixed: widen one field, narrow another, in the same repo layer             */
/* -------------------------------------------------------------------------- */

describe("partial drop within one repo layer", () => {
  test("widening field dropped, narrowing field in same layer kept", () => {
    const layers = [
      layer("per-user", { approval: approvalStrict, sandbox: sandboxWide }),
      // approval widens (auto) → drop; sandbox narrows (locked) → keep
      layer("per-repo", { approval: approvalWide, sandbox: sandboxLocked }),
    ]
    const r = guardProvenance(layers)
    const repo = r.layers.find((l) => l.source === "per-repo")
    expect(repo?.value.approval).toBeUndefined()
    expect(repo?.value.sandbox).toEqual(sandboxLocked)
    expect(r.dropped).toHaveLength(1)
    expect(r.dropped[0]?.field).toBe("approval")
  })
})

/* -------------------------------------------------------------------------- */
/* acknowledgedRisk opt-out                                                   */
/* -------------------------------------------------------------------------- */

describe("acknowledgedRisk opt-out", () => {
  test("acknowledgedRisk:true disables the guard (passthrough, same ref, no drops)", () => {
    const layers = [
      layer("per-user", { approval: approvalStrict }),
      layer("per-repo", { approval: approvalWide }),
    ]
    const r = guardProvenance(layers, { acknowledgedRisk: true })
    expect(r.layers).toBe(layers)
    expect(r.dropped).toHaveLength(0)
    // the dangerous widen survives BECAUSE the operator explicitly opted out
    expect(r.layers.find((l) => l.source === "per-repo")?.value.approval).toEqual(approvalWide)
  })

  test("acknowledgedRisk:false (or absent) keeps the guard ON", () => {
    const layers = [
      layer("per-user", { approval: approvalStrict }),
      layer("per-repo", { approval: approvalWide }),
    ]
    expect(guardProvenance(layers, { acknowledgedRisk: false }).dropped).toHaveLength(1)
    expect(guardProvenance(layers, {}).dropped).toHaveLength(1)
    expect(guardProvenance(layers).dropped).toHaveLength(1)
  })
})

/* -------------------------------------------------------------------------- */
/* Determinism                                                                */
/* -------------------------------------------------------------------------- */

describe("determinism", () => {
  test("same inputs ⇒ deeply-equal output regardless of repeated calls", () => {
    const layers = [
      layer("per-user", { approval: approvalStrict, network: netDeny }),
      layer("per-repo", { approval: approvalWide, network: netWide, sandbox: sandboxLocked }),
      layer("team-admin", { sandbox: sandboxWide }),
    ]
    const a = guardProvenance(layers)
    const b = guardProvenance(layers)
    expect(a).toEqual(b)
  })
})

/* -------------------------------------------------------------------------- */
/* DIFFERENTIAL MATRIX: grant-capable field × source                          */
/* -------------------------------------------------------------------------- */

describe("differential matrix: field × source", () => {
  const widenValue: Record<string, Partial<PermissionProfile>> = {
    approval: { approval: approvalWide },
    network: { network: netWide },
    sandbox: { sandbox: sandboxWide },
  }
  const strictBaseline: Partial<PermissionProfile> = {
    approval: approvalStrict,
    network: netDeny,
    sandbox: sandboxLocked,
  }
  const allSources: ProvenanceSource[] = [
    "default",
    "per-user",
    "per-repo",
    "frontmatter",
    "team-admin",
  ]

  for (const field of GRANT_CAPABLE_FIELDS) {
    for (const source of allSources) {
      const shouldDrop = isRepoControllable(source)
      test(`${field} widen from ${source} → ${shouldDrop ? "DROPPED" : "KEPT"}`, () => {
        // A trusted strict baseline from a DIFFERENT trusted source, plus the
        // candidate widen from `source`. (When source itself is trusted, its
        // widen is a legitimate grant and must be kept.) Pick a baseline source
        // that differs from the candidate so each layer is uniquely findable.
        const baselineSource: ProvenanceSource = source === "team-admin" ? "default" : "team-admin"
        const layers = [
          layer(baselineSource, strictBaseline),
          layer(source, widenValue[field] as Partial<PermissionProfile>),
        ]
        const r = guardProvenance(layers)
        const candidate = r.layers.find((l) => l.source === source)
        if (shouldDrop) {
          expect((candidate?.value as Record<string, unknown>)[field]).toBeUndefined()
          expect(r.dropped.some((d) => d.field === field && d.source === source)).toBe(true)
        } else {
          expect((candidate?.value as Record<string, unknown>)[field]).toBeDefined()
          expect(r.dropped).toHaveLength(0)
        }
      })
    }
  }
})
