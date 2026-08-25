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
import { join } from "node:path"
import { createSubagentMailbox } from "@/agent/subagent-mailbox"
import { buildEnterPlanBlock, buildPlanExitBlock } from "@/agent/tier1"
import { createObjectiveCapabilities, createObjectiveStore } from "@/objective"
import { createIntrospectTools, createSubagent6Tools, TaskRegistry } from "@/subagent"
import {
  ALL_MANIFEST_TOOL_NAMES,
  BASE_TOOL_NAMES,
  buildDefaultTools,
  buildTerminalTools,
  entryToolNames,
  GATED_TOOLS,
  seedEnvVarsForSurface,
  TOOL_SURFACES,
  type Tool,
} from "@/tool"
import { objectiveTools } from "@/tool/objective"
import { createTmuxAdapter } from "@/tool/pty"
import { subagentMailboxTools } from "@/tool/subagent-mailbox"
import { loadFeatures } from "../../tools/feature-catalog/schema"

// Load the REAL feature catalog once (top-level await, mirrors the pattern in
// feature-catalog-surface-integration.test.ts). Used by the manifest→catalog
// completeness gate below.
const CATALOG_DIR = join(import.meta.dir, "..", "..", "tools/feature-catalog/features")
const CATALOG_FEATURES = await loadFeatures(CATALOG_DIR)
// Full serialized text of every feature — captures config_refs.{env,runtime,cli,
// prefs}, knobs[].name, evidence.code, purpose / notes / surface_integration
// evidence prose. A gate env is "catalogued" iff its EXACT token appears in ANY
// feature's serialized form (the honest "is this gate documented anywhere?"
// question — not tied to one field, so a legitimate cross-reference counts).
const CATALOG_HAYSTACKS = CATALOG_FEATURES.map((f) => JSON.stringify(f))
// WORD-BOUNDARY match, NOT substring: several gate envs are prefixes of siblings
// (QUANTA_SUBAGENT ⊂ QUANTA_SUBAGENT_6TOOLS; QUANTA_LSP ⊂ QUANTA_LSP_TOOLS). A
// naive `.includes(env)` would count `QUANTA_SUBAGENT` as catalogued merely
// because a longer sibling is mentioned — a false pass. Require the token NOT be
// followed by a further env-name char (`[A-Z0-9_]`) so only the exact gate env
// (or a longer env's OWN full mention) satisfies it.
const cataloguedCache = new Map<string, boolean>()
const isCataloguedGateEnv = (envToken: string): boolean => {
  const cached = cataloguedCache.get(envToken)
  if (cached !== undefined) return cached
  // Escape is unnecessary — QUANTA_* tokens are [A-Z0-9_] only.
  const re = new RegExp(`${envToken}(?![A-Z0-9_])`)
  const found = CATALOG_HAYSTACKS.some((h) => re.test(h))
  cataloguedCache.set(envToken, found)
  return found
}

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

describe("tool-surface manifest — terminal:'on' rows are BUILD-PROVEN by buildTerminalTools", () => {
  // Closes the drift-guard blind spot (R1 audit): the full-universe scan proves a `name:"x"`
  // literal is CATALOGUED, but not that any builder EMITS it. A manifest row claiming
  // `default.terminal === "on"` must be produced by the real terminal builder — else the row
  // is a lie. Wire BOTH ports so every terminal-default tool can mint.
  const terminalBuilt = new Set(
    buildTerminalTools({
      containerExec: { exec: async () => ({ stdout: "", stderr: "", code: 0 }) },
      ptySession: createTmuxAdapter({ exec: { run: async () => ({ ok: true, stdout: "" }) } }),
    }).map((t) => t.name),
  )
  const terminalRows = GATED_TOOLS.filter((e) => e.default.terminal === "on")
  // Anti-vacuum: a loop that generates zero tests passes silently. Pin the row count + built size
  // so deleting the terminal:on defaults (or the builder) trips THIS non-looped assertion.
  test("there ARE terminal:on rows and the builder emits them all (not a vacuous loop)", () => {
    expect(terminalRows.length).toBeGreaterThan(0)
    const expected = terminalRows.flatMap((e) => [...entryToolNames(e)])
    expect(expected.length).toBeGreaterThanOrEqual(7) // container_exec + 6 pty_*
    for (const n of expected) expect(terminalBuilt.has(n)).toBe(true)
  })
  for (const entry of terminalRows) {
    for (const toolName of entryToolNames(entry)) {
      test(`buildTerminalTools emits "${toolName}" (manifest row claims terminal:on)`, () => {
        expect(terminalBuilt.has(toolName)).toBe(true)
      })
    }
  }
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
    // GOAL-02: the trio is built over the actor-fixed model capability + read port.
    const caps = createObjectiveCapabilities(createObjectiveStore())
    expect(names(objectiveTools({ model: caps.model, read: caps.read }))).toEqual(
      groupNames("objective_set"),
    )
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

  // R1/R3 audit blind-spot: the plan-lifecycle pair is registered off the
  // `planExitPort` AgentConfig slot (not a DefaultToolPort), so it bypassed the
  // terminal + GATED-factory two-way checks above. Pin BOTH directions here:
  // (a) the builder emits the manifest-catalogued name when the port is wired,
  // (b) it registers NOTHING when the port is absent (default-OFF byte-identical).
  const planExitPortStub = { requestExit: async () => ({ decision: "approved" as const }) }
  test("buildEnterPlanBlock emits enter_plan_mode (catalogued) when planExitPort wired", () => {
    const tool = buildEnterPlanBlock({ planExitPort: planExitPortStub } as never)
    expect(tool?.name).toBe("enter_plan_mode")
    expect(ALL_MANIFEST_TOOL_NAMES).toContain("enter_plan_mode")
  })
  test("buildPlanExitBlock emits request_plan_exit (catalogued) — the paired sibling", () => {
    const tool = buildPlanExitBlock({ planExitPort: planExitPortStub } as never)
    expect(tool?.name).toBe("request_plan_exit")
    expect(ALL_MANIFEST_TOOL_NAMES).toContain("request_plan_exit")
  })
  test("plan-lifecycle pair registers NOTHING without planExitPort (default-OFF, ship as a pair)", () => {
    expect(buildEnterPlanBlock({} as never)).toBeUndefined()
    expect(buildPlanExitBlock({} as never)).toBeUndefined()
  })
})

describe("tool-surface manifest — CLI default-ON seed derives from the SSOT", () => {
  test("search_codebase declares the default lexical wire, not the optional index promotion", () => {
    const entry = GATED_TOOLS.find((e) => e.name === "search_codebase")
    expect(entry).toBeDefined()
    expect(entry?.gate).toEqual({ kind: "config-slot", slot: "searchWire" })
    expect(entry?.default.cli).toBe("on")
    // QUANTA_INDEX controls semantic/hybrid promotion only.  If the manifest
    // grew an env gate here, the CLI seed would incorrectly turn indexing on.
    expect("env" in (entry?.gate ?? {})).toBe(false)
  })

  test("seedEnvVarsForSurface('cli') is exactly the CLI-default-ON tool gates", () => {
    // jun-26 coordination-trio gating: QUANTA_SUBAGENT_MAILBOX / QUANTA_TEAM_PEER_MSG /
    // QUANTA_OBJECTIVE_TOOLS were FLIPPED to opt-in (engagement-UNVERIFIED, frontier
    // ships ONE Task tool), so the CLI no longer auto-seeds them. The remaining
    // spawn-core gates (subagent / 6tools / batch / introspect) stay default-ON.
    expect([...seedEnvVarsForSurface("cli")].sort()).toEqual(
      [
        "QUANTA_COVERAGE_TOOL",
        "QUANTA_ENABLE_STRUCTURED_PATCH",
        "QUANTA_MEMORY", // memory_search/write/update trio — CLI default-ON (ADR-0413)
        "QUANTA_PROMPT_CACHE_STATUS",
        "QUANTA_SIDE_AGENT",
        "QUANTA_SUBAGENT",
        "QUANTA_SUBAGENT_6TOOLS",
        "QUANTA_SUBAGENT_BATCH",
        "QUANTA_SUBAGENT_INTROSPECT",
      ].sort(),
    )
  })

  test("coordination trio (mailbox/team/objective) is NOT auto-seeded on any surface", () => {
    // jun-26 frontier tool-impl audit: these 3 are opt-in EVERYWHERE until a live
    // engagement smoke proves the model uses them. The CLI seed deriving from the
    // SSOT means flipping the manifest default is the ONLY lever — assert the
    // trio's env gates appear in NO surface's seed set (red-on-injection: restoring
    // any trio entry's `cli: "on"` re-introduces its env here and fails this).
    const trio = ["QUANTA_SUBAGENT_MAILBOX", "QUANTA_TEAM_PEER_MSG", "QUANTA_OBJECTIVE_TOOLS"]
    for (const surface of TOOL_SURFACES) {
      const seeded = new Set(seedEnvVarsForSurface(surface))
      for (const env of trio) expect(seeded.has(env)).toBe(false)
    }
  })

  test("coordination trio is opt-in on every surface in the manifest (no `on` default)", () => {
    for (const rep of ["subagent_send_message", "team_create", "objective_set"]) {
      const entry = GATED_TOOLS.find((e) => e.name === rep)
      if (entry === undefined) throw new Error(`manifest has no entry for "${rep}"`)
      for (const surface of TOOL_SURFACES) {
        // explicit `on` is the only state that auto-seeds; the trio must never carry it
        expect(entry.default[surface]).not.toBe("on")
      }
    }
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
      // src/agent/budget-tool.ts and src/agent/memory-tools.ts define tools that
      // live outside src/agent/tier1 (they are not tier-1 session-feature builders,
      // but leaf tool factories that get composed at the runner level). Extend the
      // scan so these tools cannot silently escape the two-way drift guard.
      "grep -rhoE 'name: \"[a-z_]+\"' src/tool src/subagent src/agent/tier1 src/agent/budget-tool.ts src/agent/memory-tools.ts src/skill/skill-creator.ts",
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

describe("tool-surface manifest — worktree group is CLI-honest (R4-5 finding #3)", () => {
  // The worktree slot (`AgentConfig.activeWorktreeSlot`) is MINTED at exactly ONE
  // call site — `mintActiveWorktreeSlot` in the CLI repl runtime-context. So the
  // worktree tools are reachable ONLY on the CLI surface; advertising them as
  // `opt-in` on bench/web/ide/headless claimed a capability those surfaces never
  // deliver (a 4-surface false-parity). The manifest must list the worktree group
  // as CLI-only so it does not over-promise.
  const worktreeEntry = () => {
    const e = GATED_TOOLS.find((x) => x.name === "enter_worktree")
    if (e === undefined) throw new Error("manifest has no enter_worktree entry")
    return e
  }

  test("the worktree group advertises availability on the CLI surface ONLY", () => {
    const e = worktreeEntry()
    // The EXPLICIT per-surface availability map names exactly `cli` — the single
    // surface that mints the slot. (Omitted surfaces inherit `opt-in` in the
    // resolver, but the manifest must not assert the others as deliverable.)
    expect(Object.keys(e.default)).toEqual(["cli"])
    expect(e.default.cli).toBe("opt-in")
    // The non-CLI surfaces are NOT explicitly advertised (no mint site there).
    for (const s of TOOL_SURFACES) {
      if (s === "cli") continue
      expect(e.default[s]).toBeUndefined()
    }
  })
})

describe("tool-surface manifest — manifest→CATALOG completeness gate (root-cause, jul-03)", () => {
  // ROOT-CAUSE GATE. The knob-registry completeness ratchet forces every gate
  // env to be DECLARED in a knob registry (discoverability). This is its FEATURE
  // -CATALOG counterpart: every gate env on a real GATED_TOOLS row must also be
  // CATALOGUED — mentioned by some feature yaml (config_refs / evidence / knobs /
  // prose). Together they close the drift that let jul-03 land tools + gates
  // (browser_network, projects_kb, threads_handoff, mcp_read_resource_dir, the
  // B5 presence gate, …) that were WIRED in src but INVISIBLE in the catalog.
  //
  // A NEW landed-but-uncatalogued gate goes RED here automatically → catalog it
  // (add its env to a feature yaml) or, if it is a known backlog stub not yet
  // written up, park it in KNOWN_UNCATALOGUED_GATES with a reason. That list may
  // only ever SHRINK (a decreasing-ceiling burn-down) — a NEW entry is a
  // governance regression, exactly like the knob ratchet's EXCEPTIONS.

  /** Every `gate.env` on a real GATED_TOOLS row (env-flag / config-slot /
   *  resource kinds carry an optional `env`). */
  const gateEnvs = (): string[] => {
    const out = new Set<string>()
    for (const e of GATED_TOOLS) {
      const g = e.gate as { env?: string }
      if (typeof g.env === "string" && g.env.length > 0) out.add(g.env)
    }
    return [...out].sort()
  }

  // PRE-EXISTING uncatalogued gate envs (jul-03 baseline high-water mark). These
  // are real gates whose FEATURE write-up is a known backlog item — NOT part of
  // the jul-03 absorbed-feature drift this gate was built to close. Each must
  // carry a reason. BURN-DOWN ONLY: remove an entry when its feature yaml lands;
  // never add one (a NEW uncatalogued gate is the regression this gate catches).
  const KNOWN_UNCATALOGUED_GATES: ReadonlyMap<string, string> = new Map<string, string>([
    [
      "QUANTA_CONTAINER_EXEC",
      "terminal container_exec gate — declared in the knob-inventory SSOT; a dedicated terminal-surface feature yaml is a backlog item",
    ],
    ["QUANTA_DEBUG_TOOLS", "debug tool group gate — pre-existing, no feature yaml yet"],
    [
      "QUANTA_SHADOW",
      "shadow-workspace checkpoint/rewind tool gate (shadowOdb) — pre-existing, no feature yaml yet (distinct from the catalogued QUANTA_SHADOW_VERIFY knob)",
    ],
    ["QUANTA_SUBAGENT_6TOOLS", "subagent 6-tool router gate — pre-existing, no feature yaml yet"],
    ["QUANTA_SUBAGENT_BG", "subagent background-run gate — pre-existing, no feature yaml yet"],
    [
      "QUANTA_TB_WRITE_TOOL",
      "terminal container_write_file gate (B2 TB lever) — pre-existing, no feature yaml yet",
    ],
    ["QUANTA_TEST_RUNNER", "test_runner tool gate — pre-existing, no feature yaml yet"],
  ])

  test("every GATED_TOOLS gate.env is catalogued in some feature yaml (or a known backlog stub)", () => {
    const uncatalogued = gateEnvs().filter(
      (env) => !isCataloguedGateEnv(env) && !KNOWN_UNCATALOGUED_GATES.has(env),
    )
    if (uncatalogued.length > 0) {
      throw new Error(
        `${uncatalogued.length} gated-tool gate env(s) are WIRED in src but CATALOGUED in NO ` +
          `feature yaml — a landed-but-uncatalogued tool/gate (the jul-03 drift class). ` +
          `Add each to a tools/feature-catalog/features/*.yaml (config_refs.env / evidence / ` +
          `knobs), or park it in KNOWN_UNCATALOGUED_GATES with a reason:\n` +
          uncatalogued.map((e) => `  ${e}`).join("\n"),
      )
    }
    expect(uncatalogued).toEqual([])
  })

  test("KNOWN_UNCATALOGUED_GATES entries each carry a reason (no bare parks)", () => {
    for (const [env, reason] of KNOWN_UNCATALOGUED_GATES) {
      expect(reason.length, `park for ${env} needs a reason`).toBeGreaterThan(0)
    }
  })

  test("the parked list contains no gate that is ALREADY catalogued (stale-park hygiene)", () => {
    // If a parked env later gets a feature yaml, remove it from the park — else
    // the park masks nothing and rots. This keeps the burn-down honest.
    const staleParks = [...KNOWN_UNCATALOGUED_GATES.keys()].filter((e) => isCataloguedGateEnv(e))
    expect(staleParks).toEqual([])
  })

  // RED-ON-INJECTION: prove the gate actually FIRES for an uncatalogued gate and
  // does NOT vacuously pass. The jul-03 features MUST be catalogued now (they were
  // the drift); a synthetic never-catalogued token MUST read as uncatalogued.
  test("gate catches drift (red-on-injection) and confirms the jul-03 features are catalogued", () => {
    // (a) the newly-catalogued jul-03 absorbed-feature gates read as CATALOGUED —
    //     this is exactly the drift the gate was written to have caught.
    for (const env of [
      "QUANTA_BROWSER_NETWORK",
      "QUANTA_PROJECTS_KB",
      "QUANTA_AUTOMATION", // threads_handoff shares this gate
      "QUANTA_MCP_RESOURCES", // mcp_read_resource_dir + list_resource_templates
      "QUANTA_ARTIFACT_STORE",
      "QUANTA_ASK_USER",
      "QUANTA_CONTROL_REQUEST",
    ]) {
      expect(isCataloguedGateEnv(env), `${env} should be catalogued after the jul-03 fixes`).toBe(
        true,
      )
    }
    // (b) a token that no yaml mentions reads as UNCATALOGUED — proves the check
    //     is not a tautological `true` (mutation: if isCataloguedGateEnv always
    //     returned true this fails).
    expect(isCataloguedGateEnv("QUANTA_NEVER_CATALOGUED_SENTINEL_XYZ")).toBe(false)
  })

  test("catalogued-check is WORD-BOUNDARY, not substring (no prefix-sibling false pass)", () => {
    // QUANTA_SHADOW is uncatalogued even though QUANTA_SHADOW_VERIFY IS catalogued
    // (shadow-verify.yaml) — a naive `.includes("QUANTA_SHADOW")` would falsely
    // pass. This pins the boundary so a prefix env can never be masked by a longer
    // sibling's mention (the exact hole a substring match would leave open).
    expect(isCataloguedGateEnv("QUANTA_SHADOW_VERIFY")).toBe(true)
    expect(isCataloguedGateEnv("QUANTA_SHADOW")).toBe(false)
  })
})
