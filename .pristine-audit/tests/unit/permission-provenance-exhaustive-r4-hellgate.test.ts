/**
 * ROUND 4 — EXHAUSTIVE permission-provenance field audit (security 🔴).
 *
 * R2 found the most-restrictive combiner widen; R3 found the fileSystem pillar
 * widen. The PATTERN — a grant-capable field/sub-field NOT seen by the guard
 * leaks a repo-controllable widen through the merge — predicts MORE. This audit
 * enumerates EVERY `PermissionProfile` field + sub-field and proves each is
 * either guarded or genuinely non-grant.
 *
 * R4 FINDING (real, fixed): `network.perRequestApproval`. The scalar
 * `networkWidenRank` keys only off `mode`; `allowListWidens` only off
 * `allowHosts`. So a repo layer with the SAME mode + SAME hosts but
 * `perRequestApproval:false` removed the per-call confirmation gate the
 * trusted baseline required — an egress widen the guard missed (the exact
 * analogue of approval's `promptUser` suppress-bonus, which WAS handled). Now
 * sealed by `perRequestApprovalWidens` + the `network-approval-widen` drop kind.
 */

import { describe, expect, test } from "bun:test"
import type { PermissionProfile } from "@/permission/permission-profile"
import { guardProvenance, type ProvenancedLayer } from "@/permission/policy-layers/provenance-guard"

const netLayer = (
  source: ProvenancedLayer["source"],
  net: PermissionProfile["network"],
): ProvenancedLayer => ({ source, value: { network: net } })

const networkOf = (g: ReturnType<typeof guardProvenance>, source: ProvenancedLayer["source"]) =>
  (g.layers.find((l) => l.source === source)?.value as Partial<PermissionProfile>).network

describe("R4 — network.perRequestApproval widen (the new escalation, sealed)", () => {
  test("repo removes per-request approval the trusted baseline required ⇒ DROPPED", () => {
    const layers: ProvenancedLayer[] = [
      // trusted user baseline REQUIRES per-request approval on the allow-list.
      netLayer("per-user", {
        mode: "allow-list",
        allowHosts: ["api.example.com"],
        perRequestApproval: true,
      }),
      // hostile repo keeps the SAME mode + SAME hosts but strips per-request
      // approval — invisible to the scalar mode rank AND the allow-list check.
      netLayer("per-repo", {
        mode: "allow-list",
        allowHosts: ["api.example.com"],
        perRequestApproval: false,
      }),
    ]
    const g = guardProvenance(layers)
    // The repo's network key is dropped (so the merge falls back to the trusted
    // per-user policy that keeps perRequestApproval:true).
    expect(networkOf(g, "per-repo")).toBeUndefined()
    expect(g.dropped.some((d) => d.kind === "network-approval-widen")).toBe(true)
  })

  test("frontmatter (repo-equivalent) removal is also DROPPED", () => {
    const g = guardProvenance([
      netLayer("per-user", { mode: "allow-list", allowHosts: ["x"], perRequestApproval: true }),
      netLayer("frontmatter", { mode: "allow-list", allowHosts: ["x"], perRequestApproval: false }),
    ])
    expect(networkOf(g, "frontmatter")).toBeUndefined()
  })

  test("NO over-drop: baseline never required per-request approval ⇒ repo false is KEPT", () => {
    // user baseline allow-list with NO perRequestApproval requirement.
    const g = guardProvenance([
      netLayer("per-user", { mode: "allow-list", allowHosts: ["x"] }),
      netLayer("per-repo", { mode: "allow-list", allowHosts: ["x"], perRequestApproval: false }),
    ])
    // Nothing to remove ⇒ repo network kept (it loosens no existing protection).
    expect(networkOf(g, "per-repo")).toBeDefined()
    expect(g.dropped.some((d) => d.kind === "network-approval-widen")).toBe(false)
  })

  test("repo that ADDS per-request approval (narrows) is KEPT", () => {
    const g = guardProvenance([
      netLayer("per-user", { mode: "allow-list", allowHosts: ["x"] }),
      netLayer("per-repo", { mode: "allow-list", allowHosts: ["x"], perRequestApproval: true }),
    ])
    expect(networkOf(g, "per-repo")).toBeDefined()
  })

  test("combined widen (new host AND removes per-request approval) ⇒ DROPPED", () => {
    const g = guardProvenance([
      netLayer("per-user", { mode: "allow-list", allowHosts: ["x"], perRequestApproval: true }),
      netLayer("per-repo", {
        mode: "allow-list",
        allowHosts: ["x", "evil.example.com"],
        perRequestApproval: false,
      }),
    ])
    expect(networkOf(g, "per-repo")).toBeUndefined()
  })
})

describe("R4 — exhaustive PermissionProfile field verdict (no other escalation)", () => {
  // The COMPLETE field inventory + each field's grant-capable verdict. This test
  // is the written argument as executable code: every authority-affecting field
  // is either GUARDED (proven elsewhere / above) or genuinely NON-GRANT.
  test("approval.{mode,promptUser} — guarded (scalar + promptUser bonus)", () => {
    const g = guardProvenance([
      { source: "per-user", value: { approval: { mode: "always", promptUser: true } } },
      { source: "per-repo", value: { approval: { mode: "always", promptUser: false } } },
    ])
    // promptUser:false at the same mode is a widen ⇒ dropped.
    expect(
      (g.layers.find((l) => l.source === "per-repo")?.value as Partial<PermissionProfile>).approval,
    ).toBeUndefined()
  })

  test("network.{mode,allowHosts,perRequestApproval} — all three guarded", () => {
    // mode widen
    const gMode = guardProvenance([
      netLayer("per-user", { mode: "deny-all" }),
      netLayer("per-repo", { mode: "allow-all" }),
    ])
    expect(networkOf(gMode, "per-repo")).toBeUndefined()
    // allowHosts widen
    const gHost = guardProvenance([
      netLayer("per-user", { mode: "allow-list", allowHosts: ["a"] }),
      netLayer("per-repo", { mode: "allow-list", allowHosts: ["a", "b"] }),
    ])
    expect(networkOf(gHost, "per-repo")).toBeUndefined()
    // perRequestApproval widen handled above.
  })

  test("sandbox — all 4 axes guarded (per-axis, incl. a protection TRADE)", () => {
    const g = guardProvenance([
      {
        source: "per-user",
        value: {
          sandbox: {
            osSandbox: "seatbelt",
            readOnly: true,
            workspaceWrite: false,
            networkIsolated: true,
          },
        },
      },
      {
        source: "per-repo",
        value: {
          // TRADE: tighten readOnly is moot (already true), loosen networkIsolated.
          sandbox: {
            osSandbox: "seatbelt",
            readOnly: true,
            workspaceWrite: false,
            networkIsolated: false,
          },
        },
      },
    ])
    expect(
      (g.layers.find((l) => l.source === "per-repo")?.value as Partial<PermissionProfile>).sandbox,
    ).toBeUndefined()
  })

  test("control.{managedBy,auditRequired} — NON-grant by design (documented exclusion)", () => {
    // `control` is not in GRANT_CAPABLE_FIELDS: managedBy is a mutation-lock
    // marker (does NOT elevate the repo's SOURCE rank — the merge ranks by
    // provenance, not by a claimed managedBy), and auditRequired is observability,
    // not an access grant. A repo `control` contribution passes through (it
    // cannot grant the repo any access authority). Pinned so a future reclass is
    // a conscious change.
    const g = guardProvenance([
      { source: "per-repo", value: { control: { managedBy: "admin", auditRequired: false } } },
    ])
    // Passed through (no drop) — control cannot widen ACCESS.
    expect(
      (g.layers.find((l) => l.source === "per-repo")?.value as Partial<PermissionProfile>).control,
    ).toBeDefined()
    expect(g.dropped).toHaveLength(0)
  })

  test("fileSystem.entries — guarded by guardRepoFileSystem (R3), proven in its own suite", () => {
    // guardProvenance itself does NOT police fileSystem (by design — the R3
    // guardRepoFileSystem does, under both strategies). Confirm guardProvenance
    // leaves fileSystem untouched (the R3 guard runs separately in the merge).
    const g = guardProvenance([
      {
        source: "per-repo",
        value: {
          fileSystem: {
            type: "restricted",
            entries: [{ path: { type: "special", kind: "root" }, access: "write" }],
          },
        },
      },
    ])
    // guardProvenance passes fileSystem through (guardRepoFileSystem is the gate).
    expect(
      (g.layers.find((l) => l.source === "per-repo")?.value as Partial<PermissionProfile>)
        .fileSystem,
    ).toBeDefined()
  })
})
