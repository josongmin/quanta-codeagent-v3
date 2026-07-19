import { describe, expect, test } from "bun:test"
import { defaultCheckpointPolicy } from "@/agent/checkpoint-policy"
import { defaultGranularCheckpointPolicy } from "@/agent/per-tool-checkpoint"
import { buildPerToolCheckpointWire } from "@/apps/cli/repl/per-tool-checkpoint-wire"

describe("CLI per-tool record lifecycle", () => {
  test("uses the bounded `/rewind-tool` registry and clears it on dispose", () => {
    const wire = buildPerToolCheckpointWire({
      shadowOdb: {} as never,
      workspace: "/workspace",
    })
    const tag = wire.policy.computeTag({
      workspace: "/workspace",
      toolName: "edit",
      toolCallId: "call_cli_1",
    }) as string
    wire.policy.recordAnchorSha(tag, "a".repeat(40), {
      workspace: "/workspace",
      toolName: "edit",
      toolCallId: "call_cli_1",
    })
    expect(wire.registry.list()).toHaveLength(1)
    wire.dispose()
    expect(wire.registry.list()).toEqual([])
  })

  test("retains only the configured bounded anchor window", () => {
    const base = defaultCheckpointPolicy({ mode: "per-mutating", odb: {} as never })
    const policy = defaultGranularCheckpointPolicy({
      base,
      granularity: "tool",
      maxRegistryEntries: 2,
    })
    for (const toolCallId of ["call_1", "call_2", "call_3"]) {
      const anchor = { workspace: "/workspace", toolName: "edit", toolCallId }
      policy.recordAnchorSha(policy.computeTag(anchor) as string, toolCallId, anchor)
    }
    expect(policy.registry.list().map((entry) => entry.toolCallId)).toEqual(["call_3", "call_2"])
  })
})
