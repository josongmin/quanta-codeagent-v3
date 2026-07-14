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
 *   PROJECTION (§4.4) — at a leaf (`canExposeSpawnTools === false`) the CREATION
 *   tools (`SPAWN_TOOL_NAMES`) are REMOVED and every management/observe
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
import { projectSpawnTools, SPAWN_TOOL_NAMES } from "@/agent/spawn-projection"
import type { AgentConfig } from "@/agent/types"
import type { LLMPort } from "@/llm"
import type { PermissionContext } from "@/permission"
import { __resetRuntimeConfig } from "@/shared"
import type { StreamPort } from "@/stream"
import { createTeamRegistry } from "@/subagent"
import { defaultTools, GATED_TOOLS, ToolRegistry } from "@/tool"

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
    // Enable branch_search so the meta-pin exercises it as a REAL composed
    // creation vector (D1: branch_search is a spawn vector in SPAWN_TOOL_NAMES).
    branchSearch: {
      defaultN: 2,
      defaultVerifierKinds: [],
      timeoutPerBranchMs: 1000,
      isolation: "tmpdir",
    },
    teamRegistry: createTeamRegistry(),
    delegation: { delegator: stubDelegator() },
    ...(depth !== undefined ? { depth } : {}),
  }) as unknown as AgentConfig

/** The composed, projected `extraTools` names the loop actually sees. */
const composedNames = async (config: AgentConfig): Promise<string[]> =>
  (await buildSessionFeatures(config)).extraTools.map((t) => t.name)

/** The CREATION-authority tools the `fullCfg` fixture actually COMPOSES (trio +
 *  6-tool + workflow + csv + batch + team + delegate + branch_search). Used by the
 *  fixture-liveness pin (enumerated over real composed `extraTools`). */
const EXPECTED_CREATION_TOOLS = [
  "agent",
  "spawn_agent",
  "spawn_batch",
  "spawn_agents_on_csv",
  "run_workflow",
  "delegate",
  "team_create",
  "branch_search", // D1 — speculative candidate fork is a spawn vector (ADR-0084)
] as const

/** CREATION vectors that `fullCfg` does NOT compose (they need a background
 *  `scheduler` / side-agent `registry` port). They are still in SPAWN_TOOL_NAMES
 *  and are covered by the manifest-parity guard + the direct-projection behavior
 *  test below — NOT by the fixture-liveness pin. */
const DAEMON_CREATION_TOOLS = ["subagent_fork", "side_agent_spawn"] as const

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
  test("contains exactly the 10 creation tools (8 fixture-composed + 2 daemon/bg)", () => {
    expect([...SPAWN_TOOL_NAMES].sort()).toEqual(
      [...EXPECTED_CREATION_TOOLS, ...DAEMON_CREATION_TOOLS].sort(),
    )
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

  // (REMOVED) The old "forgot-a-tool guard" here was VACUOUS: it pre-filtered
  // `emitted` to names ALREADY in `SPAWN_TOOL_NAMES ∪ EXPECTED_MANAGEMENT_TOOLS`
  // before asserting they were classified — so a NEW/forgotten spawn tool (in
  // NEITHER set) was filtered out before the check and never caught. That is
  // exactly how `subagent_fork`/`side_agent_spawn` slipped past. Superseded by the
  // NON-CIRCULAR manifest-parity guard below (derives the truth set from an
  // independent SSOT, `GATED_TOOLS.risk`).
})

// ── NON-CIRCULAR completeness : the manifest risk tag is the independent SSOT ──

/** Manifest tools tagged `risk:"spawns-subagent"` that are MANAGEMENT of an
 *  ALREADY-spawned child (wake/observe), NOT a descendant CREATION vector —
 *  verified: `followup_task` wakes a registered child via `turn-wake`/`turn-gate`
 *  with NO `runAgent`/`createSubagentRunner` new edge. These are deliberately NOT
 *  projected away from a leaf (§5.1: a leaf keeps authority over its OWN
 *  sub-state). Adding a name here is an explicit, reviewed classification. */
const MANIFEST_SPAWN_MANAGEMENT = new Set(["followup_task"])

describe("META-PIN (NON-CIRCULAR) — SPAWN_TOOL_NAMES covers every manifest spawn CREATION vector", () => {
  // Unlike the EXPECTED_CREATION_TOOLS pin above (which is a COPY of the SET and so
  // can only ever tautologically agree), this derives the truth set from the
  // manifest `GATED_TOOLS` `risk` classification — an INDEPENDENT SSOT. A spawn
  // tool the projection forgot (in the manifest, absent from SPAWN_TOOL_NAMES,
  // not an explicit management exception) is caught here. This is the guard that
  // the `subagent_fork`/`side_agent_spawn` omission slipped past when the old
  // circular guard could not see it.
  test("every GATED_TOOLS risk:spawns-subagent tool is a projected creation vector OR an explicit management exception", () => {
    const manifestSpawnRisk = GATED_TOOLS.filter((e) => e.risk === "spawns-subagent").map(
      (e) => e.name,
    )
    // Anti-vacuum floor: the manifest genuinely tags a batch of spawn-risk tools.
    expect(manifestSpawnRisk.length).toBeGreaterThanOrEqual(6)
    const unclassified = manifestSpawnRisk.filter(
      (n) => !SPAWN_TOOL_NAMES.has(n) && !MANIFEST_SPAWN_MANAGEMENT.has(n),
    )
    // A manifest spawn-risk tool in NEITHER partition ⇒ a leaf still SEES it (the
    // projection hole this suite exists to forbid).
    expect(unclassified).toEqual([])
  })

  // The daemon/bg creation tools are not composed by `fullCfg`, so prove the
  // projection behavior directly: at a leaf they are STRIPPED, a management tool
  // (`followup_task`, `side_agent_stop`) SURVIVES. Uses `projectSpawnTools` over a
  // synthetic tool list so no scheduler/registry port is needed.
  test("direct projection: a leaf STRIPS subagent_fork + side_agent_spawn, KEEPS management", () => {
    const asTool = (name: string) =>
      ({ name }) as unknown as Parameters<typeof projectSpawnTools>[0][number]
    const tools = [
      asTool("subagent_fork"),
      asTool("side_agent_spawn"),
      asTool("followup_task"), // management — survives
      asTool("side_agent_stop"), // management — survives
      asTool("read"), // unrelated — survives
    ]
    withCap(1)
    try {
      const kept = projectSpawnTools(tools, { depth: 1 }).map((t) => t.name) // depth 1 ≥ default cap 1
      expect(kept).not.toContain("subagent_fork")
      expect(kept).not.toContain("side_agent_spawn")
      expect(kept).toContain("followup_task")
      expect(kept).toContain("side_agent_stop")
      expect(kept).toContain("read")
      // Paired control: at the ROOT (depth 0, cap 1) nothing is stripped.
      const rootKept = projectSpawnTools(tools, { depth: 0 }).map((t) => t.name)
      expect(rootKept).toContain("subagent_fork")
      expect(rootKept).toContain("side_agent_spawn")
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

  test("default cap 1: a depth-1 CHILD loses the creation tools, keeps management + a non-spawn tool", async () => {
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
