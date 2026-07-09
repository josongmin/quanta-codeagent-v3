/**
 * HITL approval — END-TO-END (jun-10 restructure).
 *
 * Drives the REAL chain a mid-turn approval traverses on the interactive CLI:
 *
 *   admissibility gate (`runAdmissibilityGate`, mode policy ask)
 *     → confirm slot (swapped by `runWithProtocol`)
 *       → runtime approval controller (inline-interactive delegation,
 *         serialization, session grants, lease claims — context-binding)
 *         → REAL CLI confirm prompt (`buildCliOnConfirm` — 4-verb wording)
 *           → mid-turn approval channel (the in-turn reader's routed line)
 *             → scripted operator keystrokes
 *
 * Plus the DEFERRED protocol (non-interactive surface): gate throw →
 * `resolveApproval` → leased re-run — the web/SDK round-trip.
 *
 * Every layer is production code; the only fakes are the operator's typed
 * lines (fed through the channel exactly as the session loop does) and the
 * stderr sink (captured to assert the prompt actually rendered — the original
 * field bug was precisely "the question never reached the operator").
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { type AdmissibilityAction, runAdmissibilityGate } from "@/agent/admissibility-gate"
import { __testing as composeTesting } from "@/apps/cli/repl/runtime-context-compose"
import {
  createMidTurnApprovalChannel,
  type MidTurnApprovalChannel,
} from "@/apps/cli/repl/mid-turn-approval-channel"
import { __testing as approvalTesting } from "@/host/runtime/internal/context-binding"
import type { ToolUseBlock } from "@/llm"
import { __resetDefaultPermissionStore, type PermissionContext } from "@/permission"
import { __resetRuntimeConfig } from "@/shared"
import type { Tool, ToolEvent } from "@/tool"
import { ToolRegistry } from "@/tool"

// ── env hygiene (mirrors tests/unit/admissibility-gate.test.ts) ───────────

const originalPermissionState = process.env.QUANTA_PERMISSION_STATE
let permissionStateRoot: string | null = null

beforeEach(() => {
  permissionStateRoot = mkdtempSync(join(tmpdir(), "hitl-e2e-perm-state-"))
  process.env.QUANTA_PERMISSION_STATE = join(permissionStateRoot, "permission-state.json")
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})

afterEach(() => {
  if (permissionStateRoot !== null) rmSync(permissionStateRoot, { recursive: true, force: true })
  permissionStateRoot = null
  if (originalPermissionState === undefined) delete process.env.QUANTA_PERMISSION_STATE
  else process.env.QUANTA_PERMISSION_STATE = originalPermissionState
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})

// ── harness ────────────────────────────────────────────────────────────────

const makeMutatingTool = (name: string, ran: string[]): Tool => ({
  name,
  description: `${name} tool`,
  inputSchema: z.object({}).passthrough() as z.ZodType<unknown>,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  execute: () =>
    (async function* (): AsyncIterable<ToolEvent> {
      ran.push(name)
      yield { type: "result", result: { ok: true, output: "ran" } } as ToolEvent
    })(),
})

const call = (name: string, input: unknown = {}, id = "c1"): ToolUseBlock => ({
  type: "tool_use",
  id,
  name,
  input,
})

const actionOf = (name: string, input: unknown = {}): AdmissibilityAction => ({
  tool: name,
  input,
  isReadOnly: false,
})

interface Harness {
  readonly channel: MidTurnApprovalChannel
  readonly ctrl: ReturnType<typeof approvalTesting.createRuntimeApprovalProtocolController>
  readonly gate: (c: ToolUseBlock, a: AdmissibilityAction) => Promise<unknown>
  /** Type a line as the operator (waits until a prompt is actually awaiting). */
  readonly type: (line: string) => Promise<void>
  readonly stderrOut: () => string
  readonly accepts: () => number
  readonly denies: () => number
  readonly restore: () => void
}

const makeHarness = (opts: { interactive: boolean }): Harness => {
  const ran: string[] = []
  const registry = new ToolRegistry([makeMutatingTool("edit_file", ran)])

  // stderr capture — assert the prompt RENDERED (the field bug was a prompt
  // that never reached the operator). Restored in restore().
  let captured = ""
  const realWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
    return true
  }) as typeof process.stderr.write

  const channel = createMidTurnApprovalChannel()
  channel.active = true // a turn is streaming — the in-turn reader owns stdin

  let accepts = 0
  let denies = 0
  const surfaceConfirm = composeTesting.buildCliOnConfirm({
    idleMonitor: { markActive: () => undefined } as never,
    rejectCounter: {
      recordAccept: () => {
        accepts += 1
      },
      recordDeny: () => {
        denies += 1
      },
    } as never,
    channel,
  })

  const confirmSlot: { current: (a: never) => Promise<unknown> } = {
    current: surfaceConfirm as never,
  }
  const base = {
    registry,
    approvalProtocol: {
      confirmSlot,
      ...(opts.interactive ? { interactive: true } : {}),
    },
  } as unknown as Parameters<typeof approvalTesting.createRuntimeApprovalProtocolController>[0]
  const ctrl = approvalTesting.createRuntimeApprovalProtocolController(base)

  const config = {
    cwd: "/repo",
    signal: new AbortController().signal,
    planMode: false,
    permission: { mode: "default" } as PermissionContext,
    registry,
    onConfirm: (a: never) => confirmSlot.current(a),
  } as unknown as AgentConfig

  return {
    channel,
    ctrl,
    gate: (c, a) => runAdmissibilityGate(c, config as never, { mode: "default" }, a),
    type: async (line: string): Promise<void> => {
      // The prompt registers its waiter asynchronously — retry until consumed.
      for (let i = 0; i < 200; i += 1) {
        if (channel.tryResolve(line)) return
        await new Promise((r) => setTimeout(r, 2))
      }
      throw new Error(`operator line never consumed: ${line}`)
    },
    stderrOut: () => captured,
    accepts: () => accepts,
    denies: () => denies,
    restore: () => {
      process.stderr.write = realWrite
    },
  }
}

// ── inline-interactive path (live operator at the gate) ───────────────────

describe("HITL e2e — inline approve/deny at the gate (no turn abort)", () => {
  test("operator types 'y' → gate admits the call; prompt rendered with the 4-verb wording", async () => {
    const h = makeHarness({ interactive: true })
    try {
      const gateRun = h.ctrl.runWithProtocol(() => h.gate(call("edit_file"), actionOf("edit_file")))
      await h.type("y")
      const result = await gateRun
      expect(result).toBeNull() // null ⇒ admitted, dispatch proceeds
      expect(h.stderrOut()).toContain(
        "Allow edit_file? [y]es / [a]lways session / [N]o / deny+s[t]eer: ",
      )
      expect(h.accepts()).toBe(1)
      expect(h.ctrl.__pendingSize()).toBe(0) // inline ⇒ NO pending approval minted
    } finally {
      h.restore()
    }
  })

  test("operator types nothing useful (empty line) → fail-closed deny, turn NOT aborted", async () => {
    const h = makeHarness({ interactive: true })
    try {
      const gateRun = h.ctrl.runWithProtocol(() => h.gate(call("edit_file"), actionOf("edit_file")))
      await h.type("") // the channel's turn-teardown shape: released with ""
      const result = (await gateRun) as { block?: { content?: unknown } } | null
      expect(result).not.toBeNull() // a DENY DispatchResult — not a thrown abort
      expect(JSON.stringify(result)).toContain("declined")
      expect(h.denies()).toBe(1)
    } finally {
      h.restore()
    }
  })

  test("operator denies WITH steer ('t' + correction) → deny result carries steerInjection", async () => {
    const h = makeHarness({ interactive: true })
    try {
      const gateRun = h.ctrl.runWithProtocol(() => h.gate(call("edit_file"), actionOf("edit_file")))
      await h.type("t")
      await h.type("edit the test fixture instead")
      const result = (await gateRun) as { steerInjection?: string } | null
      expect(result).not.toBeNull()
      expect(result?.steerInjection).toContain("edit the test fixture instead")
    } finally {
      h.restore()
    }
  })
})

describe("HITL e2e — '[a]lways session' standing grant (parallel fan-out shape)", () => {
  test("one 'a' answer; the SAME action in a LATER turn passes with no second prompt", async () => {
    const h = makeHarness({ interactive: true })
    try {
      const run1 = h.ctrl.runWithProtocol(() => h.gate(call("edit_file"), actionOf("edit_file")))
      await h.type("a")
      expect(await run1).toBeNull()

      const promptCountAfterFirst = (h.stderrOut().match(/Allow edit_file\?/g) ?? []).length
      expect(promptCountAfterFirst).toBe(1)

      // LATER TURN — same actionKey: standing grant, zero interaction needed.
      const run2 = h.ctrl.runWithProtocol(() => h.gate(call("edit_file"), actionOf("edit_file")))
      expect(await run2).toBeNull()
      expect((h.stderrOut().match(/Allow edit_file\?/g) ?? []).length).toBe(1) // still ONE
    } finally {
      h.restore()
    }
  })

  test("CONCURRENT same-key confirms in one turn: single prompt, both admitted", async () => {
    const h = makeHarness({ interactive: true })
    try {
      const both = h.ctrl.runWithProtocol(async () => {
        const a = h.gate(call("edit_file", {}, "c1"), actionOf("edit_file"))
        const b = h.gate(call("edit_file", {}, "c2"), actionOf("edit_file"))
        return await Promise.all([a, b])
      })
      await h.type("a")
      const results = await both
      expect(results).toEqual([null, null])
      expect((h.stderrOut().match(/Allow edit_file\?/g) ?? []).length).toBe(1)
    } finally {
      h.restore()
    }
  })
})

describe("HITL e2e — inline skill-scope escalation (o/s/D/t verbs)", () => {
  test("'o' (allow once) admits without widening; 'd' denies — both through the REAL prompt", async () => {
    const h = makeHarness({ interactive: true })
    try {
      const escalated: AdmissibilityAction = {
        ...actionOf("edit_file"),
        scopeContext: {
          activeSkill: "deploy-runbook",
          reason: "tool not in skill allowlist",
          justification: "need to patch the manifest",
        },
      } as AdmissibilityAction
      const run1 = h.ctrl.runWithProtocol(() => h.gate(call("edit_file"), escalated))
      await h.type("o")
      expect(await run1).toBeNull()
      expect(h.stderrOut()).toContain("Skill 'deploy-runbook' scope")
      expect(h.stderrOut()).toContain("Allow [o]nce / allow [s]ession / [d]eny / deny+s[t]eer?")

      const run2 = h.ctrl.runWithProtocol(() => h.gate(call("edit_file"), escalated))
      await h.type("d")
      expect(await run2).not.toBeNull() // denied DispatchResult
    } finally {
      h.restore()
    }
  })
})

// ── deferred protocol (non-interactive surface: web/SDK round-trip) ───────

describe("HITL e2e — deferred approvalRequest protocol (web/SDK surfaces)", () => {
  test("gate throws RuntimeApprovalRequiredError; approve → leased re-run admits WITHOUT any prompt", async () => {
    const h = makeHarness({ interactive: false })
    try {
      let thrown: { name?: string; approval?: { approvalId: string; reason: string } } | undefined
      await h.ctrl.runWithProtocol(async () => {
        try {
          await h.gate(call("edit_file"), actionOf("edit_file"))
        } catch (e) {
          thrown = e as typeof thrown
        }
      })
      expect(thrown?.name).toBe("RuntimeApprovalRequiredError")
      expect(thrown?.approval?.reason).toBe("edit.needs_approval")
      expect(h.stderrOut()).not.toContain("Allow edit_file?") // NO inline prompt on this surface

      h.ctrl.resolveApproval(thrown?.approval?.approvalId as string, "approve")
      // The surface re-runs the turn; the leased re-run admits silently.
      const rerun = await h.ctrl.runWithProtocol(() =>
        h.gate(call("edit_file"), actionOf("edit_file")),
      )
      expect(rerun).toBeNull()
      expect(h.stderrOut()).not.toContain("Allow edit_file?")
    } finally {
      h.restore()
    }
  })

  test("deny → the leased re-run never happens; a fresh ask re-throws (fail closed)", async () => {
    const h = makeHarness({ interactive: false })
    try {
      let approvalId: string | undefined
      await h.ctrl.runWithProtocol(async () => {
        try {
          await h.gate(call("edit_file"), actionOf("edit_file"))
        } catch (e) {
          approvalId = (e as { approval: { approvalId: string } }).approval.approvalId
        }
      })
      h.ctrl.resolveApproval(approvalId as string, "deny")
      let rethrown = false
      await h.ctrl.runWithProtocol(async () => {
        try {
          await h.gate(call("edit_file"), actionOf("edit_file"))
        } catch {
          rethrown = true
        }
      })
      expect(rethrown).toBe(true)
    } finally {
      h.restore()
    }
  })
})

describe("HITL e2e — deferred CLI fallback prompt carries the 'always' verb end-to-end", () => {
  test("operator types 'a' at the deferred prompt → approve+session → later turn admits silently", async () => {
    const h = makeHarness({ interactive: false })
    try {
      // Round-trip 1: gate throws, the REAL CLI approval prompt asks, operator
      // answers "[a]lways session".
      let approval: { approvalId: string; reason: string } | undefined
      await h.ctrl.runWithProtocol(async () => {
        try {
          await h.gate(call("edit_file"), actionOf("edit_file"))
        } catch (e) {
          approval = (e as { approval: typeof approval }).approval
        }
      })
      const promptRun = composeTesting.buildCliApprovalPrompt({
        idleMonitor: { markActive: () => undefined } as never,
        rejectCounter: { recordAccept: () => undefined, recordDeny: () => undefined } as never,
        channel: h.channel,
      })(approval as never)
      await h.type("a")
      const decision = (await promptRun) as { decision?: string; scope?: string } | string
      expect(typeof decision === "object" ? decision : { decision }).toEqual({
        decision: "approve",
        scope: "session",
      })
      expect(h.stderrOut()).toContain("[a]lways session")

      // The driver responds with that scope — grant stands for later turns.
      h.ctrl.resolveApproval((approval as { approvalId: string }).approvalId, "approve", {
        scope: "session",
      })
      const rerun = await h.ctrl.runWithProtocol(() =>
        h.gate(call("edit_file"), actionOf("edit_file")),
      )
      expect(rerun).toBeNull() // leased re-run
      const later = await h.ctrl.runWithProtocol(() =>
        h.gate(call("edit_file"), actionOf("edit_file")),
      )
      expect(later).toBeNull() // standing grant — no fresh approvalRequest
      expect(h.ctrl.__pendingSize()).toBe(0)
    } finally {
      h.restore()
    }
  })
})

// ── channel fail-safety (the session loop's teardown contract) ────────────

describe("HITL e2e — channel teardown can never hang an approval", () => {
  test("turn ends while a prompt is open → typed release → deny (no hang, no allow)", async () => {
    const h = makeHarness({ interactive: true })
    try {
      const gateRun = h.ctrl.runWithProtocol(() => h.gate(call("edit_file"), actionOf("edit_file")))
      // Let the prompt arm, then simulate the session loop's turn teardown.
      // WS-A (jul-10) — clear takes a typed cause; the prompt maps the release
      // to a fail-closed deny WITH attribution (never a fake empty line).
      await new Promise((r) => setTimeout(r, 10))
      h.channel.clear("turn_teardown")
      const result = await gateRun
      expect(result).not.toBeNull() // deny DispatchResult — fail closed
      expect(h.denies()).toBe(1)
    } finally {
      h.restore()
    }
  })
})
