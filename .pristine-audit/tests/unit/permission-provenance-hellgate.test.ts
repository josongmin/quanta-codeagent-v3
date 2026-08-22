/**
 * HELLGATE — config-provenance supply-chain hole, END-TO-END (ADR-0470). SECURITY 🔴.
 *
 * The sibling `config-provenance-gate-hellgate.test.ts` seals the PRE-MERGE
 * filter (`guardProvenance`) in ISOLATION. This battery proves the property that
 * actually matters operationally: the supply-chain hole stays CLOSED once the
 * guard is COMPOSED with the `mergeLayered` engine that ranks
 * `team-admin > per-repo > per-user > default`.
 *
 * The bug it pins: under `source-precedence` the merge picks the
 * most-authoritative SETTER, and `per-repo` out-ranks `per-user`. A checked-in
 * malicious `.quanta` (or agent frontmatter) is `per-repo`, so WITHOUT the guard
 * a hostile clone could overwrite the user's strict posture WHOLESALE — grant
 * `approval.mode:"auto"` (AFK auto-approve), widen network egress, or strip the
 * sandbox. The guard must run BEFORE the merge so the engine never even sees the
 * untrusted widen; the user's authoritative value must survive into `merged`.
 *
 * Invariant proven here (pipeline = guardProvenance ∘ mergeLayered):
 *   - per-repo grant of auto-mode is NEVER reflected in the merged result; the
 *     user's strict approval survives.  ← canonical case, pinned hard.
 *   - per-repo widen of network / sandbox is NEVER reflected; the trusted value
 *     survives.
 *   - per-repo / frontmatter that NARROWS is honored end-to-end (defense-in-depth).
 *   - per-user / team-admin grants flow through untouched (trusted grant authority).
 *   - default is the floor a repo may match but not exceed (no bootstrap-from-nothing).
 *   - holds under BOTH merge strategies (source-precedence AND most-restrictive):
 *     even if a future caller picks most-restrictive and forgets a per-field
 *     ranker (⇒ source-precedence fallback), the pre-merge guard already removed
 *     the widen, so the fallback can no longer leak it.
 *
 * Pure unit test — no IO, no env, no LLM.
 */
import { describe, expect, test } from "bun:test"
import type { PermissionProfile } from "@/permission/permission-profile"
import {
  type ConfigLayer,
  type LayerSource,
  type MergeStrategy,
  mergeLayered,
  type RestrictivenessSpec,
} from "@/permission/policy-layers"
import {
  guardProvenance,
  type ProvenancedLayer,
  type ProvenanceSource,
} from "@/permission/policy-layers/provenance-guard"

/* -------------------------------------------------------------------------- */
/* Pillar fixtures at known widen-ranks (strict = safe, wide = dangerous).     */
/* -------------------------------------------------------------------------- */

const approvalStrict: PermissionProfile["approval"] = { mode: "always", promptUser: true }
const approvalAuto: PermissionProfile["approval"] = { mode: "auto", promptUser: false }

const netDeny: PermissionProfile["network"] = { mode: "deny-all" }
const netAll: PermissionProfile["network"] = { mode: "allow-all" }
const netList = (hosts: string[]): PermissionProfile["network"] => ({
  mode: "allow-list",
  allowHosts: hosts,
})

const sandboxLocked: PermissionProfile["sandbox"] = {
  osSandbox: "seatbelt",
  readOnly: true,
  workspaceWrite: false,
  networkIsolated: true,
}
const sandboxOpen: PermissionProfile["sandbox"] = {
  osSandbox: "none",
  readOnly: false,
  workspaceWrite: true,
  networkIsolated: false,
}

const controlBase: PermissionProfile["control"] = { auditRequired: false }
const fsBase: PermissionProfile["fileSystem"] = { type: "restricted", entries: [] }

/**
 * A complete, SAFE base profile (the shipped `default` floor) so `mergeLayered`
 * can return a complete `PermissionProfile` for any field no layer sets.
 */
const BASE_PROFILE: PermissionProfile = {
  fileSystem: fsBase,
  approval: approvalStrict,
  network: netDeny,
  sandbox: sandboxLocked,
  control: controlBase,
}

const pl = (source: ProvenanceSource, value: Partial<PermissionProfile>): ProvenancedLayer => ({
  source,
  value,
})

/* -------------------------------------------------------------------------- */
/* Pipeline: guardProvenance → mergeLayered (the real composition shape).       */
/* -------------------------------------------------------------------------- */

/**
 * Map a guard `ProvenanceSource` to the coarser merge `LayerSource`. The guard
 * distinguishes `frontmatter` from `per-repo` for TELEMETRY only; both share the
 * `per-repo` authority RANK in the merge engine, so a composition root collapses
 * `frontmatter → per-repo` before handing the layers to `mergeLayered`. This
 * mirrors exactly the production wiring and keeps the merge's source union intact.
 */
const toLayerSource = (s: ProvenanceSource): LayerSource => (s === "frontmatter" ? "per-repo" : s)

/**
 * The end-to-end pipeline a real caller runs: filter repo-controllable widens
 * FIRST, then merge what survives. Returns both the merged profile and the
 * guard's drop telemetry so a test can assert "dropped AND not reflected".
 */
const resolve = (
  layers: ReadonlyArray<ProvenancedLayer>,
  strategy: MergeStrategy = "source-precedence",
  restrictiveness?: RestrictivenessSpec<PermissionProfile>,
) => {
  const guarded = guardProvenance(layers)
  const configLayers: Array<ConfigLayer<PermissionProfile>> = guarded.layers.map((l) => ({
    source: toLayerSource(l.source),
    value: l.value,
  }))
  const merged = mergeLayered(configLayers, {
    base: BASE_PROFILE,
    strategy,
    ...(restrictiveness !== undefined ? { restrictiveness } : {}),
  })
  return { merged: merged.merged, overrides: merged.overrides, dropped: guarded.dropped }
}

/* -------------------------------------------------------------------------- */
/* THE canonical hole: per-repo grants auto-mode over the user's strict policy. */
/* -------------------------------------------------------------------------- */

describe("supply-chain hole — per-repo auto-mode grant (canonical)", () => {
  test("per-repo auto-mode is NEVER reflected in the merged profile; user strict survives", () => {
    // Without the guard, source-precedence would let per-repo (rank 2) overwrite
    // per-user (rank 1) → merged.approval == auto. The guard must prevent that.
    const { merged, dropped } = resolve([
      pl("per-user", { approval: approvalStrict }),
      pl("per-repo", { approval: approvalAuto }),
    ])
    expect(merged.approval).toEqual(approvalStrict) // user's strict value won
    expect(merged.approval.mode).not.toBe("auto") // auto NEVER from a repo
    expect(dropped.some((d) => d.field === "approval" && d.source === "per-repo")).toBe(true)
  })

  test("auto-mode cannot be bootstrapped by per-repo with NO trusted approval peer", () => {
    // No per-user/team-admin sets approval → floor (BASE strict) applies. A repo
    // auto grant is dropped, so merged falls back to the safe BASE approval.
    const { merged, dropped } = resolve([pl("per-repo", { approval: approvalAuto })])
    expect(merged.approval.mode).not.toBe("auto")
    expect(merged.approval).toEqual(BASE_PROFILE.approval)
    expect(dropped.some((d) => d.field === "approval")).toBe(true)
  })

  test("frontmatter auto-mode grant is dropped end-to-end exactly like per-repo", () => {
    const { merged, dropped } = resolve([
      pl("per-user", { approval: approvalStrict }),
      pl("frontmatter", { approval: approvalAuto }),
    ])
    expect(merged.approval).toEqual(approvalStrict)
    expect(dropped.some((d) => d.source === "frontmatter" && d.field === "approval")).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* per-repo widens network / sandbox → never reflected.                        */
/* -------------------------------------------------------------------------- */

describe("supply-chain hole — per-repo network / sandbox widen", () => {
  test("per-repo deny-all→allow-all is not reflected; user deny-all survives", () => {
    const { merged, dropped } = resolve([
      pl("per-user", { network: netDeny }),
      pl("per-repo", { network: netAll }),
    ])
    expect(merged.network).toEqual(netDeny)
    expect(dropped.some((d) => d.field === "network")).toBe(true)
  })

  test("per-repo appends an egress host (same mode) → not reflected; user host-set survives", () => {
    const { merged, dropped } = resolve([
      pl("per-user", { network: netList(["api.internal"]) }),
      pl("per-repo", { network: netList(["api.internal", "evil.example.com"]) }),
    ])
    expect(merged.network).toEqual(netList(["api.internal"]))
    expect(merged.network.allowHosts).not.toContain("evil.example.com")
    expect(dropped.some((d) => d.kind === "allow-list-widen")).toBe(true)
  })

  test("per-repo strips the sandbox → not reflected; user locked sandbox survives", () => {
    const { merged, dropped } = resolve([
      pl("per-user", { sandbox: sandboxLocked }),
      pl("per-repo", { sandbox: sandboxOpen }),
    ])
    expect(merged.sandbox).toEqual(sandboxLocked)
    expect(dropped.some((d) => d.field === "sandbox")).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* Defense-in-depth: per-repo NARROWS → honored end-to-end.                    */
/* -------------------------------------------------------------------------- */

describe("defense-in-depth — per-repo narrowing is honored through the merge", () => {
  test("per-repo tightens approval over a loose per-user → repo value wins (no drop)", () => {
    // per-user grants auto (legitimate — user is trusted). per-repo tightens to
    // always. Repo NARROWS, so it is KEPT, and source-precedence (repo > user)
    // applies its tightened value. Result is SAFER than the user asked for.
    const { merged, dropped } = resolve([
      pl("per-user", { approval: approvalAuto }),
      pl("per-repo", { approval: approvalStrict }),
    ])
    expect(merged.approval).toEqual(approvalStrict)
    expect(dropped).toHaveLength(0)
  })

  test("per-repo narrows network to deny-all over a user allow-all → deny-all wins", () => {
    const { merged, dropped } = resolve([
      pl("per-user", { network: netAll }),
      pl("per-repo", { network: netDeny }),
    ])
    expect(merged.network).toEqual(netDeny)
    expect(dropped).toHaveLength(0)
  })

  test("per-repo locks a sandbox the user left open → locked wins", () => {
    const { merged, dropped } = resolve([
      pl("per-user", { sandbox: sandboxOpen }),
      pl("per-repo", { sandbox: sandboxLocked }),
    ])
    expect(merged.sandbox).toEqual(sandboxLocked)
    expect(dropped).toHaveLength(0)
  })
})

/* -------------------------------------------------------------------------- */
/* Trusted grant authority — per-user / team-admin / default flow through.     */
/* -------------------------------------------------------------------------- */

describe("trusted grant authority preserved through the merge", () => {
  test("per-user auto-mode grant is honored (user is the legitimate grant authority)", () => {
    const { merged, dropped } = resolve([
      pl("default", { approval: approvalStrict }),
      pl("per-user", { approval: approvalAuto }),
    ])
    expect(merged.approval).toEqual(approvalAuto)
    expect(dropped).toHaveLength(0)
  })

  test("team-admin widen out-ranks a per-user value and is honored (admin authority)", () => {
    const { merged, dropped } = resolve([
      pl("per-user", { network: netDeny }),
      pl("team-admin", { network: netAll }),
    ])
    expect(merged.network).toEqual(netAll)
    expect(dropped).toHaveLength(0)
  })

  test("default floor is respected: no layer sets a field ⇒ base value is used", () => {
    const { merged } = resolve([pl("per-user", { network: netList(["x"]) })])
    // approval/sandbox untouched by any layer ⇒ taken from BASE_PROFILE.
    expect(merged.approval).toEqual(BASE_PROFILE.approval)
    expect(merged.sandbox).toEqual(BASE_PROFILE.sandbox)
  })
})

/* -------------------------------------------------------------------------- */
/* Strategy invariance: hole stays closed under BOTH merge strategies.         */
/* -------------------------------------------------------------------------- */

describe("hole closed under both merge strategies", () => {
  // SAFER = always (highest). A scalar ranker for approval under most-restrictive.
  const approvalRank: RestrictivenessSpec<PermissionProfile> = {
    approval: (v) => ({ always: 3, session: 2, once: 1, auto: 0 })[v.mode],
  }

  for (const strategy of ["source-precedence", "most-restrictive"] as const) {
    test(`per-repo auto-mode widen is never reflected under ${strategy}`, () => {
      const { merged, dropped } = resolve(
        [pl("per-user", { approval: approvalStrict }), pl("per-repo", { approval: approvalAuto })],
        strategy,
        approvalRank,
      )
      expect(merged.approval.mode).not.toBe("auto")
      expect(merged.approval).toEqual(approvalStrict)
      expect(dropped.some((d) => d.field === "approval")).toBe(true)
    })

    test(`per-repo network widen is never reflected under ${strategy} (no ranker ⇒ source-prec fallback)`, () => {
      // Network has NO ranker here, so under most-restrictive it falls back to
      // source-precedence where per-repo out-ranks per-user — the EXACT path the
      // bug lived on. The pre-merge guard must already have removed the widen.
      const { merged, dropped } = resolve(
        [pl("per-user", { network: netDeny }), pl("per-repo", { network: netAll })],
        strategy,
        approvalRank,
      )
      expect(merged.network).toEqual(netDeny)
      expect(dropped.some((d) => d.field === "network")).toBe(true)
    })

    test(`per-repo narrowing is still honored under ${strategy}`, () => {
      const { merged, dropped } = resolve(
        [pl("per-user", { approval: approvalAuto }), pl("per-repo", { approval: approvalStrict })],
        strategy,
        approvalRank,
      )
      // Under most-restrictive the SAFER (always) wins regardless of source;
      // under source-precedence the kept (narrowing) repo value wins. Either way
      // the result is the strict value — never auto.
      expect(merged.approval).toEqual(approvalStrict)
      expect(dropped).toHaveLength(0)
    })
  }
})

/* -------------------------------------------------------------------------- */
/* Mixed layer: widen one pillar, narrow another, in the SAME repo layer.       */
/* -------------------------------------------------------------------------- */

describe("partial drop within one repo layer flows correctly into the merge", () => {
  test("repo approval-widen dropped + repo sandbox-narrow kept, both reflected correctly", () => {
    const { merged, dropped } = resolve([
      pl("per-user", { approval: approvalStrict, sandbox: sandboxOpen }),
      // approval widens (auto → drop) but sandbox narrows (locked → keep).
      pl("per-repo", { approval: approvalAuto, sandbox: sandboxLocked }),
    ])
    expect(merged.approval).toEqual(approvalStrict) // widen dropped → user value
    expect(merged.sandbox).toEqual(sandboxLocked) // narrow kept → repo value
    expect(dropped).toHaveLength(1)
    expect(dropped[0]?.field).toBe("approval")
  })

  test("non-grant pillars (fileSystem / control) from a repo layer flow through untouched", () => {
    const repoFs: PermissionProfile["fileSystem"] = {
      type: "restricted",
      entries: [{ path: { type: "special", kind: "project" }, access: "read" }],
    }
    const { merged, dropped } = resolve([pl("per-repo", { fileSystem: repoFs })])
    expect(merged.fileSystem).toEqual(repoFs)
    expect(dropped).toHaveLength(0)
  })
})

/* -------------------------------------------------------------------------- */
/* Determinism of the composed pipeline.                                       */
/* -------------------------------------------------------------------------- */

describe("pipeline determinism", () => {
  test("same inputs ⇒ deeply-equal merged result across repeated runs and layer orders", () => {
    const layers = [
      pl("per-user", { approval: approvalStrict, network: netDeny }),
      pl("per-repo", { approval: approvalAuto, network: netAll, sandbox: sandboxLocked }),
      pl("team-admin", { sandbox: sandboxOpen }),
    ]
    const a = resolve(layers)
    const b = resolve([...layers].reverse())
    // The merge is order-independent for DISTINCT sources, and the guard is pure;
    // the merged profile must be identical regardless of declaration order.
    expect(a.merged).toEqual(b.merged)
  })
})
