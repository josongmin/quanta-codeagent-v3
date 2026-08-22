import { describe, expect, test } from "bun:test"
import { buildSubagentBlock } from "@/agent/tier1/subagent"
import type { AgentConfig } from "@/agent/types"
import { GATED_TOOLS } from "@/tool/surface/manifest"

// §25.1 — `run_workflow` LIVE WIRING hellgate. Proves the tier-1 subagent block
// registers `run_workflow` ONLY when `config.subagent.enableWorkflow` is set
// (DEFAULT-OFF byte-identical anchor), reusing the block's own runner — and that
// the tool is catalogued in the SSOT manifest as a real (non-unwired) gate.

// Minimal config stub — buildSubagentBlock reads `config.subagent` and passes
// the whole config to createSubagentRunner (a closure; never spawned here).
const cfg = (subagent: NonNullable<AgentConfig["subagent"]>): AgentConfig =>
  ({ subagent }) as unknown as AgentConfig

describe("run_workflow wiring (§25.1)", () => {
  test("DEFAULT-OFF: absent enableWorkflow ⇒ run_workflow NOT registered", () => {
    const block = buildSubagentBlock(cfg({}))
    expect(block?.extraTools.some((t) => t.name === "run_workflow")).toBe(false)
  })

  test("enableWorkflow:false ⇒ run_workflow NOT registered", () => {
    const block = buildSubagentBlock(cfg({ enableWorkflow: false }))
    expect(block?.extraTools.some((t) => t.name === "run_workflow")).toBe(false)
  })

  test("enableWorkflow:true ⇒ run_workflow IS registered on the subagent block", () => {
    const block = buildSubagentBlock(cfg({ enableWorkflow: true }))
    const tool = block?.extraTools.find((t) => t.name === "run_workflow")
    expect(tool).toBeDefined()
    // It is a mutating, non-read-only tool (spawns subagents that may write).
    expect(tool?.isReadOnly()).toBe(false)
  })

  test("the subagent block is undefined when subagent itself is disabled (no runner)", () => {
    // buildSubagentBlock returns undefined when config.subagent is absent, so
    // run_workflow cannot ride a non-existent runner.
    expect(buildSubagentBlock({} as unknown as AgentConfig)).toBeUndefined()
  })

  test("manifest catalogs run_workflow as a real (non-unwired) gate", () => {
    const entry = GATED_TOOLS.find((e) => e.name === "run_workflow")
    expect(entry).toBeDefined()
    expect(entry?.gate.kind).toBe("config-slot")
    expect(entry?.gate.kind === "config-slot" && entry.gate.env).toBe("QUANTA_WORKFLOW")
  })
})
