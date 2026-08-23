/**
 * RFC jun-6 Binding 1 — LIVE host-wire hellgate for the sandbox-block →
 * escalation-retry loop, end-to-end through the REAL bash tool.
 *
 * The machine (`@/agent/sandbox-escalation` orchestrator + `@/runtime/os-sandbox`
 * `classifySandboxDenial` + `@/permission/post-denial`) is unit-proven elsewhere.
 * THIS battery proves the LIVE wire: a `mode="read"` command that runs inside an
 * APPLIED (fake) sandbox and FAILS with a Seatbelt-deny stderr is detected as a
 * sandbox BLOCK by the host-installed handler (`maybeWireBashSandboxEscalation`),
 * which seeds the post-denial machine, runs the user-gated HITL escalation, and
 * — on APPROVE — re-runs the BYTE-SAME command UNSANDBOXED through the gate.
 *
 * The fake per-call sandbox wrap rewrites the argv to a command that FAILS with a
 * `Sandbox: deny(1) ...` stderr (the high-confidence Seatbelt signal); the
 * UNSANDBOXED re-run runs the ORIGINAL command (which succeeds). So an approved
 * escalation flips the tool result from a failure to a success — observable
 * end-to-end through the real `bashTool.execute`.
 *
 * Knob-OFF ⇒ byte-identical: no handler minted ⇒ the ctx omits the seam ⇒ the
 * blocked command surfaces as a plain nonzero exit (today's behavior).
 *
 * aug-23 — the handler is a PER-SESSION `AgentConfig` slot
 * (`cfg.bashSandboxEscalation`), projected onto `ToolContext.sandboxEscalation`,
 * NOT a process-global. This battery therefore wires a session config and hands
 * ITS handler to the ctx; the cross-session isolation invariant itself is pinned
 * by `sandbox-escalation-per-session-slot-hellgate.test.ts`.
 *
 * Determinism: no Date.now/Math.random in the assertions; the escalation cap +
 * permission store are the real ones, driven by an injected fake onConfirm.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ConfirmDecision } from "@/agent"
import type { AgentConfig } from "@/agent/types"
import { maybeWireBashSandboxEscalation } from "@/host/runtime/sandbox-escalation-wire"
import type { PermissionStore, ToolAction } from "@/permission"
import { __resetDefaultPermissionStore, createPermissionStore } from "@/permission"
import { __resetShellSandbox } from "@/runtime"
import type { PerCallSandboxAvailability, PerCallSandboxPort } from "@/runtime/os-sandbox"
import { runtimeConfigFromEnv } from "@/shared"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool"
import { bashTool } from "@/tool/bash"
import { __setBashPerCallSandboxFactory } from "@/tool/bash/per-call-factory"

const dir = mkdtempSync(join(tmpdir(), "sbxesc-bash-wire-"))

/** A fake per-call sandbox that APPLIES (sandboxApplied:true) and rewrites the
 *  argv so the SANDBOXED spawn fails with a Seatbelt-deny stderr — the
 *  high-confidence block signal. The UNSANDBOXED re-run (no perCallWrap) runs
 *  the ORIGINAL command verbatim. */
const blockingSandbox = (): PerCallSandboxPort => ({
  availability: (): PerCallSandboxAvailability => ({ supported: true }),
  wrap: (_argv, _cwd) => ({
    // bash spawns `bash -lc <cmd>`; rewrite the inner command to emit the
    // Seatbelt deny line + exit nonzero. sandboxApplied:true is the load-bearing
    // precondition for the classifier.
    argv: ["bash", "-lc", 'echo "Sandbox: app(1) deny(1) file-write-data" 1>&2; exit 1'],
    sandboxApplied: true,
  }),
})

/** The SESSION's escalation handler, minted by {@link wireWith} onto the session
 *  config and projected onto every ctx this battery builds (the dispatch seam
 *  does exactly this projection in production). */
let sessionHandler: AgentConfig["bashSandboxEscalation"]

const ctx = (overrides?: Partial<ToolContext>): ToolContext => ({
  cwd: dir,
  signal: new AbortController().signal,
  agentLabel: "root",
  turnId: "turn-1",
  ...(sessionHandler !== undefined ? { sandboxEscalation: sessionHandler } : {}),
  ...overrides,
})

const collect = async (input: unknown, c: ToolContext): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of bashTool.execute(input as never, c) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

/** Build a cfg-shaped object the host wire reads: onConfirm authority + the
 *  default permission store (the same the gate would consult). */
let store: PermissionStore

/** Run the REAL host wire over a session config with a fresh injected permission
 *  store (the gate-shared store the surface threads onto
 *  `admissibility.permissionStore`) + a fake onConfirm authority, and capture the
 *  minted PER-SESSION handler so every ctx below carries it (stage 2). */
const wireWith = (approve: boolean, max?: string): void => {
  const onConfirm = async (_a: ToolAction): Promise<ConfirmDecision> => ({
    decision: approve ? "allow" : "deny",
  })
  const cfg = {
    onConfirm,
    admissibility: { permissionStore: store },
  } as unknown as AgentConfig
  maybeWireBashSandboxEscalation(
    cfg,
    runtimeConfigFromEnv({
      QUANTA_SANDBOX_ESCALATION: "1",
      ...(max !== undefined ? { QUANTA_SANDBOX_ESCALATION_MAX: max } : {}),
    }),
  )
  sessionHandler = cfg.bashSandboxEscalation
}

beforeEach(async () => {
  __resetShellSandbox()
  sessionHandler = undefined
  __resetDefaultPermissionStore()
  store = createPermissionStore({ filePath: join(dir, "perm-state.json"), debounceMs: 0 })
  await store.load()
  __setBashPerCallSandboxFactory(() => blockingSandbox())
})

afterEach(() => {
  __resetShellSandbox()
  __setBashPerCallSandboxFactory(undefined)
  sessionHandler = undefined
  __resetDefaultPermissionStore()
})

describe("RFC jun-6 Binding 1 — bash sandbox-escalation LIVE wire", () => {
  test("HELL-1: block + APPROVE → re-runs UNSANDBOXED through the real bash tool (failure → success)", async () => {
    wireWith(true)
    const r = await collect({ command: "echo unsandboxed-ok", mode: "read" }, ctx())
    // The unsandboxed re-run ran the ORIGINAL command (`echo unsandboxed-ok`),
    // which succeeds — the approved escalation flipped failure → success.
    expect(r.ok).toBe(true)
    expect(r.output).toContain("unsandboxed-ok")
    // Model-facing note records it WAS a sandbox block (not a generic failure).
    expect(r.output).toContain("blocked by the OS sandbox")
    expect(r.output.toLowerCase()).toContain("approved")
  })

  test("HELL-2: block + DENY → stays blocked, NO unsandboxed re-run (command not run unsandboxed)", async () => {
    wireWith(false)
    const r = await collect({ command: "echo SHOULD-NOT-RUN", mode: "read" }, ctx())
    // Denied escalation ⇒ the blocked (sandboxed-failure) result stands; the
    // original command never ran unsandboxed, so its stdout never appears.
    expect(r.ok).toBe(false)
    expect(r.output).not.toContain("SHOULD-NOT-RUN")
    expect(r.output).toContain("blocked by the OS sandbox")
    expect(r.output.toLowerCase()).toContain("declined")
  })

  test("HELL-3: cap exhaustion — past QUANTA_SANDBOX_ESCALATION_MAX, no further re-run (typed exhausted)", async () => {
    wireWith(true, "1")
    // First escalation in the turn is admitted + approved → re-runs.
    const first = await collect({ command: "echo first-ok", mode: "read" }, ctx({ turnId: "T" }))
    expect(first.ok).toBe(true)
    // Second escalation in the SAME turn exceeds the cap → exhausted, no re-run.
    const second = await collect({ command: "echo second", mode: "read" }, ctx({ turnId: "T" }))
    expect(second.ok).toBe(false)
    expect(second.output).not.toContain("second")
    expect(second.output.toLowerCase()).toContain("exhausted")
  })

  test("HELL-4: knob-OFF ⇒ byte-identical — no handler, blocked command surfaces as a plain failure", async () => {
    // Wire is a no-op when the knob is off (the slot is never stamped).
    const cfg = { onConfirm: async () => true } as unknown as AgentConfig
    maybeWireBashSandboxEscalation(cfg, runtimeConfigFromEnv({}))
    expect(cfg.bashSandboxEscalation).toBeUndefined()
    expect(ctx().sandboxEscalation).toBeUndefined()
    const r = await collect({ command: "echo never-unsandboxed", mode: "read" }, ctx())
    // No escalation: the sandboxed failure stands, no escalation note, the
    // original command never ran unsandboxed.
    expect(r.ok).toBe(false)
    expect(r.output).not.toContain("never-unsandboxed")
    expect(r.output).not.toContain("blocked by the OS sandbox")
  })

  test("HELL-5: a SUCCESSFUL sandboxed command is NEVER classified a block (no escalation, no note)", async () => {
    // Swap in a sandbox that APPLIES but SUCCEEDS — exit 0 is never a denial.
    __setBashPerCallSandboxFactory(() => ({
      availability: () => ({ supported: true }),
      wrap: () => ({ argv: ["bash", "-lc", "echo applied-ok"], sandboxApplied: true }),
    }))
    wireWith(true)
    const r = await collect({ command: "echo applied-ok", mode: "read" }, ctx())
    expect(r.ok).toBe(true)
    expect(r.output).toContain("applied-ok")
    expect(r.output).not.toContain("blocked by the OS sandbox")
  })

  test("HELL-6: NON-sandbox failure (mode='write', sandbox NOT applied) is NEVER escalated", async () => {
    wireWith(true)
    // mode defaults to "write" ⇒ no per-call wrap ⇒ sandboxApplied stays false ⇒
    // the handler is never consulted even though the command fails.
    const r = await collect({ command: "exit 7" }, ctx())
    expect(r.ok).toBe(false)
    expect(r.output).not.toContain("blocked by the OS sandbox")
  })
})
