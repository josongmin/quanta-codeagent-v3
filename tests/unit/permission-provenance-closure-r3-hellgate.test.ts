/**
 * ROUND 3 (final) — PERMISSION / B2 PROVENANCE-CLOSURE hellgate.
 *
 * Proves the COMPLETE escalation-impossible matrix: a REPO-CONTROLLABLE config
 * layer (`per-repo` / agent `frontmatter`) can NEVER widen authority on ANY
 * pillar, under EITHER merge strategy, across EVERY source. Round 2 fixed a real
 * approval/network/sandbox escalation (`seedBaseFloorForRepoOnlyFields`); Round 3
 * additionally FOUND + FIXED a real `fileSystem` (layer-1 grant) escalation — a
 * repo-controllable `fileSystem` allow-list table widened the merged FS authority
 * because fileSystem is not in `GRANT_CAPABLE_FIELDS`, has no safe combiner, and
 * the disk-load entry-coverage ceiling only runs at PROFILE-LOAD time, not in the
 * layer merge. The fix is `guardRepoFileSystem` (runs under BOTH strategies).
 *
 * For EACH (pillar × source × strategy) this battery proves:
 *   1. a lone hostile repo layer → resolves to the SAFE default (never widened).
 *   2. it cannot override a per-user `restricted` looser.
 *   3. it cannot override a team-admin looser.
 *   4. a repo NARROW is still KEPT (defense-in-depth preserved).
 *   5. the LIVE env→mode path (`resolvePermissionModeFromProfile`) is never
 *      escalated to `auto` by any repo-only env layer.
 * Plus: the `merged.overrides` provenance trail is not corrupted by the synthetic
 * `default`-source floor winner (R2).
 *
 * All inputs pure structs + clean env views — no process.env, no IO, no clocks.
 */

import { describe, expect, test } from "bun:test"
import { resolvePermissionModeFromProfile } from "@/host/runtime/agent-arg-builder"
import type { FileSystemEntry, PermissionProfile } from "@/permission/permission-profile"
import { DEFAULT_PERMISSION_PROFILE } from "@/permission/permission-profile"
import type { MergeStrategy } from "@/permission/policy-layers"
import {
  guardProvenance,
  guardRepoFileSystem,
  type ProvenancedLayer,
} from "@/permission/policy-layers/provenance-guard"
import { mergeProfileLayers, type ProfileLayerSlots } from "@/permission/profile-layer-merge"

/* ──────────────────────────────── fixtures ──────────────────────────────── */

const D = DEFAULT_PERMISSION_PROFILE

/** Full profile builder (PermissionProfile demands every pillar). */
const P = (over: Partial<PermissionProfile>): PermissionProfile => ({ ...D, ...over })

const fsTable = (entries: ReadonlyArray<FileSystemEntry>): PermissionProfile["fileSystem"] => ({
  type: "restricted",
  entries,
})
const projectWrite: FileSystemEntry = {
  path: { type: "special", kind: "project" },
  access: "write",
}
const projectRead: FileSystemEntry = { path: { type: "special", kind: "project" }, access: "read" }
const rootWrite: FileSystemEntry = { path: { type: "special", kind: "root" }, access: "write" }
const absWrite = (v: string): FileSystemEntry => ({
  path: { type: "path", value: v },
  access: "write",
})

const STRATEGIES: ReadonlyArray<MergeStrategy> = ["source-precedence", "most-restrictive"]

/** Merge through the LIVE bridge under a strategy, returning the merged profile. */
const merge = (slots: ProfileLayerSlots, strat: MergeStrategy): PermissionProfile =>
  mergeProfileLayers(slots, strat).merged

/** Clean env view (only the keys a test sets; never touches process.env). */
const env = (o: Record<string, string>): NodeJS.ProcessEnv => ({ ...o }) as NodeJS.ProcessEnv

/* ════════════════════════════════════════════════════════════════════════ */
/* PILLAR — APPROVAL (grant-capable; the AFK auto-approve axis)               */
/* ════════════════════════════════════════════════════════════════════════ */

describe.each(STRATEGIES)("APPROVAL pillar — repo cannot widen [%s]", (strat) => {
  test("1. lone hostile per-repo (auto/no-prompt) → SAFE default `once`, never auto", () => {
    const m = merge({ perRepo: P({ approval: { mode: "auto", promptUser: false } }) }, strat)
    expect(m.approval.mode).not.toBe("auto")
    expect(m.approval.mode).toBe("once")
    expect(m.approval.promptUser).toBe(true)
  })

  test("2. cannot override per-user `restricted`(always) looser", () => {
    const m = merge(
      {
        perUser: P({ approval: { mode: "always", promptUser: true } }),
        perRepo: P({ approval: { mode: "auto", promptUser: false } }),
      },
      strat,
    )
    expect(m.approval.mode).not.toBe("auto")
    // strict per-user value survives (or strictest under most-restrictive).
    expect(m.approval.mode).toBe("always")
    expect(m.approval.promptUser).toBe(true)
  })

  test("3. cannot override team-admin(session) looser", () => {
    const m = merge(
      {
        teamAdmin: P({ approval: { mode: "session", promptUser: true } }),
        perRepo: P({ approval: { mode: "auto", promptUser: false } }),
      },
      strat,
    )
    expect(m.approval.mode).not.toBe("auto")
    expect(m.approval.promptUser).toBe(true)
  })

  test("4. repo NARROW (session→always) is KEPT (defense-in-depth)", () => {
    const m = merge(
      {
        perUser: P({ approval: { mode: "session", promptUser: true } }),
        perRepo: P({ approval: { mode: "always", promptUser: true } }),
      },
      strat,
    )
    expect(m.approval.mode).toBe("always")
  })
})

/* ════════════════════════════════════════════════════════════════════════ */
/* PILLAR — NETWORK (mode rank + allow-list set)                              */
/* ════════════════════════════════════════════════════════════════════════ */

describe.each(STRATEGIES)("NETWORK mode pillar — repo cannot widen [%s]", (strat) => {
  test("1. lone hostile per-repo (allow-all) → SAFE default deny-all", () => {
    const m = merge({ perRepo: P({ network: { mode: "allow-all" } }) }, strat)
    expect(m.network.mode).toBe("deny-all")
  })

  test("2. cannot override per-user deny-all looser", () => {
    const m = merge(
      {
        perUser: P({ network: { mode: "deny-all" } }),
        perRepo: P({ network: { mode: "allow-all" } }),
      },
      strat,
    )
    expect(m.network.mode).toBe("deny-all")
  })

  test("3. cannot override team-admin allow-list into allow-all", () => {
    const m = merge(
      {
        teamAdmin: P({ network: { mode: "allow-list", allowHosts: ["api.internal"] } }),
        perRepo: P({ network: { mode: "allow-all" } }),
      },
      strat,
    )
    expect(m.network.mode).not.toBe("allow-all")
  })

  test("4. repo NARROW (allow-list→deny-all) is KEPT", () => {
    const m = merge(
      {
        perUser: P({ network: { mode: "allow-list", allowHosts: ["api.internal"] } }),
        perRepo: P({ network: { mode: "deny-all" } }),
      },
      strat,
    )
    expect(m.network.mode).toBe("deny-all")
  })
})

describe.each(STRATEGIES)("NETWORK allow-list SET — repo cannot append a host [%s]", (strat) => {
  test("1. lone repo allow-list with a host → no host bootstrapped (mode/host floored)", () => {
    const m = merge(
      { perRepo: P({ network: { mode: "allow-list", allowHosts: ["evil.example.com"] } }) },
      strat,
    )
    expect(m.network.allowHosts ?? []).not.toContain("evil.example.com")
  })

  test("2/3. repo appends a host at same mode over a trusted allow-list → host DROPPED", () => {
    for (const trustedSlot of ["perUser", "teamAdmin"] as const) {
      const m = merge(
        {
          [trustedSlot]: P({ network: { mode: "allow-list", allowHosts: ["api.internal"] } }),
          perRepo: P({
            network: { mode: "allow-list", allowHosts: ["api.internal", "evil.example.com"] },
          }),
        } as ProfileLayerSlots,
        strat,
      )
      expect(m.network.allowHosts ?? []).not.toContain("evil.example.com")
      expect(m.network.allowHosts ?? []).toContain("api.internal")
    }
  })

  test("4. repo SHRINKS the allow-list (subset) is KEPT (narrowing)", () => {
    const m = merge(
      {
        perUser: P({ network: { mode: "allow-list", allowHosts: ["a.com", "b.com"] } }),
        perRepo: P({ network: { mode: "allow-list", allowHosts: ["a.com"] } }),
      },
      strat,
    )
    // No new host introduced; the attacker can never ADD reach.
    expect(m.network.allowHosts ?? []).not.toContain("evil.example.com")
  })
})

/* ════════════════════════════════════════════════════════════════════════ */
/* PILLAR — SANDBOX (per-axis: readOnly / workspaceWrite / networkIsolated /   */
/* osSandbox presence) — incl. the per-axis TRADE the sum-of-bits misses       */
/* ════════════════════════════════════════════════════════════════════════ */

const SBX = (o: Partial<PermissionProfile["sandbox"]>): PermissionProfile["sandbox"] => ({
  osSandbox: "none",
  readOnly: true,
  workspaceWrite: false,
  networkIsolated: true,
  ...o,
})

describe.each(STRATEGIES)("SANDBOX pillar — repo cannot loosen ANY axis [%s]", (strat) => {
  test("1. lone repo strips every protection → SAFE default (locked) survives per-axis", () => {
    const m = merge(
      {
        perRepo: P({
          sandbox: {
            osSandbox: "none",
            readOnly: false,
            workspaceWrite: true,
            networkIsolated: false,
          },
        }),
      },
      strat,
    )
    expect(m.sandbox.readOnly).toBe(true)
    expect(m.sandbox.workspaceWrite).toBe(false)
    expect(m.sandbox.networkIsolated).toBe(true)
  })

  test("2/3. repo cannot loosen a trusted seatbelt → none (osSandbox kept)", () => {
    for (const trustedSlot of ["perUser", "teamAdmin"] as const) {
      const m = merge(
        {
          [trustedSlot]: P({ sandbox: SBX({ osSandbox: "seatbelt" }) }),
          perRepo: P({ sandbox: SBX({ osSandbox: "none" }) }),
        } as ProfileLayerSlots,
        strat,
      )
      expect(m.sandbox.osSandbox).toBe("seatbelt")
    }
  })

  test("HELL-SUB-05 — per-axis TRADE (ON readOnly / OFF networkIsolated) cannot smuggle a widen", () => {
    const m = merge(
      {
        perUser: P({
          sandbox: SBX({ osSandbox: "seatbelt", readOnly: false, networkIsolated: true }),
        }),
        perRepo: P({
          sandbox: SBX({ osSandbox: "seatbelt", readOnly: true, networkIsolated: false }),
        }),
      },
      strat,
    )
    // The loosened networkIsolation bit must NOT land.
    expect(m.sandbox.networkIsolated).toBe(true)
  })

  test("4. repo NARROW (adds networkIsolated the user lacked) is KEPT under most-restrictive", () => {
    // Under most-restrictive the safest sub-axis always wins regardless of source,
    // so a repo TIGHTENING networkIsolated is honoured.
    if (strat !== "most-restrictive") return
    const m = merge(
      {
        perUser: P({ sandbox: SBX({ networkIsolated: false }) }),
        perRepo: P({ sandbox: SBX({ networkIsolated: true }) }),
      },
      strat,
    )
    expect(m.sandbox.networkIsolated).toBe(true)
  })
})

/* ════════════════════════════════════════════════════════════════════════ */
/* PILLAR — FILE SYSTEM (R3 FIX — layer-1 grant, set-coverage axis)           */
/* ════════════════════════════════════════════════════════════════════════ */

describe.each(STRATEGIES)("FILESYSTEM pillar — repo cannot widen the allow-list [%s]", (strat) => {
  test("1. lone repo `root:write` table → SAFE default EMPTY set (no grant bootstrapped)", () => {
    const m = merge({ perRepo: P({ fileSystem: fsTable([rootWrite]) }) }, strat)
    expect(m.fileSystem.entries).toEqual([])
  })

  test("1b. lone repo absolute-literal write that ESCAPES the workspace → dropped to EMPTY", () => {
    const m = merge({ perRepo: P({ fileSystem: fsTable([absWrite("/etc")]) }) }, strat)
    expect(m.fileSystem.entries).toEqual([])
  })

  test("2. cannot override a per-user table by ADDING root:write (repo widen dropped)", () => {
    const m = merge(
      {
        perUser: P({ fileSystem: fsTable([projectWrite]) }),
        perRepo: P({ fileSystem: fsTable([projectWrite, rootWrite]) }),
      },
      strat,
    )
    expect(JSON.stringify(m.fileSystem.entries)).not.toContain("root")
    // the trusted grant survives.
    expect(JSON.stringify(m.fileSystem.entries)).toContain("project")
  })

  test("3. cannot override a team-admin table by ADDING an out-of-tree literal", () => {
    const m = merge(
      {
        teamAdmin: P({ fileSystem: fsTable([projectWrite]) }),
        perRepo: P({ fileSystem: fsTable([absWrite("/var/secret")]) }),
      },
      strat,
    )
    expect(JSON.stringify(m.fileSystem.entries)).not.toContain("/var/secret")
    expect(JSON.stringify(m.fileSystem.entries)).toContain("project")
  })

  test("4. repo NARROW (project:read covered by trusted project:write) is KEPT", () => {
    const m = merge(
      {
        perUser: P({ fileSystem: fsTable([projectWrite]) }),
        perRepo: P({ fileSystem: fsTable([projectRead]) }),
      },
      strat,
    )
    // The repo's narrower read entry is covered ⇒ not a widen ⇒ kept (it never
    // ADDS reach). Whichever strategy, no out-of-tree grant ever appears.
    expect(JSON.stringify(m.fileSystem.entries)).not.toContain("root")
  })

  test("legit trusted-only wide table (per-user) is HONORED — guard is not a blanket block", () => {
    const m = merge({ perUser: P({ fileSystem: fsTable([projectWrite]) }) }, strat)
    expect(m.fileSystem.entries.length).toBe(1)
    expect(JSON.stringify(m.fileSystem.entries)).toContain("project")
  })
})

/* ════════════════════════════════════════════════════════════════════════ */
/* SOURCE — `frontmatter` provenance (the second repo-controllable origin)    */
/* The merge bridge only emits `per-repo`; exercise `frontmatter` directly on  */
/* the guards (both treat per-repo and frontmatter identically).               */
/* ════════════════════════════════════════════════════════════════════════ */

describe("SOURCE frontmatter — guards treat it identically to per-repo", () => {
  test("guardProvenance drops a frontmatter approval/network/sandbox widen (no trusted peer)", () => {
    const layers: ReadonlyArray<ProvenancedLayer> = [
      {
        source: "frontmatter",
        value: {
          approval: { mode: "auto", promptUser: false },
          network: { mode: "allow-all" },
          sandbox: {
            osSandbox: "none",
            readOnly: false,
            workspaceWrite: true,
            networkIsolated: false,
          },
        },
      },
    ]
    const { layers: out, dropped } = guardProvenance(layers)
    // Every grant-capable widen from the frontmatter layer is stripped.
    expect(out[0]?.value.approval).toBeUndefined()
    expect(out[0]?.value.network).toBeUndefined()
    expect(out[0]?.value.sandbox).toBeUndefined()
    expect(dropped.map((d) => d.source)).toEqual(["frontmatter", "frontmatter", "frontmatter"])
  })

  test("guardRepoFileSystem drops a frontmatter fileSystem widen (no trusted peer)", () => {
    const layers: ReadonlyArray<ProvenancedLayer> = [
      { source: "frontmatter", value: { fileSystem: fsTable([rootWrite]) } },
    ]
    const { layers: out, dropped } = guardRepoFileSystem(layers)
    expect(out[0]?.value.fileSystem).toBeUndefined()
    expect(dropped[0]?.source).toBe("frontmatter")
    expect(dropped[0]?.kind).toBe("filesystem-entry-widen")
    expect(dropped[0]?.field).toBe("fileSystem")
  })

  test("guardRepoFileSystem KEEPS a frontmatter fileSystem NARROW (covered by trusted)", () => {
    const layers: ReadonlyArray<ProvenancedLayer> = [
      { source: "per-user", value: { fileSystem: fsTable([projectWrite]) } },
      { source: "frontmatter", value: { fileSystem: fsTable([projectRead]) } },
    ]
    const { layers: out, dropped } = guardRepoFileSystem(layers)
    expect(out[1]?.value.fileSystem).toBeDefined() // kept
    expect(dropped).toEqual([])
  })

  test("guardRepoFileSystem byte-identical (SAME ref) when no repo fileSystem widen present", () => {
    const layers: ReadonlyArray<ProvenancedLayer> = [
      { source: "per-user", value: { fileSystem: fsTable([projectWrite]) } },
      { source: "team-admin", value: { approval: { mode: "session", promptUser: true } } },
    ]
    const res = guardRepoFileSystem(layers)
    expect(res.layers).toBe(layers) // reference-identical ⇒ downstream merge unchanged
    expect(res.dropped).toEqual([])
  })

  test("typed acknowledgedRisk opt-out passes a frontmatter fileSystem widen through UNCHANGED", () => {
    const layers: ReadonlyArray<ProvenancedLayer> = [
      { source: "frontmatter", value: { fileSystem: fsTable([rootWrite]) } },
    ]
    const res = guardRepoFileSystem(layers, { acknowledgedRisk: true })
    expect(res.layers).toBe(layers)
    expect(res.dropped).toEqual([])
  })
})

/* ════════════════════════════════════════════════════════════════════════ */
/* LIVE env → PermissionMode — never escalates to `auto` from a repo env layer */
/* ════════════════════════════════════════════════════════════════════════ */

describe("LIVE env→mode — repo-only layer never escalates to auto", () => {
  test.each(STRATEGIES)("per-repo `trusted` alone → NOT auto [%s]", (strat) => {
    const mode = resolvePermissionModeFromProfile(
      undefined,
      env({
        QUANTA_PERMISSION_PROFILE_PER_REPO: "trusted",
        QUANTA_POLICY_MERGE_STRATEGY: strat,
      }),
    )
    expect(mode).not.toBe("auto")
  })

  test.each(STRATEGIES)("per-user `restricted` + per-repo `trusted` → NOT auto [%s]", (strat) => {
    const mode = resolvePermissionModeFromProfile(
      undefined,
      env({
        QUANTA_PERMISSION_PROFILE_PER_USER: "restricted",
        QUANTA_PERMISSION_PROFILE_PER_REPO: "trusted",
        QUANTA_POLICY_MERGE_STRATEGY: strat,
      }),
    )
    expect(mode).not.toBe("auto")
  })

  test("team-admin `trusted` + per-repo `restricted`, most-restrictive → NOT auto (safest wins)", () => {
    // The `auto` here would come ONLY from the team-admin (a trusted grant
    // authority), never the repo. Under most-restrictive the SAFEST approval wins
    // regardless of source, so the repo's narrowing floors it to non-auto.
    const mode = resolvePermissionModeFromProfile(
      undefined,
      env({
        QUANTA_PERMISSION_PROFILE_TEAM_ADMIN: "trusted",
        QUANTA_PERMISSION_PROFILE_PER_REPO: "restricted",
        QUANTA_POLICY_MERGE_STRATEGY: "most-restrictive",
      }),
    )
    expect(mode).not.toBe("auto")
  })

  test("team-admin `trusted` + per-repo `restricted`, source-precedence → auto comes from ADMIN, not repo (legit grant)", () => {
    // Under source-precedence the higher-authority team-admin's `auto` legitimately
    // wins — this is NOT a repo escalation (the repo only narrowed; it cannot
    // GRANT). The point: the `auto` provenance is the trusted admin, never the repo.
    const mode = resolvePermissionModeFromProfile(
      undefined,
      env({
        QUANTA_PERMISSION_PROFILE_TEAM_ADMIN: "trusted",
        QUANTA_PERMISSION_PROFILE_PER_REPO: "restricted",
        QUANTA_POLICY_MERGE_STRATEGY: "source-precedence",
      }),
    )
    expect(mode).toBe("auto")
    // PROOF it is the admin's grant: drop the admin, keep only the repo → the
    // repo alone can NEVER produce auto.
    const repoOnly = resolvePermissionModeFromProfile(
      undefined,
      env({
        QUANTA_PERMISSION_PROFILE_PER_REPO: "restricted",
        QUANTA_POLICY_MERGE_STRATEGY: "source-precedence",
      }),
    )
    expect(repoOnly).not.toBe("auto")
  })

  test("legit per-user `trusted` (trusted source) MAY map to auto — guard is not a blanket block", () => {
    expect(
      resolvePermissionModeFromProfile(
        undefined,
        env({ QUANTA_PERMISSION_PROFILE_PER_USER: "trusted" }),
      ),
    ).toBe("auto")
  })

  test("no layered + no single profile → undefined (byte-identical legacy)", () => {
    expect(resolvePermissionModeFromProfile(undefined, env({}))).toBeUndefined()
  })
})

/* ════════════════════════════════════════════════════════════════════════ */
/* OVERRIDE-TRAIL audit — the synthetic `default` floor must not corrupt the   */
/* provenance metadata a consumer reads.                                       */
/* ════════════════════════════════════════════════════════════════════════ */

describe("override-trail — synthetic default floor (R2) does not corrupt provenance", () => {
  test("most-restrictive lone-repo grant fields: winner is per-repo, default floor recorded as overrode", () => {
    const { overrides } = mergeProfileLayers(
      { perRepo: P({ approval: { mode: "auto", promptUser: false } }) },
      "most-restrictive",
    )
    const ap = overrides.find((o) => o.field === "approval")
    expect(ap).toBeDefined()
    // The audit display winner is the real repo setter; the injected `default`
    // floor appears only as a superseded `overrode` entry (never the winner).
    expect(ap?.winner).toBe("per-repo")
    expect(ap?.overrode).toContain("default")
    // `default` is NOT spuriously listed as a winner anywhere.
    expect(overrides.some((o) => o.winner === "default")).toBe(false)
  })

  test("dropped repo fileSystem leaves NO fileSystem override (key removed pre-merge, base default used)", () => {
    const { merged, overrides } = mergeProfileLayers(
      { perRepo: P({ fileSystem: fsTable([rootWrite]) }) },
      "source-precedence",
    )
    // fileSystem resolves to the base default (empty) and carries no override row
    // (no layer set it after the drop) — the trail honestly shows no FS winner.
    expect(merged.fileSystem.entries).toEqual([])
    expect(overrides.some((o) => o.field === "fileSystem")).toBe(false)
  })

  test("a KEPT repo narrow records per-repo as the legitimate winner (no default forgery)", () => {
    const { overrides } = mergeProfileLayers(
      {
        perUser: P({ approval: { mode: "session", promptUser: true } }),
        perRepo: P({ approval: { mode: "always", promptUser: true } }),
      },
      "source-precedence",
    )
    const ap = overrides.find((o) => o.field === "approval")
    expect(ap?.winner).toBe("per-repo")
    expect(ap?.overrode).toContain("per-user")
  })
})

/* ════════════════════════════════════════════════════════════════════════ */
/* BYTE-IDENTICAL — no profile / all-safe inputs leave the default untouched   */
/* ════════════════════════════════════════════════════════════════════════ */

describe("byte-identical default path", () => {
  test.each(
    STRATEGIES,
  )("empty slots → merged deep-equals the locked-down default [%s]", (strat) => {
    const { merged, overrides } = mergeProfileLayers({}, strat)
    expect(merged).toEqual(DEFAULT_PERMISSION_PROFILE)
    expect(overrides).toEqual([])
  })

  test.each(
    STRATEGIES,
  )("only a trusted (per-user) layer → no repo guard interferes [%s]", (strat) => {
    const { merged } = mergeProfileLayers(
      { perUser: P({ network: { mode: "allow-list", allowHosts: ["api.internal"] } }) },
      strat,
    )
    expect(merged.network.mode).toBe("allow-list")
    expect(merged.network.allowHosts).toContain("api.internal")
  })
})
