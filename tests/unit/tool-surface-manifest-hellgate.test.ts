// Hellgate — tool-surface SSOT two-way drift guard (jun-03).
//
// The manifest (`src/tool/surface/manifest.ts`) is the single managed catalog
// of the LLM tool-access axis. These tests PIN it against the REAL registry +
// the gated tool factories so it cannot silently rot:
//   - BASE: buildDefaultTools() (no ports) === BASE_TOOL_NAMES (exact, sorted).
//   - GATED: each gated factory's produced names === the manifest group for it
//     (two-way: a factory adding/removing a tool without a manifest edit fails).
//   - No duplicate names; the orphan `apply_patch_structured` (which was missing
//     from fc) is now accounted for AND only appears when its port is wired.
//   - The CLI default-ON tool-gate seed is derived from the SSOT, not a parallel
//     list — assert the resolved set.

import { describe, expect, test } from "bun:test"
import { execSync } from "node:child_process"
import { createObjectiveStore } from "@/agent/objective"
import { createSubagentMailbox } from "@/agent/subagent-mailbox"
import { createIntrospectTools, createSubagent6Tools, TaskRegistry } from "@/subagent"
import {
  ALL_MANIFEST_TOOL_NAMES,
  BASE_TOOL_NAMES,
  buildDefaultTools,
  entryToolNames,
  GATED_TOOLS,
  seedEnvVarsForSurface,
  type Tool,
} from "@/tool"
import { objectiveTools } from "@/tool/objective"
import { subagentMailboxTools } from "@/tool/subagent-mailbox"

const names = (tools: readonly Tool[]): string[] => tools.map((t) => t.name).sort()
const groupNames = (rep: string): string[] => {
  const entry = GATED_TOOLS.find((e) => e.name === rep)
  if (entry === undefined) throw new Error(`manifest has no entry for "${rep}"`)
  return [...entryToolNames(entry)].sort()
}

describe("tool-surface manifest — BASE drift guard", () => {
  test("buildDefaultTools() (no ports) === BASE_TOOL_NAMES exactly", () => {
    expect(names(buildDefaultTools())).toEqual([...BASE_TOOL_NAMES].sort())
  })

  test("every BASE name is unique and accounted for in the manifest", () => {
    const set = new Set(BASE_TOOL_NAMES)
    expect(set.size).toBe(BASE_TOOL_NAMES.length)
    for (const n of BASE_TOOL_NAMES) expect(ALL_MANIFEST_TOOL_NAMES).toContain(n)
  })
})

describe("tool-surface manifest — no orphans / no dups", () => {
  test("ALL_MANIFEST_TOOL_NAMES has no duplicates", () => {
    const set = new Set(ALL_MANIFEST_TOOL_NAMES)
    expect(set.size).toBe(ALL_MANIFEST_TOOL_NAMES.length)
  })

  test("apply_patch_structured is catalogued (the fc-orphan this SSOT fixes)", () => {
    expect(ALL_MANIFEST_TOOL_NAMES).toContain("apply_patch_structured")
  })

  test("apply_patch_structured registers ONLY when its port is set (byte-identical off)", () => {
    expect(names(buildDefaultTools())).not.toContain("apply_patch_structured")
    expect(names(buildDefaultTools({ structuredPatch: true }))).toContain("apply_patch_structured")
  })
})

describe("tool-surface manifest — GATED factories match the manifest two-way", () => {
  test("6-tool router names === manifest spawn_agent group", () => {
    const set = createSubagent6Tools({
      runner: async () => ({ ok: true, finalText: "", turns: 0, messages: [] }),
      registry: new TaskRegistry(),
    })
    expect(names(set.tools)).toEqual(groupNames("spawn_agent"))
  })

  test("objective tools === manifest objective_set group", () => {
    expect(names(objectiveTools(createObjectiveStore()))).toEqual(groupNames("objective_set"))
  })

  test("mailbox tools === manifest subagent_send_message group", () => {
    expect(names(subagentMailboxTools(createSubagentMailbox()))).toEqual(
      groupNames("subagent_send_message"),
    )
  })

  test("introspect (enableIntrospect) produces list_agents — in the manifest", () => {
    const tools = createIntrospectTools({ registry: new TaskRegistry(), enableIntrospect: true })
    for (const t of tools) expect(ALL_MANIFEST_TOOL_NAMES).toContain(t.name)
    expect(tools.map((t) => t.name)).toContain("list_agents")
  })
})

describe("tool-surface manifest — CLI default-ON seed derives from the SSOT", () => {
  test("seedEnvVarsForSurface('cli') is exactly the CLI-default-ON tool gates", () => {
    expect([...seedEnvVarsForSurface("cli")].sort()).toEqual(
      [
        "QUANTA_COVERAGE_TOOL",
        "QUANTA_ENABLE_STRUCTURED_PATCH",
        "QUANTA_OBJECTIVE_TOOLS",
        "QUANTA_PROMPT_CACHE_STATUS",
        "QUANTA_SIDE_AGENT",
        "QUANTA_SUBAGENT",
        "QUANTA_SUBAGENT_6TOOLS",
        "QUANTA_SUBAGENT_BATCH",
        "QUANTA_SUBAGENT_INTROSPECT",
        "QUANTA_SUBAGENT_MAILBOX",
        "QUANTA_TEAM_PEER_MSG",
      ].sort(),
    )
  })

  test("bench surface seeds NOTHING (shared-assembler byte-identity)", () => {
    // objective/mailbox are opt-in on bench; nothing should auto-seed there.
    expect(seedEnvVarsForSurface("bench")).toEqual([])
  })
})

describe("tool-surface manifest — FULL-universe completeness (the guard that was missing)", () => {
  // The original drift guard only checked SPECIFIC factories, so 17 registered
  // tools (advisor/delegate/plan/mcp-tasks/... + 3 ORPHANS) sat uncatalogued.
  // This source-scan pins EVERY `name: "x"` in the tool-defining slices against
  // the manifest, so a new tool — or a new orphan — can never silently escape.
  const scanRegisteredToolNames = (): Set<string> => {
    const out = execSync(
      // src/skill/skill-creator.ts is scanned explicitly so an agent-callable tool
      // defined OUTSIDE src/tool (skill_create lives there but is registered from
      // src/agent/tier1) cannot escape the manifest completeness scan. Scoped to the
      // single source file (not all of src/skill) to avoid picking up SKILL.md
      // frontmatter names / test-fixture `name:` literals that are not tools.
      "grep -rhoE 'name: \"[a-z_]+\"' src/tool src/subagent src/agent/tier1 src/skill/skill-creator.ts",
    ).toString()
    const re = /name: "([a-z_]+)"/g
    const found = new Set<string>()
    for (let m = re.exec(out); m !== null; m = re.exec(out)) found.add(m[1] as string)
    return found
  }

  test("every registered tool name is catalogued in the manifest (no uncatalogued tool)", () => {
    const manifest = new Set(ALL_MANIFEST_TOOL_NAMES)
    const uncatalogued = [...scanRegisteredToolNames()].filter((n) => !manifest.has(n)).sort()
    expect(uncatalogued).toEqual([])
  })

  test("every manifest name is a real registered tool (no stale rows)", () => {
    const found = scanRegisteredToolNames()
    const stale = [...new Set(ALL_MANIFEST_TOOL_NAMES)].filter((n) => !found.has(n)).sort()
    expect(stale).toEqual([])
  })

  test("jun-04 orphan resolution: all 3 former orphans are wired-or-deleted (zero unwired left)", () => {
    // The catalog opened jun-03 with 3 pure orphans (built, never wired). jun-04
    // resolved every one:
    //   - ai_attribution     → DELETED (no backend; only a no-op stub existed).
    //   - coverage_check      → WIRED (config-slot, QUANTA_COVERAGE_TOOL).
    //   - prompt_cache_status → WIRED (config-slot, QUANTA_PROMPT_CACHE_STATUS);
    //       the adapter→StreamEvent→loop cache-bucket feed was also wired so the
    //       observer the tool reads is actually populated.
    expect(ALL_MANIFEST_TOOL_NAMES).not.toContain("ai_attribution")
    expect(scanRegisteredToolNames().has("ai_attribution")).toBe(false)
    expect(GATED_TOOLS.find((e) => e.name === "coverage_check")?.gate.kind).toBe("config-slot")
    expect(GATED_TOOLS.find((e) => e.name === "prompt_cache_status")?.gate.kind).toBe("config-slot")
    expect(GATED_TOOLS.filter((e) => e.gate.kind === "unwired")).toEqual([])
  })

  test("the unwired-orphan catalog mechanism stays available (any future unwired entry must carry a reason)", () => {
    // `unwired` is still a valid catalogued state for a NEW orphan — it keeps the
    // orphan VISIBLE rather than silently dropped. Whenever one exists it must
    // document why it is parked (wire-or-delete decision pending).
    for (const e of GATED_TOOLS) {
      if (e.gate.kind === "unwired") expect(e.gate.reason.length).toBeGreaterThan(0)
    }
  })

  test("coverage_check registers ONLY when DefaultToolPorts.coverageCheck is true (default-OFF)", () => {
    const off = buildDefaultTools().map((t) => t.name)
    expect(off).not.toContain("coverage_check")
    const on = buildDefaultTools({ coverageCheck: true }).map((t) => t.name)
    expect(on).toContain("coverage_check")
  })
})
