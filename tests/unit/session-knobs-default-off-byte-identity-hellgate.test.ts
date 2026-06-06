// Hellgate — jun-05 SESSION-KNOBS default-OFF BYTE-IDENTITY (ROUND 2,
// BYTE-IDENTITY / COMPOSITION lens).
//
// Every default-OFF knob added this session claims: with its gate UNSET it is a
// PERFECT no-op — strict parse (only the EXACT enabling value flips it), the
// gated tool is ABSENT from the default tool menu, and no background work runs.
// A leak here means a "default-OFF" feature silently changes production
// behavior. This battery PINS the invariant per-knob (the deliverable even where
// no bug exists) so a future edit that loosens a parse or drops a registration
// guard fails CI loudly.
//
// Four collective + per-knob checks:
//   1. STRICT PARSE — each strict-`1` knob reads `false` for every non-`1`
//      value (`"0"`, `"true"`, `"on"`, `"yes"`, `" 1"`, `"TRUE"`) and `true`
//      ONLY for the exact `"1"`. A loose parse here = accidental-enable.
//   2. TOOL-ABSENT-WHEN-OFF — `buildDefaultTools()` (no ports) === BASE exactly;
//      no gated tool from this session leaks into the unconditional base menu.
//   3. GATE-IS-LIVE — passing the port/flag DOES register the gated tool (proves
//      the conditional guard is real, not stuck-off — so "absent when OFF" is a
//      gate, not a coincidence).
//   4. NO-BG-WORK — the retention sweep is a `{ skipped: "no-policy" }` no-op
//      when its byte cap is unset (no disk read, no rewrite).

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { sweepSessionTranscripts } from "@/apps/cli/session-transcript-retention"
import { __resetRuntimeConfig, runtimeConfig } from "@/shared/runtime-config"
import {
  BASE_TOOL_NAMES,
  buildDefaultTools,
  type DefaultToolPorts,
  GATED_TOOLS,
  type Tool,
} from "@/tool"

/** Every strict-`1` knob added/owned this session, keyed by the env var, with a
 *  reader for its `RuntimeConfig` boolean projection. The invariant: each reads
 *  `false` for ANY value other than the exact string `"1"`. */
const STRICT_ONE_KNOBS: ReadonlyArray<{
  readonly env: string
  readonly read: (c: ReturnType<typeof runtimeConfig>) => boolean
}> = [
  { env: "QUANTA_BG_COMPACTION", read: (c) => c.bgCompaction },
  { env: "QUANTA_UNTRUSTED_ENVELOPE", read: (c) => c.untrustedEnvelope },
  { env: "QUANTA_EDIT_REPAIR_LOOP", read: (c) => c.editRepairLoop },
  { env: "QUANTA_SKILL_MCP_DEPS", read: (c) => c.skillMcpDeps },
  { env: "QUANTA_MCP_SAMPLING", read: (c) => c.mcpSampling },
  { env: "QUANTA_MCP_ROOTS", read: (c) => c.mcpRoots },
  { env: "QUANTA_MCP_OAUTH", read: (c) => c.mcpOAuth },
  { env: "QUANTA_READ_DEDUP", read: (c) => c.readDedup },
  { env: "QUANTA_PASSIVE_VCS", read: (c) => c.passiveVcs },
  { env: "QUANTA_IMAGE_GEN", read: (c) => c.imageGen },
  { env: "QUANTA_OFFICE_AUTHORING", read: (c) => c.officeAuthoring },
  { env: "QUANTA_REASONING_CARRYOVER", read: (c) => c.reasoningCarryover },
  { env: "QUANTA_GOAL_ENFORCE", read: (c) => c.goalContinuationEnforce },
  { env: "QUANTA_MIGRATE_CONFIG", read: (c) => c.migrateConfig },
  { env: "QUANTA_OBJECTIVE_BUDGET_ENFORCE", read: (c) => c.objectiveBudgetEnforce },
  { env: "QUANTA_AUTO_DREAM", read: (c) => c.autoDream },
  { env: "QUANTA_TEAM_DAG", read: (c) => c.teamDag },
  { env: "QUANTA_TEAM_BROKER", read: (c) => c.teamBroker },
  { env: "QUANTA_TEAM_IDLE", read: (c) => c.teamIdle },
  { env: "QUANTA_ARTIFACT_STORE", read: (c) => c.artifactStore },
  { env: "QUANTA_SIDE_AGENT", read: (c) => c.sideAgent },
  { env: "QUANTA_MCP_CONNECTORS", read: (c) => c.mcpConnectors },
  { env: "QUANTA_MCP_RESOURCES", read: (c) => c.mcpResources },
  { env: "QUANTA_PROGRESS_UPDATE", read: (c) => c.progressUpdate },
  { env: "QUANTA_PTY_ATTACH", read: (c) => c.ptyAttach },
  { env: "QUANTA_FILE_HISTORY", read: (c) => c.fileHistory },
  // §5 prompt-directive bundle (jun-06) — seven DEFAULT-OFF directive knobs.
  { env: "QUANTA_DIRECTIVE_AUTONOMOUS", read: (c) => c.directiveAutonomous },
  { env: "QUANTA_DIRECTIVE_READ_COMPLETE", read: (c) => c.directiveReadComplete },
  { env: "QUANTA_DIRECTIVE_PROGRESS", read: (c) => c.directiveProgress },
  { env: "QUANTA_DIRECTIVE_MEMORY_VERIFY", read: (c) => c.directiveMemoryVerify },
  { env: "QUANTA_DIRECTIVE_THINK_FREQ", read: (c) => c.directiveThinkFreq },
  { env: "QUANTA_DIRECTIVE_ANTI_PLATITUDE", read: (c) => c.directiveAntiPlatitude },
  { env: "QUANTA_DIRECTIVE_PARALLEL_TOOLS", read: (c) => c.directiveParallelTools },
  // RFC jun-6 §5.2 — advisor timing-rail directive (strict-`1` opt-in).
  { env: "QUANTA_ADVISOR_RAIL", read: (c) => c.directiveAdvisorRail },
  // RFC jun-6-code-mode Phase 3 — code_mode_only steering (strict-`1` opt-in).
  { env: "QUANTA_CODE_MODE_ONLY", read: (c) => c.codeModeOnly },
]

/** Hostile / loose values a strict-`1` knob MUST treat as OFF. `"1"` is tested
 *  separately as the ONLY enabling value. */
const NON_ENABLING_VALUES = [
  "0",
  "true",
  "TRUE",
  "True",
  "on",
  "ON",
  "yes",
  "false",
  " 1",
  "1 ",
  " 1 ",
  "01",
  "1.0",
  "",
  "enabled",
  "2",
] as const

/** All env vars this battery drives — snapshot+strip before each test so the
 *  ambient shell can't pre-enable a gate (and restore after). */
const ALL_KNOBS = [
  ...STRICT_ONE_KNOBS.map((k) => k.env),
  "QUANTA_SESSION_TRANSCRIPT_MAX_BYTES",
  "QUANTA_BRIEF",
] as const

const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ALL_KNOBS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  __resetRuntimeConfig()
})

afterEach(() => {
  for (const k of ALL_KNOBS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  __resetRuntimeConfig()
})

const toolNames = (tools: readonly Tool[]): string[] => tools.map((t) => t.name).sort()

// ─── 1. STRICT PARSE — only the exact `"1"` enables ────────────────────────────

describe('session-knobs default-OFF — strict `=== "1"` parse (no accidental-enable)', () => {
  test("with EVERY strict-`1` knob unset, every boolean projection reads false", () => {
    const c = runtimeConfig()
    const on: string[] = []
    for (const k of STRICT_ONE_KNOBS) {
      if (k.read(c) !== false) on.push(k.env)
    }
    // LOUD: name every gate that is unexpectedly ON at the bare default.
    expect(on).toEqual([])
  })

  test("each strict-`1` knob stays false for EVERY non-`1` value", () => {
    const leaked: string[] = []
    for (const k of STRICT_ONE_KNOBS) {
      for (const bad of NON_ENABLING_VALUES) {
        process.env[k.env] = bad
        __resetRuntimeConfig()
        if (k.read(runtimeConfig()) !== false) leaked.push(`${k.env}=${JSON.stringify(bad)}`)
        delete process.env[k.env]
        __resetRuntimeConfig()
      }
    }
    // Any entry here is an ACCIDENTAL-ENABLE (a loose parse flipped a default-OFF
    // gate ON for a non-`1` value).
    expect(leaked).toEqual([])
  })

  test('each strict-`1` knob DOES flip true for the exact `"1"` (gate is live, not stuck-off)', () => {
    const stuckOff: string[] = []
    for (const k of STRICT_ONE_KNOBS) {
      process.env[k.env] = "1"
      __resetRuntimeConfig()
      if (k.read(runtimeConfig()) !== true) stuckOff.push(k.env)
      delete process.env[k.env]
      __resetRuntimeConfig()
    }
    expect(stuckOff).toEqual([])
  })
})

// ─── 2. TOOL-ABSENT-WHEN-OFF — base menu has no gated leak ──────────────────────

describe("session-knobs default-OFF — gated tool ABSENT from the default menu", () => {
  test("buildDefaultTools() (no ports) === BASE_TOOL_NAMES exactly", () => {
    expect(toolNames(buildDefaultTools())).toEqual([...BASE_TOOL_NAMES].sort())
  })

  test("no session-gated tool leaks into the unconditional base set", () => {
    // Every tool this session gates behind a port/flag. NONE may appear in the
    // port-less default menu.
    const SESSION_GATED = [
      "image_gen",
      "xlsx_write",
      "docx_write",
      "pptx_write",
      "artifact_list",
      "artifact_register",
      "artifact_get",
      "artifact_destroy",
      "mcp_connector_list",
      "mcp_connector_install",
      "mcp_list_resources",
      "mcp_read_resource",
      "mcp_list_prompts",
      "mcp_get_prompt",
      "communicate_update",
      "side_agent_spawn",
      "side_agent_list",
      "side_agent_stop",
      "side_agent_findings",
      "pty_attach",
      "pty_list",
      "pty_write",
      "pty_read",
      "pty_resize",
      "pty_kill",
    ]
    const base = new Set(toolNames(buildDefaultTools()))
    const leaked = SESSION_GATED.filter((n) => base.has(n))
    // Any name here = a DEFAULT-ON-LEAK (a "default-OFF" tool registered
    // unconditionally).
    expect(leaked).toEqual([])
  })

  test("every session-gated tool is a GATED_TOOLS manifest entry (never BASE)", () => {
    const baseNames = new Set(BASE_TOOL_NAMES)
    const gatedNames = new Set(GATED_TOOLS.flatMap((e) => [e.name, ...(e.group ?? [])]))
    for (const name of [
      "image_gen",
      "xlsx_write",
      "docx_write",
      "pptx_write",
      "artifact_list",
      "mcp_connector_list",
      "mcp_list_resources",
      "communicate_update",
      "side_agent_spawn",
      "pty_attach",
    ]) {
      expect(baseNames.has(name)).toBe(false)
      expect(gatedNames.has(name)).toBe(true)
    }
  })
})

// ─── 3. GATE-IS-LIVE — wiring the port DOES register the tool ───────────────────

describe("session-knobs default-OFF — conditional-registration guard is LIVE", () => {
  // A throwaway duck port — the build-time registration closes over the port but
  // never CALLS it, so an empty object satisfies the guard and proves the tool is
  // appended ONLY when the slot is present.
  const duck = {} as never

  test("each port/flag, when present, ADDS exactly its tool(s) to the menu (over BASE)", () => {
    const baseSet = new Set(toolNames(buildDefaultTools()))
    const cases: ReadonlyArray<{
      readonly ports: DefaultToolPorts
      readonly adds: readonly string[]
    }> = [
      { ports: { imageGen: duck }, adds: ["image_gen"] },
      { ports: { officeAuthoring: true }, adds: ["xlsx_write", "docx_write", "pptx_write"] },
      {
        ports: { artifactRegistry: duck },
        adds: ["artifact_list", "artifact_register", "artifact_get", "artifact_destroy"],
      },
      { ports: { mcpConnectors: duck }, adds: ["mcp_connector_list", "mcp_connector_install"] },
      {
        ports: { mcpResources: duck },
        adds: ["mcp_list_resources", "mcp_read_resource", "mcp_list_prompts", "mcp_get_prompt"],
      },
      { ports: { progressUpdate: true }, adds: ["communicate_update"] },
      {
        ports: { ptySession: duck },
        adds: ["pty_attach", "pty_list", "pty_write", "pty_read", "pty_resize", "pty_kill"],
      },
    ]
    for (const c of cases) {
      const names = new Set(toolNames(buildDefaultTools(c.ports)))
      for (const add of c.adds) {
        // present WITH the port…
        expect(names.has(add)).toBe(true)
        // …and absent WITHOUT it (the guard is a real two-way gate).
        expect(baseSet.has(add)).toBe(false)
      }
    }
  })

  test("a present port adds ONLY its own tools (no cross-bleed into other gated sets)", () => {
    const baseSet = new Set(toolNames(buildDefaultTools()))
    const withImageGen = new Set(toolNames(buildDefaultTools({ imageGen: {} as never })))
    const added = [...withImageGen].filter((n) => !baseSet.has(n))
    expect(added).toEqual(["image_gen"])
  })
})

// ─── 4. NO-BG-WORK — retention sweep is inert when its cap is unset ─────────────

describe("session-knobs default-OFF — no background work when OFF", () => {
  test("retention sweep is a `no-policy` skip when the byte-cap knob is unset", async () => {
    expect(runtimeConfig().sessionTranscriptMaxBytes).toBeUndefined()
    // No root override either — the sweep must short-circuit on the absent cap
    // BEFORE listing any directory (no disk read, no rewrite).
    const res = await sweepSessionTranscripts()
    expect(res).toEqual({ skipped: "no-policy" })
  })

  test("retention sweep stays a skip for a non-positive-int cap value", async () => {
    for (const bad of ["0", "-1", "abc", "1.5", ""]) {
      process.env.QUANTA_SESSION_TRANSCRIPT_MAX_BYTES = bad
      __resetRuntimeConfig()
      expect(runtimeConfig().sessionTranscriptMaxBytes).toBeUndefined()
      const res = await sweepSessionTranscripts()
      expect(res).toEqual({ skipped: "no-policy" })
      delete process.env.QUANTA_SESSION_TRANSCRIPT_MAX_BYTES
      __resetRuntimeConfig()
    }
  })
})

// ─── 5. C3 brief — DOCUMENTED-loose seed (NOT a leak), pinned explicitly ────────

describe("session-knobs default-OFF — C3 brief seed is OFF at default", () => {
  test("brief seed is false with QUANTA_BRIEF unset (byte-identical dynamic tail)", () => {
    expect(runtimeConfig().brief).toBe(false)
  })

  test("brief uses the DOCUMENTED boolean-knob vocabulary (1/true/on) — pinned, not a regression", () => {
    // C3 is INTENTIONALLY a loose boolean seed (mirrors the `effort` env seed),
    // documented on the RuntimeConfig field. This is NOT a strict-`1` gate; we
    // pin the contract so a future tightening/loosening is a deliberate decision.
    for (const on of ["1", "true", "TRUE", "on", "ON"]) {
      process.env.QUANTA_BRIEF = on
      __resetRuntimeConfig()
      expect(runtimeConfig().brief).toBe(true)
      delete process.env.QUANTA_BRIEF
      __resetRuntimeConfig()
    }
    for (const off of ["0", "no", "false", "yes", "2", ""]) {
      process.env.QUANTA_BRIEF = off
      __resetRuntimeConfig()
      expect(runtimeConfig().brief).toBe(false)
      delete process.env.QUANTA_BRIEF
      __resetRuntimeConfig()
    }
  })
})
