/**
 * Hellgate — side-agent `metadata` round-trip (jun-7).
 *
 * A new optional `metadata` (record<string,string>) field on the spawn schema
 * must flow: model input (`side_agent_spawn`) → `toSpec` passthrough →
 * `SideAgentSpecView.metadata` → the daemon registry's captured spec → the
 * `side_agent_list` snapshot view. This pins that the tag survives the snake_case
 * → camelCase normalization AND lands on the spawned spec the registry stores.
 *
 * Red-on-injection: drop the `metadata` clause from `toSpec` (or the schema
 * field) and the captured spec loses the tag, failing the spawn assertion.
 *
 * Style mirrors `tests/unit/side-agent-tools-hellgate.test.ts` (fake registry +
 * real `Tool.execute` generators). Hermetic: in-memory registry, no daemons.
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

/** Fake registry that CAPTURES every spawned spec so the test can read back the
 *  normalized `metadata` (the snapshot/list view also exposes `spec.metadata`). */
const capturingRegistry = (): SideAgentDaemonPort & {
  specs: SideAgentSpecView[]
} => {
  const snaps: SideAgentSnapshotView[] = []
  const specs: SideAgentSpecView[] = []
  let n = 0
  return {
    specs,
    spawn(spec: SideAgentSpecView): string {
      specs.push(spec)
      n += 1
      const id = `sa-${n}`
      snaps.unshift({ id, status: "running", spec, wakesDone: 0, startedAt: 1000 })
      return id
    },
    findings(): ReadonlyArray<SideAgentFindingView> {
      return []
    },
    list() {
      return snaps
    },
    stop() {
      return true
    },
  }
}

const baseInput = {
  task: "watch the build",
  trigger: { kind: "interval", every_ms: 5000 },
  max_wakes: 5,
  max_turns_per_wake: 2,
}

describe("side_agent_spawn — metadata round-trips into the spec + snapshot", () => {
  test("metadata passes through toSpec onto the captured spec (and list snapshot)", async () => {
    const reg = capturingRegistry()
    const tools = sideAgentTools(reg)
    const res = await run(byName(tools, "side_agent_spawn"), {
      ...baseInput,
      metadata: { owner: "ci", purpose: "flake-watch" },
    })
    expect(res.ok).toBe(true)

    // toSpec passthrough → registry's captured spec carries the metadata verbatim.
    expect(reg.specs).toHaveLength(1)
    expect(reg.specs[0]?.metadata).toEqual({ owner: "ci", purpose: "flake-watch" })

    // The snapshot the list view renders over also holds it (spec.metadata).
    expect(reg.list()[0]?.spec.metadata).toEqual({ owner: "ci", purpose: "flake-watch" })

    // And the list tool still renders the daemon (smoke that the view is intact).
    const listed = await run(byName(tools, "side_agent_list"), {})
    expect(listed.ok).toBe(true)
    expect(listed.output).toContain("sa-1")
  })

  test("metadata OMITTED ⇒ spec has no metadata key (byte-identical / exactOptional honest)", async () => {
    const reg = capturingRegistry()
    const tools = sideAgentTools(reg)
    const res = await run(byName(tools, "side_agent_spawn"), baseInput)
    expect(res.ok).toBe(true)
    expect(reg.specs[0]?.metadata).toBeUndefined()
    expect("metadata" in (reg.specs[0] as object)).toBe(false)
  })

  test("non-string metadata VALUE is rejected (schema record<string,string>) ⇒ ok:false, no spawn", async () => {
    const reg = capturingRegistry()
    const tools = sideAgentTools(reg)
    const res = await run(byName(tools, "side_agent_spawn"), {
      ...baseInput,
      metadata: { owner: 123 },
    })
    expect(res.ok).toBe(false)
    expect(reg.specs).toHaveLength(0)
  })

  test("empty metadata object is accepted and round-trips as {}", async () => {
    const reg = capturingRegistry()
    const tools = sideAgentTools(reg)
    const res = await run(byName(tools, "side_agent_spawn"), { ...baseInput, metadata: {} })
    expect(res.ok).toBe(true)
    expect(reg.specs[0]?.metadata).toEqual({})
  })
})
