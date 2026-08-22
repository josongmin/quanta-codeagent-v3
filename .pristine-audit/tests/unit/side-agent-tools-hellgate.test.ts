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

const run = async (
  tool: Tool,
  input: unknown,
): Promise<{ ok: boolean; output: string; reason?: string }> => {
  let last: { ok: boolean; output: string; reason?: string } = { ok: false, output: "no result" }
  for await (const ev of tool.execute(input as never, ctx()) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") {
      const f = ev.result.ok ? undefined : ev.result.failure
      last = {
        ok: ev.result.ok,
        output: ev.result.output,
        ...(f !== undefined && "reason" in f ? { reason: f.reason as string } : {}),
      }
    }
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
  _spawnCalls: number
} => {
  const snaps: SideAgentSnapshotView[] = []
  const findings: SideAgentFindingView[] = []
  let n = 0
  const cap = opts?.cap ?? 99
  const self = {
    _findings: findings,
    _spawnCalls: 0,
    spawn(spec: SideAgentSpecView): string {
      self._spawnCalls += 1
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
  return self
}

const spawnInput = {
  task: "watch the test suite",
  trigger: { kind: "interval", every_ms: 5000 },
  max_wakes: 10,
  max_turns_per_wake: 3,
}

describe("side_agent_spawn — depth authority (§4 defense-in-depth: a leaf cannot mint daemons)", () => {
  test("admitChild()===false DENIES creation AND registry.spawn is NEVER invoked (typed depth_exceeded)", async () => {
    const reg = fakeRegistry()
    const denied = sideAgentTools(reg, () => false)
    const res = await run(byName(denied, "side_agent_spawn"), spawnInput)
    expect(res.ok).toBe(false)
    // Typed rejection reason — a mutation that returned ok:false with a different
    // reason (e.g. swallowed the gate into bad_input) goes RED here.
    expect(res.reason).toBe("depth_exceeded")
    expect(res.output.toLowerCase()).toContain("depth")
    // REAL EFFECT (not just the message / not just an empty list render): the
    // registry's `spawn` was never even entered. If the gate were dropped, the
    // guarded early-return vanishes and spawn is called ⇒ this flips RED.
    expect(reg._spawnCalls).toBe(0)
    const listed = await run(byName(denied, "side_agent_list"), {})
    expect(listed.output).toContain("No background")
  })

  test("admitChild()===true spawns exactly once AND the daemon is registered (paired control)", async () => {
    const reg = fakeRegistry()
    const allowed = sideAgentTools(reg, () => true)
    const res = await run(byName(allowed, "side_agent_spawn"), spawnInput)
    expect(res.ok).toBe(true)
    // Paired-control real effect: the SAME registry, only the predicate flipped,
    // now DID create — spawn entered once and list reflects the live daemon. This
    // proves the deny above is driven by the predicate, not by a broken registry.
    expect(reg._spawnCalls).toBe(1)
    const listed = await run(byName(allowed, "side_agent_list"), {})
    expect(listed.output).toContain("sa-1")
  })

  test("admitChild is consulted PER call (a later deny still blocks after an earlier allow)", async () => {
    // A stateful predicate: admit the first spawn, deny the second. Proves the gate
    // is evaluated on every execute (not cached / not read once at build time) —
    // a mutation that hoisted the check to build-time would let the 2nd through.
    const reg = fakeRegistry()
    let calls = 0
    const tools = sideAgentTools(reg, () => {
      calls += 1
      return calls === 1
    })
    const first = await run(byName(tools, "side_agent_spawn"), spawnInput)
    const second = await run(byName(tools, "side_agent_spawn"), spawnInput)
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(false)
    expect(second.reason).toBe("depth_exceeded")
    expect(reg._spawnCalls).toBe(1) // only the admitted call reached the registry
  })
})

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
