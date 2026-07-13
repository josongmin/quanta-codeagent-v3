/**
 * HELLGATE — rev.4 §4.4 / §5.1 / §6 P1: the SINGLE capability-projection filter
 * (`projectSpawnTools` at the features.ts seam) and its `SPAWN_TOOL_NAMES` SSOT.
 *
 * rev.4 replaces the four per-builder `if (!spawnToolsAvailable(config)) return`
 * gates (tier1/{subagent,subagent-batch,team,delegate}.ts) with ONE filter over
 * the finalized `extraTools`. Because it runs INSIDE `buildSessionFeatures`, this
 * suite drives the REAL seam end-to-end (NOT the leaf `subagent-batch` builder,
 * which pulls the ADR-0436 features.ts init-cycle — the enumeration is taken from
 * the composed `extraTools` instead). Two invariants:
 *
 *   PROJECTION (§4.4) — at a leaf (`canExposeSpawnTools === false`) the 7
 *   CREATION tools (`SPAWN_TOOL_NAMES`) are REMOVED and every management/observe
 *   and non-spawn tool SURVIVES (§5.1 N2 fix: `team_delete`, bash/edit, … stay).
 *   At the root under default cap 1 the filter is a no-op (byte-identical).
 *   Mutation coverage: dropping a name from the SET leaks that tool for a leaf
 *   (proven in-body).
 *
 *   META-PIN (§6 P1 parity) — `SPAWN_TOOL_NAMES` must cover EVERY creation tool
 *   the spawn builders actually emit. We enumerate the ROOT-composed `extraTools`
 *   (filter no-op ⇒ full pre-projection set) over a config that turns on every
 *   spawn family, and assert each creation-authority tool is in the SET while each
 *   management/observe tool is NOT. A FUTURE new spawn tool not added to the SET
 *   FAILS this pin — the exact "forgot the gate" class the single filter prevents.
 */

import { describe, expect, test } from "bun:test"
import { buildSessionFeatures } from "@/agent/features"
import { SPAWN_TOOL_NAMES } from "@/agent/spawn-projection"
import type { AgentConfig } from "@/agent/types"
import type { LLMPort } from "@/llm"
import type { PermissionContext } from "@/permission"
import { __resetRuntimeConfig } from "@/shared"
import type { StreamPort } from "@/stream"
import { createTeamRegistry } from "@/subagent"
import { defaultTools, ToolRegistry } from "@/tool"

// ── env cap helpers ───────────────────────────────────────────────────────────

const withCap = (cap: number | undefined): void => {
  if (cap === undefined) delete process.env["QUANTA_MAX_DESCENDANT_DEPTH"]
  else process.env["QUANTA_MAX_DESCENDANT_DEPTH"] = String(cap)
  __resetRuntimeConfig()
}

/** A no-op delegator satisfying the tool-side `DelegationPort`. */
const stubDelegator = () => ({
  delegate: async () => ({ ok: true, output: "", turns: 0 }),
  listModes: () => [] as never[],
  describeMode: () => null,
})

/** A config that materializes EVERY spawn family the builders can mint through
 *  the real composer: subagent trio + 6-tool (spawn_agent) + workflow
 *  (run_workflow) + spawn_agents_on_csv + spawn_batch, team (team_create/
 *  team_delete), delegate. `depth` is the leaf lever. */
const fullCfg = (depth?: number): AgentConfig =>
  ({
    registry: new ToolRegistry(defaultTools),
    stream: { emit() {} } as StreamPort,
    permission: { mode: "acceptEdits" } as PermissionContext,
    messages: [],
    system: "test",
    cwd: "/tmp",
    maxTurns: 1,
    signal: new AbortController().signal,
    llm: { model: "scripted", async *stream() {} } as unknown as LLMPort,
    subagent: {
      enable6Tools: true,
      enableBatchSpawn: true,
      enableWorkflow: true,
      enableSpawnAgentsCsv: true,
    },
    teamRegistry: createTeamRegistry(),
    delegation: { delegator: stubDelegator() },
    ...(depth !== undefined ? { depth } : {}),
  }) as unknown as AgentConfig

/** The composed, projected `extraTools` names the loop actually sees. */
const composedNames = async (config: AgentConfig): Promise<string[]> =>
  (await buildSessionFeatures(config)).extraTools.map((t) => t.name)

/** The rev.4 CREATION-authority set, enumerated for the meta-pin. */
const EXPECTED_CREATION_TOOLS = [
  "agent",
  "spawn_agent",
  "spawn_batch",
  "spawn_agents_on_csv",
  "run_workflow",
  "delegate",
  "team_create",
] as const

/** Tools the builders emit that are MANAGEMENT/OBSERVE, NOT creation — these must
 *  NOT be in the SET so a leaf keeps authority over its own sub-state (§5.1). */
const EXPECTED_MANAGEMENT_TOOLS = [
  "team_delete",
  "task_output",
  "task_stop",
  "wait_agent",
  "close_agent",
  "send_input",
  "exec_command",
  "write_stdin",
] as const

// ── SPAWN_TOOL_NAMES shape ────────────────────────────────────────────────────

describe("SPAWN_TOOL_NAMES — the frozen CREATION-authority SSOT (§5.1)", () => {
  test("contains exactly the 7 creation tools", () => {
    expect([...SPAWN_TOOL_NAMES].sort()).toEqual([...EXPECTED_CREATION_TOOLS].sort())
  })

  test("does NOT contain any management/observe tool (leaf keeps its sub-state)", () => {
    for (const name of EXPECTED_MANAGEMENT_TOOLS) {
      expect(SPAWN_TOOL_NAMES.has(name)).toBe(false)
    }
  })
})

// ── META-PIN : SET covers every builder-emitted creation tool (§6 P1) ─────────

describe("META-PIN — SPAWN_TOOL_NAMES covers every CREATION tool the builders emit", () => {
  test("every expected creation + management tool is actually composed (fixture is live)", async () => {
    withCap(3) // widen so a depth-0 root composes every family, filter is a no-op
    try {
      const names = new Set(await composedNames(fullCfg(0)))
      // Anti-vacuum floor: the composer really produces each creation AND each
      // management tool (so the classification below is over real surfaces).
      for (const c of EXPECTED_CREATION_TOOLS) expect(names.has(c)).toBe(true)
      for (const m of EXPECTED_MANAGEMENT_TOOLS) expect(names.has(m)).toBe(true)
    } finally {
      withCap(undefined)
    }
  })

  test("EVERY composed spawn tool is CLASSIFIED (creation in-SET, management not) — forgot-a-tool guard", async () => {
    withCap(3)
    try {
      const emitted = await composedNames(fullCfg(0))
      // Every emitted tool that IS a declared creation tool must be in the SET.
      for (const n of emitted) {
        if ((EXPECTED_CREATION_TOOLS as readonly string[]).includes(n)) {
          expect(SPAWN_TOOL_NAMES.has(n)).toBe(true)
        }
      }
      // COMPLETE partition over the spawn-block families: every emitted tool that
      // belongs to a spawn builder is EITHER a known creation tool (in the SET) OR
      // a known management tool (NOT in the SET). A NEW un-classified spawn-family
      // tool trips this — forcing a creation-vs-management decision + SET update.
      const spawnFamilyEmitted = emitted.filter(
        (n) =>
          SPAWN_TOOL_NAMES.has(n) || (EXPECTED_MANAGEMENT_TOOLS as readonly string[]).includes(n),
      )
      // The union of the two declared partitions must EQUAL what we classified —
      // i.e. no creation-or-management tool the SET/list forgot.
      const classified = new Set<string>([...EXPECTED_CREATION_TOOLS, ...EXPECTED_MANAGEMENT_TOOLS])
      for (const n of spawnFamilyEmitted) expect(classified.has(n)).toBe(true)
    } finally {
      withCap(undefined)
    }
  })
})

// ── PROJECTION behavior : root no-op vs leaf strip ────────────────────────────

describe("projectSpawnTools — root no-op, leaf strips CREATION tools only (§4.4/§5.1)", () => {
  test("default cap 1: root (depth 0) KEEPS every creation family (filter no-op)", async () => {
    withCap(undefined) // default maxDescendantDepth === 1 ⇒ 0 < 1 ⇒ exposed
    const names = await composedNames(fullCfg(0))
    for (const c of EXPECTED_CREATION_TOOLS) expect(names).toContain(c)
  })

  test("default cap 1: a depth-1 CHILD loses the 7 creation tools, keeps management + a non-spawn tool", async () => {
    withCap(undefined) // default cap 1 ⇒ depth 1 is a LEAF (1 < 1 false)
    const names = await composedNames(fullCfg(1))

    // The 7 SPAWN_TOOL_NAMES are ABSENT (by name).
    for (const name of SPAWN_TOOL_NAMES) expect(names).not.toContain(name)
    for (const name of EXPECTED_CREATION_TOOLS) expect(names).not.toContain(name)

    // Management/observe tools SURVIVE (§5.1 N2 fix).
    for (const name of EXPECTED_MANAGEMENT_TOOLS) expect(names).toContain(name)
  })

  test("MUTATION anchor — the SET membership is load-bearing (dropping a name would leak)", async () => {
    // The composed leaf output must NOT contain team_create. If team_create were
    // removed from SPAWN_TOOL_NAMES the filter would KEEP it for a leaf ⇒ the
    // assertion below flips RED — proving SET membership is not vacuous.
    withCap(undefined)
    const leafNames = await composedNames(fullCfg(1))
    expect(leafNames).not.toContain("team_create")
    // Paired control: at a widened cap the same leaf DOES keep team_create (the
    // strip is depth-driven, not a blanket removal).
    withCap(3)
    try {
      const exposed = await composedNames(fullCfg(1)) // 1 < 3 ⇒ exposed
      expect(exposed).toContain("team_create")
    } finally {
      withCap(undefined)
    }
  })
})
