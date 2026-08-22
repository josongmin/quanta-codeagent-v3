/**
 * `policy-merge` knob → layered-profile-merge → permission resolution —
 * INTEGRATION hellgate (DETERMINISTIC; no Math.random, no network, no fs).
 *
 * Proves the `QUANTA_POLICY_MERGE_STRATEGY` knob deterministically changes a
 * REAL effective permission DECISION through the production code path, not just
 * the pure merge fn:
 *
 *   HELL-PMK-01  knob parse: only the 2 canonical strategies resolve; everything
 *                else (typo / case / empty / absent) ⇒ undefined (fail-to-unset)
 *   HELL-PMK-02  knob apply: sets AgentConfig.policyMergeStrategy on its surfaces;
 *                off-surface ⇒ cfg untouched (===)
 *   HELL-PMK-03  env→strategy resolver: "most-restrictive" only; else
 *                source-precedence (default preserves current behavior)
 *   HELL-PMK-04  env→layered-slots resolver: absent ⇒ undefined (legacy single
 *                wire); any one layered var present ⇒ slots; fail-closed on typo
 *   HELL-PMK-05  LIVE permission MODE flips by strategy — per-repo overrides
 *                per-user under source-precedence; most-restrictive picks safer.
 *                Uses the EXACT production `resolvePermissionModeFromProfile`.
 *   HELL-PMK-06  REAL TwoLayerManager resolution honours the MERGED fileSystem —
 *                the merged profile (from the production env path) registered
 *                into a live manager produces the access DECISION the merge
 *                dictates (allow vs deny), per strategy.
 *   HELL-PMK-07  absent knob + absent layered vars ⇒ mode resolution byte-
 *                identical to the legacy single-profile path.
 */

import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import {
  resolveLayeredProfileSlots,
  resolvePermissionModeFromProfile,
  resolvePolicyMergeStrategy,
} from "@/apps/agent"
import {
  createCachedResolver,
  createTwoLayerManager,
  DEFAULT_FILE_SYSTEM_SANDBOX_POLICY,
  type FileSystemEntry,
  type FileSystemSandboxPolicy,
  mergeProfileLayers,
  NAMED_PROFILES,
} from "@/permission"
import { policyMergeKnob } from "@/runner/knobs/knobs/policy-merge"

const env = (vars: Record<string, string>): NodeJS.ProcessEnv => vars as NodeJS.ProcessEnv

const mkResolver = () =>
  createCachedResolver({
    os: { family: () => "darwin", tmpdir: () => "/var/folders/T" },
    cwd: { cwd: () => "/repo", projectRoot: () => "/repo" },
    git: { gitDir: () => undefined },
  })

const sandboxWith = (entries: FileSystemEntry[]): FileSystemSandboxPolicy => ({
  type: "restricted",
  entries,
})

/* ------------------------------- knob shape -------------------------------- */

describe("policy-merge knob — parse/apply", () => {
  test("HELL-PMK-01 only canonical strategies parse", () => {
    expect(policyMergeKnob.parse("source-precedence")).toEqual({ strategy: "source-precedence" })
    expect(policyMergeKnob.parse("most-restrictive")).toEqual({ strategy: "most-restrictive" })
    // whitespace tolerated
    expect(policyMergeKnob.parse("  most-restrictive  ")).toEqual({ strategy: "most-restrictive" })
    for (const bad of [
      undefined,
      "",
      "   ",
      "Source-Precedence",
      "MOST-RESTRICTIVE",
      "source_precedence",
      "strict",
      "0",
      "true",
    ]) {
      expect(policyMergeKnob.parse(bad)).toBeUndefined()
    }
  })

  test("HELL-PMK-02 apply sets field on surface, no-op off-surface", () => {
    const base = { foo: 1 } as unknown as AgentConfig
    for (const surface of policyMergeKnob.surfaces) {
      const out = policyMergeKnob.apply(base, { strategy: "most-restrictive" }, { surface })
      expect(out).not.toBe(base)
      expect(out.policyMergeStrategy).toBe("most-restrictive")
    }
    // `bench` is NOT a policy-merge surface ⇒ untouched identity.
    const off = policyMergeKnob.apply(base, { strategy: "most-restrictive" }, { surface: "bench" })
    expect(off).toBe(base)
    expect(off.policyMergeStrategy).toBeUndefined()
  })
})

/* --------------------------- env resolvers (prod) -------------------------- */

describe("policy-merge — env resolvers (production path)", () => {
  test("HELL-PMK-03 env→strategy: most-restrictive only, else source-precedence", () => {
    expect(
      resolvePolicyMergeStrategy(env({ QUANTA_POLICY_MERGE_STRATEGY: "most-restrictive" })),
    ).toBe("most-restrictive")
    for (const v of ["source-precedence", "", "typo", "MOST-RESTRICTIVE"]) {
      expect(resolvePolicyMergeStrategy(env({ QUANTA_POLICY_MERGE_STRATEGY: v }))).toBe(
        "source-precedence",
      )
    }
    expect(resolvePolicyMergeStrategy(env({}))).toBe("source-precedence")
  })

  test("HELL-PMK-04 env→layered slots: absent ⇒ undefined; present ⇒ slots; fail-closed", () => {
    expect(resolveLayeredProfileSlots(env({}))).toBeUndefined()
    const slots = resolveLayeredProfileSlots(
      env({
        QUANTA_PERMISSION_PROFILE_PER_USER: "trusted",
        QUANTA_PERMISSION_PROFILE_TEAM_ADMIN: "restricted",
      }),
    )
    expect(slots?.perUser).toEqual(NAMED_PROFILES.trusted)
    expect(slots?.teamAdmin).toEqual(NAMED_PROFILES.restricted)
    expect(slots?.perRepo).toBeUndefined()
    // FAIL-CLOSED: a typo'd layered profile name THROWS (no permissive fallback).
    expect(() =>
      resolveLayeredProfileSlots(env({ QUANTA_PERMISSION_PROFILE_PER_REPO: "bogus" })),
    ).toThrow()
  })
})

/* ----------------------- LIVE permission-mode flip ------------------------- */

describe("policy-merge — knob flips the LIVE permission decision", () => {
  // per-user = trusted (approval auto ⇒ context "auto"); per-repo = restricted
  // (approval always ⇒ context "default"). per-repo OUTRANKS per-user.
  const LAYERED = {
    QUANTA_PERMISSION_PROFILE_PER_USER: "trusted",
    QUANTA_PERMISSION_PROFILE_PER_REPO: "restricted",
  }

  test("HELL-PMK-05 source-precedence: per-repo overrides per-user; most-restrictive: safer", () => {
    // source-precedence: per-repo (restricted, approval=always) wins ⇒ "default".
    const sp = resolvePermissionModeFromProfile(
      undefined,
      env({ ...LAYERED, QUANTA_POLICY_MERGE_STRATEGY: "source-precedence" }),
    )
    expect(sp).toBe("default")

    // most-restrictive: restricted's approval (always, safest) wins regardless
    // of authority ⇒ still "default". To OBSERVE the strategy flipping the
    // winner, swap authority: put the SAFE profile at LOW authority.
    const flipped = {
      QUANTA_PERMISSION_PROFILE_PER_USER: "restricted", // safe, LOW authority
      QUANTA_PERMISSION_PROFILE_TEAM_ADMIN: "trusted", // unsafe, HIGH authority
    }
    const spFlip = resolvePermissionModeFromProfile(
      undefined,
      env({ ...flipped, QUANTA_POLICY_MERGE_STRATEGY: "source-precedence" }),
    )
    // source-precedence: team-admin (trusted, approval=auto) wins ⇒ "auto".
    expect(spFlip).toBe("auto")
    const mrFlip = resolvePermissionModeFromProfile(
      undefined,
      env({ ...flipped, QUANTA_POLICY_MERGE_STRATEGY: "most-restrictive" }),
    )
    // most-restrictive: restricted's safer approval wins despite LOW authority ⇒ "default".
    expect(mrFlip).toBe("default")
    // The knob deterministically CHANGED the live decision for the SAME inputs.
    expect(spFlip).not.toBe(mrFlip)
  })

  test("HELL-PMK-07 absent knob + absent layered vars ⇒ legacy single-profile path", () => {
    // Single profile only ⇒ layered path NOT taken; mode derived from it directly.
    expect(
      resolvePermissionModeFromProfile(undefined, env({ QUANTA_PERMISSION_PROFILE: "trusted" })),
    ).toBe("auto")
    expect(
      resolvePermissionModeFromProfile(undefined, env({ QUANTA_PERMISSION_PROFILE: "restricted" })),
    ).toBe("default")
    // Nothing set ⇒ undefined (caller keeps acceptEdits default — byte-identical).
    expect(resolvePermissionModeFromProfile(undefined, env({}))).toBeUndefined()
  })
})

/* ------------------- REAL TwoLayerManager FS resolution -------------------- */

describe("policy-merge — merged profile drives a REAL TwoLayerManager", () => {
  test("HELL-PMK-06 merged fileSystem honoured by a live manager (allow vs deny)", () => {
    // Production env path: per-user trusted (grants project=/repo write),
    // team-admin restricted (empty FS). Resolve EXACTLY as buildBaseFromArgs does.
    const slots = resolveLayeredProfileSlots(
      env({
        QUANTA_PERMISSION_PROFILE_PER_USER: "trusted",
        QUANTA_PERMISSION_PROFILE_TEAM_ADMIN: "restricted",
      }),
    )
    if (slots === undefined) throw new Error("expected layered slots")

    // Under source-precedence, team-admin (restricted, empty FS) OUTRANKS
    // per-user ⇒ merged fileSystem is EMPTY ⇒ a real manager DENIES.
    const spMerged = mergeProfileLayers(slots, resolvePolicyMergeStrategy(env({}))).merged
    const mDeny = createTwoLayerManager()
    mDeny.setPermissionProfile("t", spMerged)
    // Grant the OS-sandbox layer so the DENY is attributable to the merged profile.
    mDeny.setFileSystemSandboxPolicy(
      "t",
      sandboxWith([{ path: { type: "special", kind: "project" }, access: "write" }]),
    )
    const denyVerdict = mDeny.getEffectiveAccess("t", "/repo/src/x.ts", "write", mkResolver())
    expect(denyVerdict.decidedBy).toBe("profile-and-sandbox")
    expect(denyVerdict.allow).toBe(false) // empty merged FS denies

    // Now invert authority: per-user restricted (empty), team-admin trusted
    // (grants project write). Under source-precedence team-admin wins fileSystem
    // ⇒ merged FS grants /repo write ⇒ a real manager ALLOWS.
    const grantSlots = resolveLayeredProfileSlots(
      env({
        QUANTA_PERMISSION_PROFILE_PER_USER: "restricted",
        QUANTA_PERMISSION_PROFILE_TEAM_ADMIN: "trusted",
      }),
    )
    if (grantSlots === undefined) throw new Error("expected layered slots")
    const grantMerged = mergeProfileLayers(grantSlots, "source-precedence").merged
    const mAllow = createTwoLayerManager()
    mAllow.setPermissionProfile("t", grantMerged)
    mAllow.setFileSystemSandboxPolicy(
      "t",
      sandboxWith([{ path: { type: "special", kind: "project" }, access: "write" }]),
    )
    const allowVerdict = mAllow.getEffectiveAccess("t", "/repo/src/x.ts", "write", mkResolver())
    expect(allowVerdict.decidedBy).toBe("profile-and-sandbox")
    expect(allowVerdict.allow).toBe(true) // merged trusted FS grants /repo write

    // The two REAL manager resolutions diverge purely from the merged profile
    // the layered engine produced — proving the wire reaches the live gate.
    expect(denyVerdict.allow).not.toBe(allowVerdict.allow)

    // Sanity: a manager fed the LOCKED-DOWN default sandbox (empty) denies even
    // the grant case — the merge feeds layer-1; layer-2 still ANDs (no bypass).
    const mAnd = createTwoLayerManager()
    mAnd.setPermissionProfile("t", grantMerged)
    mAnd.setFileSystemSandboxPolicy("t", DEFAULT_FILE_SYSTEM_SANDBOX_POLICY)
    expect(mAnd.getEffectiveAccess("t", "/repo/src/x.ts", "write", mkResolver()).allow).toBe(false)
  })
})
