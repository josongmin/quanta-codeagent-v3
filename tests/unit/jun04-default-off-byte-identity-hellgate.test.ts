// Hellgate — jun-04 COLLECTIVE default-OFF byte-identity (ROUND 2, Part A).
//
// Every jun-04 feature ships behind a strict `=== "1"` env gate and claims
// "default-OFF ⇒ byte-identical". The per-feature hellgates prove each in
// ISOLATION. This battery proves the guarantee holds COLLECTIVELY — one source
// of truth that NO new feature silently flipped a gate ON, leaked a gated tool
// into the unconditional base set, or left a tool unclassified in the
// plan-mode mutating table. A single drift here = a default-posture regression.
//
// Three collective checks:
//   1. With ALL jun-04 knobs UNSET, `runtimeConfig()` reports every OFF-by-
//      default gate `false`. The CLI-default-ON knobs are NOT in runtime-config
//      (they live in the tool-surface manifest / CLI seed) — documented below.
//   2. `buildDefaultTools()` (no ports) === BASE_TOOL_NAMES exactly: no jun-04
//      gated tool (image_gen / xlsx_write / docx_write / pptx_write /
//      coverage_check / apply_patch_structured / automation_update) leaked into
//      the unconditional base menu.
//   3. The mode.ts MUTATING_TOOL_TABLE classifies every BASE tool AND every
//      jun-04 gated tool — no UnknownToolError surface on plan-mode dispatch.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { isMutatingTool } from "@/agent/mode"
import { __resetRuntimeConfig, runtimeConfig } from "@/shared/runtime-config"
import { BASE_TOOL_NAMES, buildDefaultTools, GATED_TOOLS, type Tool } from "@/tool"

/** Every jun-04 (and sibling) env knob that MUST be unset for a clean default
 *  posture. Deleting them BEFORE `__resetRuntimeConfig()` forces a from-scratch
 *  parse against a stripped env. */
const JUN04_KNOBS = [
  "QUANTA_BG_COMPACTION",
  "QUANTA_UNTRUSTED_ENVELOPE",
  "QUANTA_EDIT_REPAIR_LOOP",
  "QUANTA_SKILL_MCP_DEPS",
  "QUANTA_MCP_SAMPLING",
  "QUANTA_DELTA_TOKEN_COUNT",
  "QUANTA_MCP_ROOTS",
  "QUANTA_MCP_OAUTH",
  "QUANTA_REASONING_CARRYOVER",
  "QUANTA_GOAL_ENFORCE",
  "QUANTA_OBJECTIVE_BUDGET_ENFORCE",
  "QUANTA_PASSIVE_VCS",
  "QUANTA_READ_DEDUP",
  "QUANTA_STALE_READ_GUARD",
  "QUANTA_MIGRATE_CONFIG",
  "QUANTA_AUTO_DREAM",
  "QUANTA_IMAGE_GEN",
  "QUANTA_OFFICE_AUTHORING",
  "QUANTA_COVERAGE_TOOL",
  "QUANTA_API_KEY_HELPER",
  "QUANTA_AWS_AUTH_REFRESH",
  "QUANTA_GCP_AUTH_REFRESH",
  // sibling default-OFF capability knobs that share the strict-`1` posture
  "QUANTA_TEAM_DAG",
  "QUANTA_TEAM_BROKER",
  "QUANTA_TEAM_IDLE",
] as const

/** The runtime-config BOOLEAN gates that MUST read `false` at default. Keyed by
 *  the RuntimeConfig field name. `passiveVcs`/`readDedup`/etc. are the boolean
 *  projections of the strict-`1` env knobs above. `STALE_READ_GUARD`,
 *  `MIGRATE_CONFIG` are reflected via their own fields. */
const EXPECT_FALSE_GATES: Record<string, (c: ReturnType<typeof runtimeConfig>) => boolean> = {
  bgCompaction: (c) => c.bgCompaction,
  untrustedEnvelope: (c) => c.untrustedEnvelope,
  editRepairLoop: (c) => c.editRepairLoop,
  skillMcpDeps: (c) => c.skillMcpDeps,
  mcpSampling: (c) => c.mcpSampling,
  deltaTokenCount: (c) => c.deltaTokenCount,
  mcpRoots: (c) => c.mcpRoots,
  mcpOAuth: (c) => c.mcpOAuth,
  readDedup: (c) => c.readDedup,
  passiveVcs: (c) => c.passiveVcs,
  imageGen: (c) => c.imageGen,
  officeAuthoring: (c) => c.officeAuthoring,
  reasoningCarryover: (c) => c.reasoningCarryover,
  goalContinuationEnforce: (c) => c.goalContinuationEnforce,
  migrateConfig: (c) => c.migrateConfig,
  objectiveBudgetEnforce: (c) => c.objectiveBudgetEnforce,
  autoDream: (c) => c.autoDream,
  teamDag: (c) => c.teamDag,
  teamBroker: (c) => c.teamBroker,
  teamIdle: (c) => c.teamIdle,
}

/** The H7 cloud-credential knobs are STRING-or-undefined (a command), not
 *  booleans — at default they MUST be `undefined` (no helper / no pre-call
 *  refresh wired ⇒ byte-identical provider path). */
const EXPECT_UNDEFINED_STRINGS: Record<string, (c: ReturnType<typeof runtimeConfig>) => unknown> = {
  apiKeyHelper: (c) => c.apiKeyHelper,
  awsAuthRefresh: (c) => c.awsAuthRefresh,
  gcpAuthRefresh: (c) => c.gcpAuthRefresh,
}

const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of JUN04_KNOBS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  __resetRuntimeConfig()
})

afterEach(() => {
  for (const k of JUN04_KNOBS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  __resetRuntimeConfig()
})

describe("jun-04 collective default-OFF — runtime-config gates", () => {
  test("every OFF-by-default boolean gate reads false with all knobs unset", () => {
    const c = runtimeConfig()
    const on: string[] = []
    for (const [name, read] of Object.entries(EXPECT_FALSE_GATES)) {
      if (read(c) !== false) on.push(name)
    }
    // LOUD: name every gate that is unexpectedly ON.
    expect(on).toEqual([])
  })

  test("every H7 cloud-credential knob is undefined (no helper / refresh wired)", () => {
    const c = runtimeConfig()
    const wired: string[] = []
    for (const [name, read] of Object.entries(EXPECT_UNDEFINED_STRINGS)) {
      if (read(c) !== undefined) wired.push(name)
    }
    expect(wired).toEqual([])
  })

  test("each gate flips ON only for the EXACT `1` value (no loose truthiness)", () => {
    // Sample three representative strict-`1` gates: a hostile `true`/`on`/`yes`
    // must NOT enable them (the strict-`1` posture is what makes default-OFF a
    // hard guarantee, not a coincidence).
    for (const bad of ["true", "on", "yes", "0", "TRUE", " 1"]) {
      process.env.QUANTA_PASSIVE_VCS = bad
      process.env.QUANTA_IMAGE_GEN = bad
      process.env.QUANTA_BG_COMPACTION = bad
      __resetRuntimeConfig()
      const c = runtimeConfig()
      expect(c.passiveVcs).toBe(false)
      expect(c.imageGen).toBe(false)
      expect(c.bgCompaction).toBe(false)
      delete process.env.QUANTA_PASSIVE_VCS
      delete process.env.QUANTA_IMAGE_GEN
      delete process.env.QUANTA_BG_COMPACTION
    }
    // And the exact `1` DOES enable (proves the gate is live, not stuck-off).
    process.env.QUANTA_PASSIVE_VCS = "1"
    __resetRuntimeConfig()
    expect(runtimeConfig().passiveVcs).toBe(true)
    delete process.env.QUANTA_PASSIVE_VCS
  })
})

const toolNames = (tools: readonly Tool[]): string[] => tools.map((t) => t.name).sort()

describe("jun-04 collective default-OFF — base tool menu has no gated leak", () => {
  test("buildDefaultTools() (no ports) === BASE_TOOL_NAMES exactly", () => {
    expect(toolNames(buildDefaultTools())).toEqual([...BASE_TOOL_NAMES].sort())
  })

  test("no jun-04 gated tool name appears in the unconditional base set", () => {
    // The jun-04 NEW-CATEGORY writers + observability tools are all port/flag
    // gated; none may be in BASE.
    const JUN04_GATED = [
      "image_gen",
      "xlsx_write",
      "docx_write",
      "pptx_write",
      "coverage_check",
      "prompt_cache_status",
      "apply_patch_structured",
      "automation_update",
    ]
    const base = new Set(toolNames(buildDefaultTools()))
    const leaked = JUN04_GATED.filter((n) => base.has(n))
    expect(leaked).toEqual([])
  })

  test("the gated readers (docx/pptx_read) ARE base, their writers are NOT", () => {
    const base = new Set(BASE_TOOL_NAMES)
    // readers: BASE (always-on, read-only).
    expect(base.has("docx_read")).toBe(true)
    expect(base.has("pptx_read")).toBe(true)
    expect(base.has("xlsx_read")).toBe(true)
    // writers: gated (must be a GATED_TOOLS entry, never base).
    expect(base.has("docx_write")).toBe(false)
    expect(base.has("pptx_write")).toBe(false)
    expect(base.has("xlsx_write")).toBe(false)
    const gatedNames = new Set(GATED_TOOLS.flatMap((e) => [e.name, ...(e.group ?? [])]))
    expect(gatedNames.has("xlsx_write")).toBe(true)
    expect(gatedNames.has("docx_write")).toBe(true)
    expect(gatedNames.has("image_gen")).toBe(true)
  })
})

describe("jun-04 collective default-OFF — mutating-table covers every tool (no UnknownToolError)", () => {
  test("every BASE tool is classified in MUTATING_TOOL_TABLE", () => {
    const unclassified: string[] = []
    for (const name of BASE_TOOL_NAMES) {
      try {
        isMutatingTool(name)
      } catch {
        unclassified.push(name)
      }
    }
    expect(unclassified).toEqual([])
  })

  test("every jun-04 gated tool is classified (host injecting it can't crash plan-mode)", () => {
    const JUN04_GATED = [
      "image_gen",
      "xlsx_write",
      "docx_write",
      "pptx_write",
      "coverage_check",
      "prompt_cache_status",
    ]
    const unclassified: string[] = []
    for (const name of JUN04_GATED) {
      try {
        isMutatingTool(name)
      } catch {
        unclassified.push(name)
      }
    }
    expect(unclassified).toEqual([])
  })

  test("the jun-04 writers are classified MUTATING; the observers READ-ONLY", () => {
    // image_gen + the three Office writers WRITE artifacts ⇒ mutating (blocked
    // in plan mode). coverage_check + prompt_cache_status are read-only.
    expect(isMutatingTool("image_gen")).toBe(true)
    expect(isMutatingTool("xlsx_write")).toBe(true)
    expect(isMutatingTool("docx_write")).toBe(true)
    expect(isMutatingTool("pptx_write")).toBe(true)
    expect(isMutatingTool("coverage_check")).toBe(false)
    expect(isMutatingTool("prompt_cache_status")).toBe(false)
    // the jun-04 readers are read-only.
    expect(isMutatingTool("docx_read")).toBe(false)
    expect(isMutatingTool("pptx_read")).toBe(false)
  })
})
