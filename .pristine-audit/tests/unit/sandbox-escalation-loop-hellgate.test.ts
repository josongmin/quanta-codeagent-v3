/**
 * RFC jun-6 — hellgate for the sandbox-block → escalation-retry LOOP.
 *
 * Covers (RFC §6.1):
 *   - block seeds a post-denial record → model escalate → recordRiskSeen →
 *     APPROVE → recordUserOverride → hasPostDenialOverride true → re-run
 *     UNSANDBOXED, still through the gate (gate consulted, not bypassed).
 *   - DENY path → no override → command stays blocked, NO unsandboxed re-run.
 *   - gate-denied → override exists but the gate refuses → NO re-run.
 *   - same-command only → an approval for X does not carry to Y.
 *   - cap exhaustion (`ExecPolicyAmendmentExhausted` analog) → no more prompts;
 *     resets next turn.
 *   - NEVER-auto invariant → an out-of-order (override-before-risk-seen) attempt
 *     keeps hasPostDenialOverride false.
 *   - justification logged to AUDIT only.
 *
 * Determinism: injected monotonic clock + injected cap. No Date.now/Math.random.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createSandboxEscalationCap,
  type EscalationAuditEntry,
  type EscalationRequest,
  runSandboxEscalation,
  type SandboxEscalationDeps,
  seedSandboxBlockDenial,
} from "@/agent/sandbox-escalation"
import {
  computeActionSignature,
  createPermissionStore,
  hasPostDenialOverride,
  type PermissionStore,
  type PostDenialAction,
  recordUserOverride,
} from "@/permission"
import type { SandboxDenial } from "@/runtime/os-sandbox"

let tmp: string
let store: PermissionStore
let t: number
const clock = { now: () => t }

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "quanta-sbxesc-"))
  store = createPermissionStore({ filePath: join(tmp, "state.json"), debounceMs: 0 })
  await store.load()
  t = 1000
})

afterEach(async () => {
  await store.flush()
  await rm(tmp, { recursive: true, force: true })
})

const ACTION_X: PostDenialAction = {
  threadId: "thread-1",
  tool: "bash",
  workdir: "/repo",
  args: { command: "echo hi > /etc/forbidden" },
}
const ACTION_Y: PostDenialAction = {
  threadId: "thread-1",
  tool: "bash",
  workdir: "/repo",
  args: { command: "rm -rf /var/other" },
}
const DENIAL: SandboxDenial = {
  kind: "sandbox-blocked",
  signal: "seatbelt-deny",
  confidence: "high",
}

const baseDeps = (over: Partial<SandboxEscalationDeps>): SandboxEscalationDeps => ({
  store,
  clock,
  cap: createSandboxEscalationCap(3),
  presentRisk: async () => {
    t += 1 // risk-seen renders strictly after the seed denial
    return { approved: true }
  },
  gate: async () => ({ allow: true }),
  rerunUnsandboxed: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
  ...over,
})

const req = (
  action: PostDenialAction,
  justification = "need to write the config",
): EscalationRequest => ({
  action,
  turnId: "turn-1",
  denial: DENIAL,
  justification,
})

describe("escalation loop — APPROVE path", () => {
  test("block seeds a denial; approve → override → re-run UNSANDBOXED through the gate", async () => {
    const seeded = seedSandboxBlockDenial(ACTION_X, DENIAL, { store, clock })
    expect(seeded).toEqual({ blockedBySandbox: true, signal: "seatbelt-deny", confidence: "high" })
    // The seed alone is NOT an override.
    expect(hasPostDenialOverride(ACTION_X, { store })).toBe(false)

    let gateConsulted = false
    let reran = false
    const out = await runSandboxEscalation(
      req(ACTION_X),
      baseDeps({
        gate: async () => {
          gateConsulted = true
          return { allow: true }
        },
        rerunUnsandboxed: async () => {
          reran = true
          return { exitCode: 0, stdout: "wrote config", stderr: "" }
        },
      }),
    )

    expect(out.kind).toBe("approved")
    expect(gateConsulted).toBe(true) // gate CONSULTED, not bypassed
    expect(reran).toBe(true)
    expect(hasPostDenialOverride(ACTION_X, { store })).toBe(true)
    if (out.kind === "approved") expect(out.result.stdout).toBe("wrote config")
  })
})

describe("escalation loop — DENY path", () => {
  test("user declines → NO override → command stays blocked, NO re-run", async () => {
    seedSandboxBlockDenial(ACTION_X, DENIAL, { store, clock })
    let reran = false
    const out = await runSandboxEscalation(
      req(ACTION_X),
      baseDeps({
        presentRisk: async () => {
          t += 1
          return { approved: false }
        },
        rerunUnsandboxed: async () => {
          reran = true
          return { exitCode: 0, stdout: "", stderr: "" }
        },
      }),
    )
    expect(out.kind).toBe("user-denied")
    expect(reran).toBe(false)
    expect(hasPostDenialOverride(ACTION_X, { store })).toBe(false)
  })
})

describe("escalation loop — gate-denied (escalation does NOT bypass the gate)", () => {
  test("override exists but the gate refuses → NO unsandboxed re-run", async () => {
    seedSandboxBlockDenial(ACTION_X, DENIAL, { store, clock })
    let reran = false
    const out = await runSandboxEscalation(
      req(ACTION_X),
      baseDeps({
        gate: async () => ({ allow: false, reason: "hand-off-required" }),
        rerunUnsandboxed: async () => {
          reran = true
          return { exitCode: 0, stdout: "", stderr: "" }
        },
      }),
    )
    expect(out.kind).toBe("gate-denied")
    if (out.kind === "gate-denied") expect(out.reason).toBe("hand-off-required")
    expect(reran).toBe(false)
    // The override IS recorded (user approved) but the gate is the final boundary.
    expect(hasPostDenialOverride(ACTION_X, { store })).toBe(true)
  })
})

describe("escalation loop — same-command only", () => {
  test("approval for X does NOT carry to Y (different actionSignature)", async () => {
    seedSandboxBlockDenial(ACTION_X, DENIAL, { store, clock })
    await runSandboxEscalation(req(ACTION_X), baseDeps({}))
    expect(hasPostDenialOverride(ACTION_X, { store })).toBe(true)
    // Y was never blocked/escalated → no override.
    expect(hasPostDenialOverride(ACTION_Y, { store })).toBe(false)
    expect(
      computeActionSignature({ tool: "bash", workdir: "/repo", args: ACTION_X.args }),
    ).not.toBe(computeActionSignature({ tool: "bash", workdir: "/repo", args: ACTION_Y.args }))
  })
})

describe("escalation loop — cap exhaustion (ExecPolicyAmendmentExhausted analog)", () => {
  test("past QUANTA_SANDBOX_ESCALATION_MAX within a turn → exhausted, NO further prompt; resets next turn", async () => {
    const cap = createSandboxEscalationCap(2)
    seedSandboxBlockDenial(ACTION_X, DENIAL, { store, clock })
    let prompts = 0
    const deps = baseDeps({
      cap,
      presentRisk: async () => {
        prompts += 1
        t += 1
        return { approved: false } // decline each time to force re-escalation
      },
    })
    const r1 = await runSandboxEscalation(req(ACTION_X), deps)
    const r2 = await runSandboxEscalation(req(ACTION_X), deps)
    const r3 = await runSandboxEscalation(req(ACTION_X), deps)
    expect(r1.kind).toBe("user-denied")
    expect(r2.kind).toBe("user-denied")
    expect(r3.kind).toBe("exhausted")
    expect(prompts).toBe(2) // the 3rd never fired a prompt
    if (r3.kind === "exhausted") {
      expect(r3.max).toBe(2)
      expect(r3.count).toBe(3)
    }

    // Next turn resets.
    const r4 = await runSandboxEscalation({ ...req(ACTION_X), turnId: "turn-2" }, deps)
    expect(r4.kind).toBe("user-denied")
    expect(prompts).toBe(3)
  })
})

describe("escalation loop — NEVER-auto invariant (ADR-0046 ordering holds)", () => {
  test("a fabricated override (userOverride BEFORE any risk-seen) does NOT grant", () => {
    // Seed the block, then directly fabricate an out-of-order override without
    // ever firing recordRiskSeen. The store's timestamp ordering must reject it.
    seedSandboxBlockDenial(ACTION_X, DENIAL, { store, clock })
    t += 1
    recordUserOverride(ACTION_X, { store, clock }) // no recordRiskSeen first
    expect(hasPostDenialOverride(ACTION_X, { store })).toBe(false)
  })

  test("risk-seen with a STALE timestamp (before the denial) does NOT grant", () => {
    seedSandboxBlockDenial(ACTION_X, DENIAL, { store, clock: { now: () => 5000 } })
    // risk-seen + override both stamped BEFORE the denial → ordering rejects.
    recordUserOverride(ACTION_X, { store, clock: { now: () => 10 } })
    expect(hasPostDenialOverride(ACTION_X, { store })).toBe(false)
  })
})

describe("escalation loop — justification audited, not leaked", () => {
  test("justification reaches the AUDIT sink with the decision", async () => {
    seedSandboxBlockDenial(ACTION_X, DENIAL, { store, clock })
    const entries: EscalationAuditEntry[] = []
    await runSandboxEscalation(
      req(ACTION_X, "I must write /etc/hosts for the test"),
      baseDeps({
        audit: (e) => entries.push(e),
      }),
    )
    expect(entries.length).toBe(1)
    expect(entries[0]?.justification).toBe("I must write /etc/hosts for the test")
    expect(entries[0]?.decision).toBe("approved")
    expect(entries[0]?.signal).toBe("seatbelt-deny")
  })
})
