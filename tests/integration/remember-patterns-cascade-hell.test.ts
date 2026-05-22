/**
 * HELL-GATE for the L4 cascade-on-approval wiring (ADR-0061 absorb #2).
 *
 * Coverage:
 *   K-1   User approves a call carrying `rememberPatterns` ⇒ patterns folded
 *         into the store ⇒ `onPatternCascade` fires with `user_accept` source.
 *   K-2   Pending requests fully covered by the just-granted set show up in
 *         `cascadedToolCallIds`.
 *   K-3   Pending requests with PARTIAL coverage do NOT cascade.
 *   K-4   A dangerous (`isMaybeDangerous`) approved call does NOT cascade
 *         unless `permissionAllowDangerous: true`.
 *   K-5   Pattern store ABSENT ⇒ `onPatternCascade` is NEVER fired (default-OFF).
 *   K-6   `rememberPatterns` empty / undefined ⇒ no cascade.
 *   K-7   Approval through the always-confirm tier AND through the mode-policy
 *         ask branch BOTH trigger the cascade (both code paths covered).
 *   K-8   `onConfirm` returning a `deny_and_steer` decision does NOT trigger
 *         the cascade (refusal must not grant patterns).
 *   K-9   The cascade notification carries the classifier `suggestedAllowlistEntry`
 *         for the action key (so a UI can offer "grant pattern" not "grant literal").
 *   K-10  SECOND identical call with the same patterns auto-passes (round-trip:
 *         user-grant → cascade → autoPassByPatterns short-circuit).
 *   K-11  Cycle / repeated grants — idempotent (same patterns granted twice
 *         do not produce duplicate cascade entries).
 *   K-12  Concurrent gate runs do not cross-contaminate the cascade signal.
 */
import { describe, expect, test } from "bun:test"
import { z } from "zod"
import {
  type AdmissibilityAction,
  type AdmissibilityWaveAOptions,
  runAdmissibilityGate,
} from "@/agent/admissibility-gate"
import type { AgentConfig } from "@/agent/types"
import type { ToolUseBlock } from "@/llm"
import {
  type HITLTier,
  PatternGrantStore,
  type PendingPermission,
  type PermissionContext,
} from "@/permission"
import { type Tool, ToolRegistry } from "@/tool"

const bashShell: Tool = {
  name: "bash",
  description: "shell",
  inputSchema: z.object({ command: z.string() }) as z.ZodType<unknown>,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  extractShellCommand: (input: unknown) => {
    const parsed = input as { command?: unknown }
    return typeof parsed?.command === "string" ? parsed.command : null
  },
  execute: async function* () {
    yield { type: "result", result: { ok: true, output: "ran" } }
  },
}

const annotateHitl = (tool: Tool, tier: HITLTier): Tool => {
  const out = { ...tool } as Tool & { hitlTier?: (i: unknown) => HITLTier }
  out.hitlTier = () => tier
  return out
}

const call = (command: string, id = "c1"): ToolUseBlock => ({
  type: "tool_use",
  id,
  name: "bash",
  input: { command },
})

const action = (
  command: string,
  extras: Partial<AdmissibilityAction> = {},
): AdmissibilityAction => ({
  tool: "bash",
  input: { command },
  isReadOnly: false,
  ...extras,
})

const cfg = (over: Partial<AgentConfig>): AgentConfig =>
  ({
    cwd: "/repo",
    signal: new AbortController().signal,
    permission: { mode: "default" } as PermissionContext,
    ...over,
  }) as AgentConfig

interface CascadeCapture {
  calls: Array<{
    grantedPatterns: readonly string[]
    cascadedToolCallIds: readonly string[]
    learningSource: string
    suggestedAllowlistEntry: string | null
  }>
}

const captureOpts = (capture: CascadeCapture): AdmissibilityWaveAOptions => ({
  onPatternCascade: (info) => {
    capture.calls.push({
      grantedPatterns: info.grantedPatterns,
      cascadedToolCallIds: info.cascadedToolCallIds,
      learningSource: info.learningSource,
      suggestedAllowlistEntry: info.suggestedAllowlistEntry,
    })
  },
})

describe("cascade-on-approval — HELL", () => {
  test("K-1: user approves a call with rememberPatterns ⇒ store gets grant + cascade fires", async () => {
    const store = new PatternGrantStore()
    const capture: CascadeCapture = { calls: [] }
    const registry = new ToolRegistry([annotateHitl(bashShell, "always-confirm")])
    const c = cfg({
      registry,
      hitl: { enabled: true },
      permissionPatternStore: store,
      onConfirm: async () => true,
    })
    const r = await runAdmissibilityGate(
      call("git status"),
      c,
      { mode: "default" },
      action("git status", { rememberPatterns: ["bash:git status"] }),
      undefined,
      captureOpts(capture),
    )
    expect(r).toBeNull()
    expect(capture.calls.length).toBe(1)
    expect(capture.calls[0]?.grantedPatterns).toEqual(["bash:git status"])
    expect(capture.calls[0]?.learningSource).toBe("user_accept")
    expect(store.isCovered(["bash:git status"])).toBe(true)
  })

  test("K-2: pending requests fully covered are reported in cascadedToolCallIds", async () => {
    const store = new PatternGrantStore()
    const capture: CascadeCapture = { calls: [] }
    const registry = new ToolRegistry([annotateHitl(bashShell, "always-confirm")])
    const pending: PendingPermission[] = [
      {
        toolCallId: "queued-1",
        rememberPatterns: ["bash:git status"],
        suggestedPermissions: [],
        isMaybeDangerous: false,
      },
      {
        toolCallId: "queued-2",
        rememberPatterns: ["bash:git status", "bash:git log"],
        suggestedPermissions: [],
        isMaybeDangerous: false,
      },
    ]
    const c = cfg({
      registry,
      hitl: { enabled: true },
      permissionPatternStore: store,
      onConfirm: async () => true,
    })
    await runAdmissibilityGate(
      call("git status"),
      c,
      { mode: "default" },
      action("git status", { rememberPatterns: ["bash:git status"] }),
      undefined,
      { ...captureOpts(capture), pendingPermissions: pending },
    )
    expect(capture.calls.length).toBe(1)
    expect(capture.calls[0]?.cascadedToolCallIds).toEqual(["queued-1"])
  })

  test("K-3: partial coverage does NOT cascade", async () => {
    const store = new PatternGrantStore()
    const capture: CascadeCapture = { calls: [] }
    const registry = new ToolRegistry([annotateHitl(bashShell, "always-confirm")])
    const pending: PendingPermission[] = [
      {
        toolCallId: "needs-both",
        rememberPatterns: ["bash:a", "bash:b"],
        suggestedPermissions: [],
        isMaybeDangerous: false,
      },
    ]
    const c = cfg({
      registry,
      hitl: { enabled: true },
      permissionPatternStore: store,
      onConfirm: async () => true,
    })
    await runAdmissibilityGate(
      call("a"),
      c,
      { mode: "default" },
      action("a", { rememberPatterns: ["bash:a"] }),
      undefined,
      { ...captureOpts(capture), pendingPermissions: pending },
    )
    expect(capture.calls.length).toBe(1)
    expect(capture.calls[0]?.cascadedToolCallIds).toEqual([])
  })

  test("K-4: dangerous approved call does NOT cascade unless allowDangerous", async () => {
    const store = new PatternGrantStore()
    const capture: CascadeCapture = { calls: [] }
    const registry = new ToolRegistry([annotateHitl(bashShell, "always-confirm")])
    const c = cfg({
      registry,
      hitl: { enabled: true },
      permissionPatternStore: store,
      onConfirm: async () => true,
    })
    await runAdmissibilityGate(
      call("dangerous"),
      c,
      { mode: "default" },
      action("dangerous", { rememberPatterns: ["bash:dangerous"], isMaybeDangerous: true }),
      undefined,
      captureOpts(capture),
    )
    // No cascade — dangerous gate blocks pattern adoption without operator override.
    expect(capture.calls.length).toBe(0)

    // Now opt in: cascade fires.
    const c2 = cfg({
      registry,
      hitl: { enabled: true },
      permissionPatternStore: store,
      permissionAllowDangerous: true,
      onConfirm: async () => true,
    })
    await runAdmissibilityGate(
      call("dangerous", "c2"),
      c2,
      { mode: "default" },
      action("dangerous", { rememberPatterns: ["bash:dangerous"], isMaybeDangerous: true }),
      undefined,
      captureOpts(capture),
    )
    expect(capture.calls.length).toBe(1)
  })

  test("K-5: pattern store ABSENT ⇒ onPatternCascade is NEVER fired", async () => {
    const capture: CascadeCapture = { calls: [] }
    const registry = new ToolRegistry([annotateHitl(bashShell, "always-confirm")])
    const c = cfg({
      registry,
      hitl: { enabled: true },
      // no permissionPatternStore
      onConfirm: async () => true,
    })
    await runAdmissibilityGate(
      call("git status"),
      c,
      { mode: "default" },
      action("git status", { rememberPatterns: ["bash:git status"] }),
      undefined,
      captureOpts(capture),
    )
    expect(capture.calls.length).toBe(0)
  })

  test("K-6: empty rememberPatterns ⇒ no cascade", async () => {
    const store = new PatternGrantStore()
    const capture: CascadeCapture = { calls: [] }
    const registry = new ToolRegistry([annotateHitl(bashShell, "always-confirm")])
    const c = cfg({
      registry,
      hitl: { enabled: true },
      permissionPatternStore: store,
      onConfirm: async () => true,
    })
    await runAdmissibilityGate(
      call("git status"),
      c,
      { mode: "default" },
      action("git status", { rememberPatterns: [] }),
      undefined,
      captureOpts(capture),
    )
    expect(capture.calls.length).toBe(0)
  })

  test("K-7: cascade fires on BOTH the always-confirm tier AND the mode-policy ask branch", async () => {
    const store = new PatternGrantStore()
    const capture: CascadeCapture = { calls: [] }
    // Path A: always-confirm tier (HITL enabled)
    const registryA = new ToolRegistry([annotateHitl(bashShell, "always-confirm")])
    const cA = cfg({
      registry: registryA,
      hitl: { enabled: true },
      permissionPatternStore: store,
      onConfirm: async () => true,
    })
    await runAdmissibilityGate(
      call("git status"),
      cA,
      { mode: "default" },
      action("git status", { rememberPatterns: ["bash:git status"] }),
      undefined,
      captureOpts(capture),
    )
    // Path B: mode-policy ask branch (mutating tool, default mode ⇒ policy asks)
    const registryB = new ToolRegistry([bashShell])
    const cB = cfg({
      registry: registryB,
      // no hitl
      permissionPatternStore: store,
      onConfirm: async () => true,
    })
    await runAdmissibilityGate(
      call("git log", "c2"),
      cB,
      { mode: "default" },
      action("git log", { rememberPatterns: ["bash:git log"] }),
      undefined,
      captureOpts(capture),
    )
    expect(capture.calls.length).toBe(2)
    expect(capture.calls[0]?.grantedPatterns).toEqual(["bash:git status"])
    expect(capture.calls[1]?.grantedPatterns).toEqual(["bash:git log"])
  })

  test("K-8: deny_and_steer does NOT trigger cascade (refusal must not grant)", async () => {
    const store = new PatternGrantStore()
    const capture: CascadeCapture = { calls: [] }
    const registry = new ToolRegistry([annotateHitl(bashShell, "always-confirm")])
    const c = cfg({
      registry,
      hitl: { enabled: true },
      permissionPatternStore: store,
      onConfirm: async () => ({ decision: "deny_and_steer", steer: "do it differently" }),
    })
    const r = await runAdmissibilityGate(
      call("git status"),
      c,
      { mode: "default" },
      action("git status", { rememberPatterns: ["bash:git status"] }),
      undefined,
      captureOpts(capture),
    )
    expect(r?.preview).toBe("deny_steer")
    expect(capture.calls.length).toBe(0)
    expect(store.isCovered(["bash:git status"])).toBe(false)
  })

  test("K-9: cascade carries the classifier suggestedAllowlistEntry", async () => {
    const store = new PatternGrantStore()
    const capture: CascadeCapture = { calls: [] }
    const registry = new ToolRegistry([annotateHitl(bashShell, "always-confirm")])
    const c = cfg({
      registry,
      hitl: { enabled: true },
      permissionPatternStore: store,
      onConfirm: async () => true,
    })
    await runAdmissibilityGate(
      call("npm install --save-dev typescript"),
      c,
      { mode: "default" },
      action("npm install --save-dev typescript", {
        rememberPatterns: ["bash:npm install --save-dev typescript"],
      }),
      undefined,
      captureOpts(capture),
    )
    expect(capture.calls.length).toBe(1)
    expect(capture.calls[0]?.suggestedAllowlistEntry).toBe("npm,install")
  })

  test("K-10: SECOND identical call auto-passes via the pattern store", async () => {
    const store = new PatternGrantStore()
    const capture: CascadeCapture = { calls: [] }
    const registry = new ToolRegistry([annotateHitl(bashShell, "always-confirm")])
    let onConfirmCalls = 0
    const c = cfg({
      registry,
      hitl: { enabled: true },
      permissionPatternStore: store,
      onConfirm: async () => {
        onConfirmCalls += 1
        return true
      },
    })
    // First call: asks, grants, store now covers the pattern.
    await runAdmissibilityGate(
      call("ls"),
      c,
      { mode: "default" },
      action("ls", { rememberPatterns: ["bash:ls"] }),
      undefined,
      captureOpts(capture),
    )
    expect(onConfirmCalls).toBe(1)

    // Second call: identical patterns, auto-pass short-circuits before HITL.
    await runAdmissibilityGate(
      call("ls", "c2"),
      c,
      { mode: "default" },
      action("ls", { rememberPatterns: ["bash:ls"] }),
      undefined,
      captureOpts(capture),
    )
    expect(onConfirmCalls).toBe(1) // still 1 — auto-passed
  })

  test("K-11: repeated grants are idempotent — second grant doesn't duplicate", async () => {
    const store = new PatternGrantStore()
    const capture: CascadeCapture = { calls: [] }
    const registry = new ToolRegistry([annotateHitl(bashShell, "always-confirm")])
    const c = cfg({
      registry,
      hitl: { enabled: true },
      permissionPatternStore: store,
      onConfirm: async () => true,
    })
    // Grant the same pattern twice.
    await runAdmissibilityGate(
      call("ls"),
      c,
      { mode: "default" },
      action("ls", { rememberPatterns: ["bash:ls"] }),
      undefined,
      captureOpts(capture),
    )
    await runAdmissibilityGate(
      call("ls", "c2"),
      c,
      { mode: "default" },
      action("ls", { rememberPatterns: ["bash:ls"] }),
      undefined,
      captureOpts(capture),
    )
    // The store stays consistent.
    expect(store.granted().size).toBe(1)
  })

  test("K-12: concurrent gate runs do not cross-contaminate", async () => {
    const store = new PatternGrantStore()
    const capture: CascadeCapture = { calls: [] }
    const registry = new ToolRegistry([annotateHitl(bashShell, "always-confirm")])
    const c = cfg({
      registry,
      hitl: { enabled: true },
      permissionPatternStore: store,
      onConfirm: async () => true,
    })
    const promises = Array.from({ length: 5 }, (_, i) =>
      runAdmissibilityGate(
        call(`cmd-${i}`, `c${i}`),
        c,
        { mode: "default" },
        action(`cmd-${i}`, { rememberPatterns: [`bash:cmd-${i}`] }),
        undefined,
        captureOpts(capture),
      ),
    )
    await Promise.all(promises)
    expect(capture.calls.length).toBe(5)
    // Each capture carries its own granted pattern.
    const allPatterns = capture.calls.map((c2) => c2.grantedPatterns[0])
    expect(new Set(allPatterns).size).toBe(5)
  })
})
