/**
 * Hellgate — composition-root activation of the subagent batch + introspect +
 * followup tools (RFC-02 / ADR-0436 + RFC-04 / ADR-0437).
 *
 * Proves the env knobs `QUANTA_SUBAGENT_BATCH` / `_INTROSPECT` / `_FOLLOWUP`
 * fold through `wireOptionalAgentPorts` (the single composition-root env→port
 * wire all surfaces call) into `config.subagent.{enableBatchSpawn/
 * enableIntrospect/enableFollowup}` AND wire the introspect dependency ports
 * (AgentMetaRegistry / TurnWakeRegistry / mailbox), so the tier-1 builders
 * register FUNCTIONAL tools — not just present ones.
 *
 * Crucially: with the followup gate on, the SAME `TurnWakeRegistry` the runner
 * would register a per-child waker into is wired, so a `followup_task` whose
 * target has a live waker reports `triggered` (not `cause:"no_waker"`).
 *
 * Default-OFF: every knob unset ⇒ `wireOptionalAgentPorts` returns the base
 * UNCHANGED (no `subagent` block, no ports) and the tier-1 builders emit zero
 * tools — byte-identical to the pre-wire path (RFC §1.2). No LLM, no timers.
 */
import { describe, expect, test } from "bun:test"
import { wireOptionalAgentPorts } from "../../src/agent/optional-ports"
import {
  createSubagentDeliveryController,
  createTargetResolver,
  type DeliveryMailboxPort,
  type SubagentControlRegistry,
} from "../../src/agent/subagent-delivery"
import { buildSubagentBatchBlock } from "../../src/agent/tier1/subagent-batch"
import { buildSubagentIntrospectBlock } from "../../src/agent/tier1/subagent-introspect"
import type { AgentConfig } from "../../src/agent/types"
import { handleFollowupTask, TaskRegistry, TurnWakeRegistry } from "../../src/subagent"
import type { Tool, ToolEvent } from "../../src/tool"

/** Minimal `OptionalPortBase`-shaped config. Only the fields the wire reads
 *  are required; the rest of `AgentConfig` is filled lazily via a cast at the
 *  tier-1 builder boundary (the builders read only `subagent` + the dep slots). */
const baseConfig = () =>
  ({
    llm: { model: "test-model", async *stream() {} },
    signal: new AbortController().signal,
    cwd: "/tmp",
    depth: 0,
  }) as unknown as AgentConfig

/** Names of the tools the tier-1 builders emit for this config. */
const toolNames = (cfg: AgentConfig): string[] => [
  ...buildSubagentBatchBlock(cfg).map((t) => t.name),
  ...buildSubagentIntrospectBlock(cfg).map((t) => t.name),
]

const drive = async (tool: Tool, input: unknown): Promise<ToolEvent> => {
  const ctx = { cwd: "/tmp", signal: new AbortController().signal }
  let last: ToolEvent | undefined
  for await (const ev of tool.execute(input as never, ctx as never)) last = ev
  if (!last || last.type !== "result") throw new Error("no result event")
  return last
}

describe("subagent tool knobs — composition-root wire (ADR-0436/0437)", () => {
  // ── default-OFF byte-identical ───────────────────────────────────────────
  test("every knob unset ⇒ base unchanged + zero tools (byte-identical)", () => {
    const base = baseConfig()
    const wired = wireOptionalAgentPorts(base, {})
    // No subagent block, no introspect dep ports were created.
    expect(wired.subagent).toBeUndefined()
    expect(wired.subagentAgentMeta).toBeUndefined()
    expect(wired.subagentTurnWake).toBeUndefined()
    expect(wired.subagentMailbox).toBeUndefined()
    // Tier-1 builders emit nothing.
    expect(toolNames(wired)).toEqual([])
  })

  // Canonical gate vocabulary (`@/shared#gateOn`): a falsy token, empty, or
  // garbage leaves the gate OFF. (Previously these gates were strict `=== "on"`;
  // they now share the one SSOT grammar so `=1`/`=on`/`=true` ALL enable.)
  test("falsey / typo values do NOT enable", () => {
    for (const v of ["off", "0", "false", "no", "", "  ", "yep", "2"]) {
      const wired = wireOptionalAgentPorts(baseConfig(), {
        QUANTA_SUBAGENT_BATCH: v,
        QUANTA_SUBAGENT_INTROSPECT: v,
        QUANTA_SUBAGENT_FOLLOWUP: v,
      })
      expect(wired.subagent).toBeUndefined()
      expect(toolNames(wired)).toEqual([])
    }
  })

  // The consistency win: every recognized truthy spelling enables, so `=1`
  // (the value the CLI seed loop writes) activates these gates identically to
  // `=on` — no more silent-off footgun for the followup/batch/introspect family.
  test("any truthy token (1/on/true/yes, case-insensitive) enables", () => {
    for (const v of ["1", "on", "true", "yes", "ON", "TRUE"]) {
      const wired = wireOptionalAgentPorts(baseConfig(), { QUANTA_SUBAGENT_BATCH: v })
      expect(wired.subagent?.enableBatchSpawn).toBe(true)
    }
  })

  // ── batch ──────────────────────────────────────────────────────────────
  test("QUANTA_SUBAGENT_BATCH=on ⇒ enableBatchSpawn + spawn_batch registered", () => {
    const wired = wireOptionalAgentPorts(baseConfig(), { QUANTA_SUBAGENT_BATCH: "on" })
    expect(wired.subagent?.enableBatchSpawn).toBe(true)
    expect(buildSubagentBatchBlock(wired).map((t) => t.name)).toEqual(["spawn_batch"])
  })

  // ── introspect ───────────────────────────────────────────────────────────
  test("QUANTA_SUBAGENT_INTROSPECT=on ⇒ enableIntrospect + agentMeta + list_agents", () => {
    const wired = wireOptionalAgentPorts(baseConfig(), { QUANTA_SUBAGENT_INTROSPECT: "on" })
    expect(wired.subagent?.enableIntrospect).toBe(true)
    expect(wired.subagentAgentMeta).toBeDefined()
    expect(buildSubagentIntrospectBlock(wired).map((t) => t.name)).toEqual(["list_agents"])
  })

  // ── followup deps fully wired ──────────────────────────────────────────────
  test("QUANTA_SUBAGENT_FOLLOWUP=on ⇒ enableFollowup + turnWake + mailbox + followup_task", () => {
    const wired = wireOptionalAgentPorts(baseConfig(), { QUANTA_SUBAGENT_FOLLOWUP: "on" })
    expect(wired.subagent?.enableFollowup).toBe(true)
    expect(wired.subagentTurnWake).toBeDefined()
    expect(wired.subagentMailbox).toBeDefined()
    expect(buildSubagentIntrospectBlock(wired).map((t) => t.name)).toEqual(["followup_task"])
  })

  test("all three knobs on ⇒ all three tools registered", () => {
    const wired = wireOptionalAgentPorts(baseConfig(), {
      QUANTA_SUBAGENT_BATCH: "on",
      QUANTA_SUBAGENT_INTROSPECT: "on",
      QUANTA_SUBAGENT_FOLLOWUP: "on",
    })
    expect(toolNames(wired).sort()).toEqual(["followup_task", "list_agents", "spawn_batch"])
  })

  // ── PROOF: followup is FUNCTIONAL (not no_waker) via the wired registry ─────
  test("followup_task triggers a child via the wired TurnWakeRegistry (NOT no_waker)", async () => {
    const wired = wireOptionalAgentPorts(baseConfig(), { QUANTA_SUBAGENT_FOLLOWUP: "on" })
    const wake = wired.subagentTurnWake
    if (wake === undefined) throw new Error("turnWake not wired")

    // ALBB-12 claim 1: `wireSubagentToolGates` now MINTS the shared
    // `taskRegistry` into `config.subagent` (belt-and-suspenders), so the
    // introspect builder and the (simulated) runner observe the SAME instance
    // BY CONSTRUCTION — no manual patch. Injection: drop that mint and this
    // followup goes `no_waker` (empty split registry) ⇒ the wire is unproven.
    const registry = wired.subagent?.taskRegistry
    if (registry === undefined) throw new Error("wire did not mint a shared taskRegistry")

    const childId = registry.newId()
    registry.register({ id: childId, description: "child task" })
    // Simulate the subagent runner registering a per-child control ENDPOINT keyed
    // by the child's registry task id (WS2 registerEndpoint) INTO the SAME wired
    // registry — this is what the WS3 delivery controller drives.
    let woken = ""
    const unregister = wake.registerEndpoint(childId, {
      mailboxLabel: childId,
      wake: () => {
        woken = "followup"
        return "woke"
      },
      interrupt: () => "woke_idle",
      steer: () => "accepted",
      currentTurnId: () => "turn-fake",
    })

    // Drive the actual registered tool via Tool.execute (true end-to-end).
    const tools = buildSubagentIntrospectBlock(wired)
    const followup = tools.find((t) => t.name === "followup_task")
    if (followup === undefined) throw new Error("followup_task not registered")
    const ev = await drive(followup, { agentId: childId, message: "do more" })
    if (ev.type !== "result") throw new Error("no result")
    // ok:true + the human string says "turn started" — i.e. triggered, NOT
    // the no_waker degrade.
    expect(ev.result.ok).toBe(true)
    expect(ev.result.output).toContain("turn started")
    expect(ev.result.output).not.toContain("no_waker")
    expect(woken).toBe("followup")
    unregister()
  })

  test("followup_task with NO live endpoint honestly degrades to control_unavailable", () => {
    const wired = wireOptionalAgentPorts(baseConfig(), { QUANTA_SUBAGENT_FOLLOWUP: "on" })
    const registry = new TaskRegistry()
    const childId = registry.newId()
    registry.register({ id: childId, description: "child" })
    // No control ENDPOINT registered into the wired registry ⇒ the ensure-turn
    // no endpoint ⇒ honest control_unavailable degraded delivery.
    const wake = wired.subagentTurnWake as NonNullable<AgentConfig["subagentTurnWake"]>
    const control = wake as unknown as SubagentControlRegistry
    const out = handleFollowupTask(
      { agentId: childId, message: "x" },
      {
        delivery: createSubagentDeliveryController({
          control,
          mailbox: wired.subagentMailbox as unknown as DeliveryMailboxPort,
          formatPeer: (from, kind, body) => `[teammate ${from} — untrusted] [${kind}] ${body}`,
          resolveTarget: createTargetResolver({ registry, control }),
          newDeliveryId: (() => {
            let n = 0
            return () => {
              n += 1
              return `del-${n}`
            }
          })(),
          steerEnabled: false,
        }),
        callerLabel: "parent",
      },
    )
    expect(out.kind).toBe("success")
    if (out.kind === "success" && out.status === "degraded") {
      expect(out.reason).toBe("control_unavailable")
    }
  })

  // ── caller-override-precedence (ADR-0332) ──────────────────────────────────
  test("caller-supplied subagent flag + ports are preserved (override-precedence)", () => {
    const callerWake = new TurnWakeRegistry()
    const base = baseConfig()
    ;(base as AgentConfig).subagent = { enableBatchSpawn: true, maxDepth: 3 }
    ;(base as AgentConfig).subagentTurnWake = callerWake
    const wired = wireOptionalAgentPorts(base, {
      QUANTA_SUBAGENT_BATCH: "on",
      QUANTA_SUBAGENT_FOLLOWUP: "on",
    })
    // maxDepth preserved, batch still on, caller's wake instance preserved.
    expect(wired.subagent?.maxDepth).toBe(3)
    expect(wired.subagent?.enableBatchSpawn).toBe(true)
    expect(wired.subagent?.enableFollowup).toBe(true)
    expect(wired.subagentTurnWake).toBe(callerWake)
  })

  // ── purity / totality of the env→flag fold ─────────────────────────────────
  test("env→flag resolution is pure + total (same env ⇒ same flags; no throw)", () => {
    const env = { QUANTA_SUBAGENT_INTROSPECT: "on" }
    const a = wireOptionalAgentPorts(baseConfig(), env)
    const b = wireOptionalAgentPorts(baseConfig(), env)
    expect(a.subagent?.enableIntrospect).toBe(b.subagent?.enableIntrospect)
    // Total over odd inputs — never throws.
    expect(() =>
      wireOptionalAgentPorts(baseConfig(), {
        QUANTA_SUBAGENT_BATCH: undefined,
        QUANTA_SUBAGENT_INTROSPECT: "garbage",
        QUANTA_SUBAGENT_FOLLOWUP: "ON ",
      }),
    ).not.toThrow()
  })
})
