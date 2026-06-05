/**
 * ★ HELLGATE — Capability B LIVE: leader-mediated escalation wired into the
 *   admissibility gate. Adversarial pins on the SECURITY boundary.
 *
 * The load-bearing invariant: a worker's SOFT permission denial may be
 * escalated to its spawning leader's authority and ADMITTED — but a HARD_DENY
 * (denylisted command) is STRUCTURALLY never escalatable, even with an
 * "approve everything" broker. Plus fail-closed on a throwing broker, and
 * byte-identical legacy deny when no broker is wired.
 *
 * Source under test:
 *   - src/agent/admissibility-gate.ts (runAdmissibilityGate soft-deny arm)
 *   - src/agent/coordination-broker-wire.ts (buildLeaderHitlBroker round-trip)
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { HookBus } from "@/agent"
import {
  type AdmissibilityAction,
  type GateEscalationBroker,
  runAdmissibilityGate,
} from "@/agent/admissibility-gate"
import { buildLeaderHitlBroker } from "@/agent/coordination-broker-wire"
import type { ToolUseBlock } from "@/llm"
import type { PermissionContext } from "@/permission"
import { __resetDefaultPermissionStore, type AutoModeClassifier } from "@/permission"
import { __resetRuntimeConfig } from "@/shared"
import { type Tool, ToolRegistry } from "@/tool"

// ── fixtures (mirror admissibility-harddeny-shell-equiv-hellgate.test.ts) ──────

const shellSchema = z.object({ command: z.string() })

/** A NON-bash shell-equivalent tool (exposes extractShellCommand) so a
 *  denylisted command hits HARD_DENY via the registry-derived path. */
const makeShellTool = (name: string): Tool => {
  const tool: Tool = {
    name,
    description: `${name} tool`,
    inputSchema: shellSchema as z.ZodType<unknown>,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    execute: async function* () {
      yield { type: "result", result: { ok: true, output: "ran" } }
    },
  }
  ;(tool as Tool & { extractShellCommand: (input: unknown) => string | null }).extractShellCommand =
    (input) => (input as { command: string }).command
  return tool
}

/** A plain mutating tool — NOT shell-equivalent, so never HARD_DENY; a classifier
 *  "deny" verdict produces a SOFT mode-policy denial (the escalatable arm). */
const makeMutatingTool = (name: string): Tool => ({
  name,
  description: `${name} tool`,
  inputSchema: z.object({}).passthrough() as z.ZodType<unknown>,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  execute: async function* () {
    yield { type: "result", result: { ok: true, output: "ran" } }
  },
})

const call = (name: string, input: unknown = {}, id = "c1"): ToolUseBlock => ({
  type: "tool_use",
  id,
  name,
  input,
})

const cfg = (over: Record<string, unknown> = {}): AgentConfig =>
  ({
    cwd: "/repo",
    signal: new AbortController().signal,
    planMode: false,
    permission: { mode: "default" } as PermissionContext,
    ...over,
  }) as AgentConfig

const actionOf = (tool: Tool, input: unknown): AdmissibilityAction => ({
  tool: tool.name,
  input,
  isReadOnly: tool.isReadOnly(),
})

/** A duck classifier whose verdict the gate's `evaluateAuto` honors directly. */
const denyClassifier = (reason: string): AutoModeClassifier =>
  ({
    evaluate: async () => ({ verdict: "deny", reason, fallback: false }),
  }) as unknown as AutoModeClassifier

/** A broker spy: records every escalate() call + returns a scripted verdict. */
const spyBroker = (
  verdict: { approved: boolean; reason?: string } | (() => never),
): { broker: GateEscalationBroker; calls: { tool: string; scope: string; reason: string }[] } => {
  const calls: { tool: string; scope: string; reason: string }[] = []
  const broker: GateEscalationBroker = {
    escalate: async (req) => {
      calls.push(req)
      if (typeof verdict === "function") return verdict()
      return verdict
    },
  }
  return { broker, calls }
}

const originalPermissionState = process.env.QUANTA_PERMISSION_STATE
let permissionStateRoot: string | null = null

beforeEach(() => {
  permissionStateRoot = mkdtempSync(join(tmpdir(), "team-broker-gate-"))
  process.env.QUANTA_PERMISSION_STATE = join(permissionStateRoot, "permission-state.json")
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})

afterEach(() => {
  if (permissionStateRoot !== null) {
    rmSync(permissionStateRoot, { recursive: true, force: true })
    permissionStateRoot = null
  }
  if (originalPermissionState === undefined) delete process.env.QUANTA_PERMISSION_STATE
  else process.env.QUANTA_PERMISSION_STATE = originalPermissionState
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})

const shell = makeShellTool("shell")
const write = makeMutatingTool("write")

// ── SECURITY: HARD_DENY is NEVER escalatable ──────────────────────────────────

describe("HELLGATE B — HARD_DENY can NEVER be escalated, even by an approve-all broker", () => {
  test("rm -rf / + approve-all broker ⇒ DENIED, broker NEVER consulted", async () => {
    const { broker, calls } = spyBroker({ approved: true })
    const input = { command: "rm -rf /" }
    const c = cfg({ registry: new ToolRegistry([shell]), permission: { mode: "bypass" } })
    const res = await runAdmissibilityGate(
      call("shell", input),
      c,
      { mode: "bypass" },
      actionOf(shell, input),
      undefined,
      { coordinationBroker: broker },
    )
    expect(res).not.toBeNull() // stays denied
    expect(res?.block.content).toContain("Blocked dangerous command")
    expect(calls).toEqual([]) // the broker was structurally bypassed
  })
})

// ── SOFT denial — the escalatable arm ─────────────────────────────────────────

describe("HELLGATE B — a SOFT policy denial escalates to the leader broker", () => {
  const softDeny = async (
    broker: GateEscalationBroker | undefined,
    classifier: AutoModeClassifier = denyClassifier("classifier blocked"),
  ) => {
    const c = cfg({ registry: new ToolRegistry([write]), permission: { mode: "auto" } })
    return runAdmissibilityGate(
      call("write", {}),
      c,
      { mode: "auto" },
      actionOf(write, {}),
      classifier,
      broker !== undefined ? { coordinationBroker: broker } : {},
    )
  }

  test("broker APPROVES ⇒ the call is ADMITTED (null), escalate called once with the request", async () => {
    const { broker, calls } = spyBroker({ approved: true })
    const res = await softDeny(broker)
    expect(res).toBeNull() // admitted — leader overrode the soft deny
    expect(calls).toEqual([{ tool: "write", scope: "write", reason: "classifier blocked" }])
  })

  test("broker DENIES ⇒ the call stays DENIED", async () => {
    const { broker, calls } = spyBroker({ approved: false, reason: "leader said no" })
    const res = await softDeny(broker)
    expect(res).not.toBeNull()
    expect(res?.block.content).toContain("Permission denied")
    expect(calls.length).toBe(1)
  })

  test("broker THROWS ⇒ fail-closed DENY (a crash never widens permission)", async () => {
    const { broker } = spyBroker(() => {
      throw new Error("decider exploded")
    })
    const res = await softDeny(broker)
    expect(res).not.toBeNull()
    expect(res?.block.content).toContain("Permission denied")
  })

  test("NO broker wired ⇒ byte-identical legacy DENY (default-OFF)", async () => {
    const res = await softDeny(undefined)
    expect(res).not.toBeNull()
    expect(res?.block.content).toContain("Permission denied")
  })
})

// ── escalation is NOT a backdoor: the hook is still the irrevocable last gate ──

describe("HELLGATE B — broker-escalated admit STILL passes the pre_tool_use hook", () => {
  test("broker APPROVES a soft-deny, but the pre_tool_use hook vetoes LAST ⇒ final DENY", async () => {
    const { broker } = spyBroker({ approved: true })
    const hooks = new HookBus()
    let hookCount = 0
    hooks.on("pre_tool_use", () => {
      hookCount += 1
      return { deny: "exfil policy" }
    })
    const c = cfg({ registry: new ToolRegistry([write]), permission: { mode: "auto" }, hooks })
    const res = await runAdmissibilityGate(
      call("write", {}),
      c,
      { mode: "auto" },
      actionOf(write, {}),
      denyClassifier("classifier blocked"),
      { coordinationBroker: broker },
    )
    // The leader approved → the gate admitted the mode-policy arm (returned null)
    // → but the admit path routes through the pre_tool_use hook, which vetoed.
    // A leader override can NEVER skip the repo-local hook's last word.
    expect(hookCount).toBe(1)
    expect(res).not.toBeNull()
    expect(res?.preview).toBe("hook-denied")
    expect(res?.block.content).toContain("exfil policy")
  })
})

// ── WIRE — buildLeaderHitlBroker round-trip (real broker security model) ──────

describe("HELLGATE B — buildLeaderHitlBroker: leader authority drives the verdict", () => {
  const req = { tool: "shell", scope: "git push --force", reason: "needs force-push" }

  test("leader APPROVES ⇒ approved; mailbox sees request(from=worker) + response(from=leader)", async () => {
    const sent: { from: string; to: string; kind: string; body: string; correlationId?: string }[] =
      []
    const broker = buildLeaderHitlBroker({
      workerId: "root/0",
      leaderId: "root",
      leaderDecide: () => ({ approved: true }),
      mailbox: {
        send: (m) => {
          sent.push(m)
          return undefined
        },
      },
      nextCorrelationId: () => "cid-1",
    })
    const verdict = await broker.escalate(req)
    expect(verdict.approved).toBe(true)
    // Audit trail: worker→leader request, then leader→worker response.
    expect(sent).toEqual([
      {
        from: "root/0",
        to: "root",
        kind: "request",
        body: JSON.stringify(req),
        correlationId: "cid-1",
      },
      {
        from: "root",
        to: "root/0",
        kind: "response",
        body: JSON.stringify({ approved: true }),
        correlationId: "cid-1",
      },
    ])
  })

  test("leader DENIES ⇒ not approved, carries the reason", async () => {
    const broker = buildLeaderHitlBroker({
      workerId: "w",
      leaderId: "L",
      leaderDecide: () => ({ approved: false, reason: "out of scope" }),
      nextCorrelationId: () => "cid-2",
    })
    const verdict = await broker.escalate(req)
    expect(verdict.approved).toBe(false)
    expect(verdict.reason).toBe("out of scope")
  })

  test("works with NO mailbox wired (decision authority unchanged)", async () => {
    const broker = buildLeaderHitlBroker({
      workerId: "w",
      leaderId: "L",
      leaderDecide: async () => ({ approved: true }),
      nextCorrelationId: () => "cid-3",
    })
    expect((await broker.escalate(req)).approved).toBe(true)
  })

  test("audit rows are ACKed (mailbox hygiene) — both request + response are marked delivered", async () => {
    // Audit #5 regression: the 2 audit rows must be ack'd so they evict before
    // real sibling mail in the bounded shared mailbox. send returns a stored
    // message with an id; the wire must ack each.
    let seq = 0
    const acked: string[] = []
    const broker = buildLeaderHitlBroker({
      workerId: "w",
      leaderId: "L",
      leaderDecide: () => ({ approved: true }),
      mailbox: {
        send: () => ({ id: `m${seq++}` }),
        ack: (id) => acked.push(id),
      },
      nextCorrelationId: () => "cid-ack",
    })
    await broker.escalate(req)
    expect(acked).toEqual(["m0", "m1"]) // request row + response row, both delivered
  })
})
