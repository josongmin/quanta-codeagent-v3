/**
 * Hellgate — N1 side-agent tools (`side_agent_spawn`/`_list`/`_stop`/`_findings`)
 * driven over a fake daemon registry through the real `Tool.execute` generators.
 * Pins: spawn round-trips, cap-exceeded throw → typed ok:false, list/findings
 * render, stop unknown → not_found, bad input → ok:false.
 */

import { describe, expect, test } from "bun:test"
import type { Tool, ToolContext, ToolEvent } from "@/tool"
import {
  type SideAgentDaemonPort,
  type SideAgentFindingView,
  type SideAgentSnapshotView,
  type SideAgentSpecView,
  sideAgentTools,
} from "@/tool/side-agent"

const ctx = (): ToolContext => ({ cwd: "/repo", signal: new AbortController().signal })

const run = async (tool: Tool, input: unknown): Promise<{ ok: boolean; output: string }> => {
  let last = { ok: false, output: "no result" }
  for await (const ev of tool.execute(input as never, ctx()) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") last = { ok: ev.result.ok, output: ev.result.output }
  }
  return last
}

const byName = (tools: Tool[], name: string): Tool => {
  const t = tools.find((x) => x.name === name)
  if (t === undefined) throw new Error(`tool not found: ${name}`)
  return t
}

/** A fake in-memory daemon registry (structurally a SideAgentDaemonPort). */
const fakeRegistry = (opts?: {
  cap?: number
}): SideAgentDaemonPort & {
  _findings: SideAgentFindingView[]
} => {
  const snaps: SideAgentSnapshotView[] = []
  const findings: SideAgentFindingView[] = []
  let n = 0
  const cap = opts?.cap ?? 99
  return {
    _findings: findings,
    spawn(spec: SideAgentSpecView): string {
      if (snaps.length >= cap) throw new Error("cap-exceeded: max concurrent daemons")
      n += 1
      const id = `sa-${n}`
      snaps.unshift({
        id,
        status: "running",
        spec,
        wakesDone: 0,
        startedAt: 1000,
      })
      return id
    },
    findings(o?: { since?: number }) {
      return o?.since !== undefined ? findings.filter((f) => f.at > (o.since as number)) : findings
    },
    list() {
      return snaps
    },
    stop(id: string) {
      const s = snaps.find((x) => x.id === id)
      if (s === undefined) return false
      return true
    },
  }
}

const spawnInput = {
  task: "watch the test suite",
  trigger: { kind: "interval", every_ms: 5000 },
  max_wakes: 10,
  max_turns_per_wake: 3,
}

describe("side-agent tools — spawn/list/stop/findings", () => {
  test("spawn registers a daemon → list shows it; stop by id", async () => {
    const reg = fakeRegistry()
    const tools = sideAgentTools(reg)
    const spawned = await run(byName(tools, "side_agent_spawn"), spawnInput)
    expect(spawned.ok).toBe(true)
    expect(spawned.output).toContain("sa-1")

    const listed = await run(byName(tools, "side_agent_list"), {})
    expect(listed.ok).toBe(true)
    expect(listed.output).toContain("sa-1")
    expect(listed.output).toContain("every 5000ms")
    expect(listed.output).toContain("watch the test suite")

    const stopped = await run(byName(tools, "side_agent_stop"), { id: "sa-1" })
    expect(stopped.ok).toBe(true)
    const unknown = await run(byName(tools, "side_agent_stop"), { id: "nope" })
    expect(unknown.ok).toBe(false)
    expect(unknown.output.toLowerCase()).toContain("unknown side-agent")
  })

  test("event-trigger spawn round-trips", async () => {
    const reg = fakeRegistry()
    const tools = sideAgentTools(reg)
    const r = await run(byName(tools, "side_agent_spawn"), {
      task: "react to pushes",
      trigger: { kind: "event", topic: "git.push" },
      max_wakes: 5,
      max_turns_per_wake: 2,
    })
    expect(r.ok).toBe(true)
    const listed = await run(byName(tools, "side_agent_list"), {})
    expect(listed.output).toContain('on "git.push"')
  })

  test("cap-exceeded throw surfaces as a typed ok:false (no crash)", async () => {
    const reg = fakeRegistry({ cap: 0 })
    const tools = sideAgentTools(reg)
    const r = await run(byName(tools, "side_agent_spawn"), spawnInput)
    expect(r.ok).toBe(false)
    expect(r.output.toLowerCase()).toContain("cannot spawn")
  })

  test("findings drain + since filter", async () => {
    const reg = fakeRegistry()
    reg._findings.push({ daemonId: "sa-1", wake: 1, summary: "flaky test X", at: 100 })
    reg._findings.push({ daemonId: "sa-1", wake: 2, summary: "leak in Y", at: 200 })
    const tools = sideAgentTools(reg)
    const all = await run(byName(tools, "side_agent_findings"), {})
    expect(all.output).toContain("flaky test X")
    expect(all.output).toContain("leak in Y")
    const recent = await run(byName(tools, "side_agent_findings"), { since: 150 })
    expect(recent.output).toContain("leak in Y")
    expect(recent.output).not.toContain("flaky test X")
  })

  test("empty list + empty findings render cleanly", async () => {
    const tools = sideAgentTools(fakeRegistry())
    expect((await run(byName(tools, "side_agent_list"), {})).output).toContain("No background")
    expect((await run(byName(tools, "side_agent_findings"), {})).output).toContain(
      "No new findings",
    )
  })

  test("bad spawn input ⇒ typed ok:false (no throw)", async () => {
    const tools = sideAgentTools(fakeRegistry())
    const r = await run(byName(tools, "side_agent_spawn"), { task: "x" })
    expect(r.ok).toBe(false)
  })
})
