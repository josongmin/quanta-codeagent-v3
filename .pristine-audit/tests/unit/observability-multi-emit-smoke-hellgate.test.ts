/**
 * ADR-0425 — observability multi-emit smoke.
 *
 * F7 (`observability-e2e-real-hookbus-hellgate`) proved the chain holds for a
 * SINGLE `post_tool_use` event. Production runs emit many events in sequence,
 * across multiple tools, with start/touch/settle transitions per run. This
 * smoke proves the wire holds under a realistic sequence on the SAME real
 * `HookBus` + `RunLedger` instance.
 *
 * Scope: no full loop. We drive the wire directly via the production
 * `resolveObservabilityWire` factory + the real `HookBus`, then emit a
 * realistic sequence of `post_tool_use` events that touch every matcher
 * branch the audit's banner-pinning test guards.
 */

import { describe, expect, test } from "bun:test"
import { HookBus } from "@/agent/hooks"
import { resolveObservabilityWire } from "@/apps/agent"

const onEnv = { QUANTA_OBSERVABILITY: "on" } as NodeJS.ProcessEnv

const bashBackground = (shellId: string) => ({
  name: "bash",
  input: {},
  output: `[bash background] shellId=${shellId} status=running\nstdout so far:\n`,
  ok: true,
})

const bashAwaitExit0 = (shellId: string) => ({
  name: "bash_await",
  input: {},
  output: `[bash_await exit 0]\nshellId=${shellId}\nlast stdout:\nhello\n`,
  ok: true,
})

const bashKill = (shellId: string) => ({
  name: "bash_kill",
  input: {},
  output: `[bash_kill shellId=${shellId} signaled]`,
  ok: true,
})

const subagentLaunch = (taskId: string) => ({
  name: "agent",
  input: { background: true },
  output: `Subagent launched in background. task_id: ${taskId}\npoll with task_output`,
  ok: true,
})

const taskStop = (taskId: string) => ({
  name: "task_stop",
  input: { task_id: taskId },
  output: `Stopped task ${taskId}.`,
  ok: true,
})

describe("ADR-0425 multi-emit smoke — production HookBus + realistic sequence", () => {
  test("bash lifecycle: background start → await exit 0 ⇒ entry running → completed", async () => {
    const bus = new HookBus()
    const handle = resolveObservabilityWire(onEnv, { hookBus: bus })
    const shellId = "sh-multi-1"
    await bus.emit({ type: "post_tool_use", ...bashBackground(shellId) })
    expect(handle.runLedger?.get(shellId)?.status).toBe("running")
    await bus.emit({ type: "post_tool_use", ...bashAwaitExit0(shellId) })
    expect(handle.runLedger?.get(shellId)?.status).toBe("completed")
    handle.detach()
  })

  test("bash lifecycle: background → kill ⇒ entry running → stopped", async () => {
    const bus = new HookBus()
    const handle = resolveObservabilityWire(onEnv, { hookBus: bus })
    const shellId = "sh-multi-2"
    await bus.emit({ type: "post_tool_use", ...bashBackground(shellId) })
    await bus.emit({ type: "post_tool_use", ...bashKill(shellId) })
    expect(handle.runLedger?.get(shellId)?.status).toBe("stopped")
    handle.detach()
  })

  test("subagent lifecycle: launch → task_stop ⇒ entry running → stopped", async () => {
    const bus = new HookBus()
    const handle = resolveObservabilityWire(onEnv, { hookBus: bus })
    const taskId = "task-multi-1"
    await bus.emit({ type: "post_tool_use", ...subagentLaunch(taskId) })
    expect(handle.runLedger?.get(taskId)?.status).toBe("running")
    expect(handle.runLedger?.get(taskId)?.kind).toBe("subagent")
    await bus.emit({ type: "post_tool_use", ...taskStop(taskId) })
    expect(handle.runLedger?.get(taskId)?.status).toBe("stopped")
    handle.detach()
  })

  test("concurrent shells: distinct shellIds are tracked independently", async () => {
    const bus = new HookBus()
    const handle = resolveObservabilityWire(onEnv, { hookBus: bus })
    await bus.emit({ type: "post_tool_use", ...bashBackground("sh-A") })
    await bus.emit({ type: "post_tool_use", ...bashBackground("sh-B") })
    expect(handle.runLedger?.get("sh-A")?.status).toBe("running")
    expect(handle.runLedger?.get("sh-B")?.status).toBe("running")
    await bus.emit({ type: "post_tool_use", ...bashAwaitExit0("sh-A") })
    expect(handle.runLedger?.get("sh-A")?.status).toBe("completed")
    expect(handle.runLedger?.get("sh-B")?.status).toBe("running") // unaffected
    handle.detach()
  })

  test("mixed kinds: shell + subagent coexist with independent state", async () => {
    const bus = new HookBus()
    const handle = resolveObservabilityWire(onEnv, { hookBus: bus })
    await bus.emit({ type: "post_tool_use", ...bashBackground("sh-mix") })
    await bus.emit({ type: "post_tool_use", ...subagentLaunch("task-mix") })
    expect(handle.runLedger?.get("sh-mix")?.kind).toBe("shell")
    expect(handle.runLedger?.get("task-mix")?.kind).toBe("subagent")
    // Settle each via the kind-appropriate banner — cross-pollination prevention.
    await bus.emit({ type: "post_tool_use", ...bashAwaitExit0("sh-mix") })
    await bus.emit({ type: "post_tool_use", ...taskStop("task-mix") })
    expect(handle.runLedger?.get("sh-mix")?.status).toBe("completed")
    expect(handle.runLedger?.get("task-mix")?.status).toBe("stopped")
    handle.detach()
  })
})
