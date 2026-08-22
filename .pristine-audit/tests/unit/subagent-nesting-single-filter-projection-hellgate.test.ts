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
  if (cap === undefined) delete process.env.QUANTA_MAX_DESCENDANT_DEPTH
  else process.env.QUANTA_MAX_DESCENDANT_DEPTH = String(cap)
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

  // followup_task is a spawn-RISK manifest tool (it can wake a child) but is
  // MANAGEMENT of an already-registered child, NOT a descendant-CREATION vector.
  // Pin its classification EXPLICITLY: it must be the management exception and must
  // NOT be projected away from a leaf. If someone "fixed" the guard by adding it to
  // SPAWN_TOOL_NAMES, a leaf would lose the ability to wake its own child (§5.1).
  test("followup_task is classified MANAGEMENT (in the exception, NOT in SPAWN_TOOL_NAMES)", () => {
    const manifestSpawnRisk = new Set(
      GATED_TOOLS.filter((e) => e.risk === "spawns-subagent").map((e) => e.name),
    )
    expect(manifestSpawnRisk.has("followup_task")).toBe(true) // it IS spawn-risk tagged
    expect(MANIFEST_SPAWN_MANAGEMENT.has("followup_task")).toBe(true) // …but management
    expect(SPAWN_TOOL_NAMES.has("followup_task")).toBe(false) // …NOT a creation vector
  })

  // ROBUSTNESS — prove the guard is not merely tautological: if a NEW spawns-subagent
  // manifest tool existed that was in NEITHER SPAWN_TOOL_NAMES NOR the management
  // allowlist, the SAME partition logic FLAGS it. We simulate a forgotten tool by
  // appending a synthetic name to a LOCAL copy of the manifest spawn-risk slice and
  // running the identical classifier — it must be reported unclassified (RED for the
  // real guard were it live). This is the exact `subagent_fork`/`side_agent_spawn`
  // omission that the earlier CIRCULAR guard could not see.
  test("guard CATCHES a forgotten spawn tool (simulated new manifest vector not in either set)", () => {
    const realSpawnRisk = GATED_TOOLS.filter((e) => e.risk === "spawns-subagent").map((e) => e.name)
    const FORGOTTEN = "__new_spawn_vector_not_yet_registered__"
    // Sanity: the synthetic name is genuinely absent from both SSOTs (else the
    // simulation would be vacuous).
    expect(SPAWN_TOOL_NAMES.has(FORGOTTEN)).toBe(false)
    expect(MANIFEST_SPAWN_MANAGEMENT.has(FORGOTTEN)).toBe(false)

    const simulatedManifest = [...realSpawnRisk, FORGOTTEN]
    const unclassified = simulatedManifest.filter(
      (n) => !SPAWN_TOOL_NAMES.has(n) && !MANIFEST_SPAWN_MANAGEMENT.has(n),
    )
    // The forgotten vector — and ONLY it — is flagged; the real tools stay clean.
    expect(unclassified).toEqual([FORGOTTEN])
  })

  // Complementary robustness: if the forgotten vector WERE added to SPAWN_TOOL_NAMES
  // (the correct fix), the same classifier goes clean — proving the guard's verdict
  // tracks membership, not a constant `[]`.
  test("guard CLEARS once the forgotten vector is registered in SPAWN_TOOL_NAMES", () => {
    const realSpawnRisk = GATED_TOOLS.filter((e) => e.risk === "spawns-subagent").map((e) => e.name)
    const FORGOTTEN = "__new_spawn_vector_now_registered__"
    const patchedSet = new Set([...SPAWN_TOOL_NAMES, FORGOTTEN])
    const unclassified = [...realSpawnRisk, FORGOTTEN].filter(
      (n) => !patchedSet.has(n) && !MANIFEST_SPAWN_MANAGEMENT.has(n),
    )
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

  // ── BOUNDARY truth table : expose ⇔ parentDepth < effectiveCap ──────────────
  // Direct over `projectSpawnTools` (no composer needed) so we can sweep cap ∈
  // {0,1,2,3} × parentDepth ∈ {0,1,2,3} and pin the expose/strip decision at EVERY
  // at-cap / over-cap / under-cap boundary — not the single (cap 1, depth 0/1) point
  // the composed tests cover. `canExposeSpawnTools` is `parentDepth < cap`; a flipped
  // `<`/`<=` or an off-by-one goes RED on the at-cap rows (depth === cap).
  test("boundary truth table: a CREATION tool is exposed ⇔ depth < cap (cap 0..3 × depth 0..3)", () => {
    const asTool = (name: string) =>
      ({ name }) as unknown as Parameters<typeof projectSpawnTools>[0][number]
    const tools = [asTool("agent"), asTool("read")]
    for (const cap of [0, 1, 2, 3]) {
      for (const depth of [0, 1, 2, 3]) {
        withCap(cap)
        try {
          const kept = projectSpawnTools(tools, { depth }).map((t) => t.name)
          const exposed = depth < cap
          // `agent` (creation) tracks the boundary; `read` (non-spawn) ALWAYS survives.
          expect({
            cap,
            depth,
            agent: kept.includes("agent"),
            read: kept.includes("read"),
          }).toEqual({ cap, depth, agent: exposed, read: true })
        } finally {
          withCap(undefined)
        }
      }
    }
  })

  test("cap=0 kill switch STRIPS even the root (depth 0) — creation gone, non-spawn kept", () => {
    const asTool = (name: string) =>
      ({ name }) as unknown as Parameters<typeof projectSpawnTools>[0][number]
    const tools = [asTool("agent"), asTool("team_create"), asTool("read")]
    withCap(0) // total kill switch: 0 < 0 is false ⇒ even root loses creation
    try {
      const kept = projectSpawnTools(tools, { depth: 0 }).map((t) => t.name)
      expect(kept).not.toContain("agent")
      expect(kept).not.toContain("team_create")
      expect(kept).toContain("read")
    } finally {
      withCap(undefined)
    }
  })

  // ── MIN-CAP : per-config `subagent.maxDepth` can only TIGHTEN the policy ──────
  // effectiveCap(requested) = min(policy, requested). A requested cap BELOW policy
  // tightens (strips earlier); a requested cap ABOVE policy is ignored (never raises).
  // Guards the min() resolution — a mutation to `max()` or dropping the requested arg
  // flips one of the two rows.
  test("subagent.maxDepth tightens below policy but cannot raise above it", () => {
    const asTool = (name: string) =>
      ({ name }) as unknown as Parameters<typeof projectSpawnTools>[0][number]
    const tools = [asTool("agent")]
    withCap(3) // operator policy = 3
    try {
      const keeps = (depth: number, requested?: number) =>
        projectSpawnTools(tools, {
          depth,
          ...(requested !== undefined ? { subagent: { maxDepth: requested } } : {}),
        } as never).some((t) => t.name === "agent")

      // TIGHTEN: requested 1 < policy 3 ⇒ effective cap 1 ⇒ depth 1 is a leaf.
      expect(keeps(1, 1)).toBe(false)
      expect(keeps(0, 1)).toBe(true) // root still exposed under the tightened cap
      // CANNOT RAISE: requested 5 > policy 3 ⇒ effective cap stays 3 ⇒ depth 3 leaf.
      expect(keeps(3, 5)).toBe(false)
      expect(keeps(2, 5)).toBe(true) // 2 < 3 ⇒ still exposed (proves cap is 3, not 5)
      // Paired control: no requested ⇒ cap = policy 3.
      expect(keeps(2)).toBe(true)
      expect(keeps(3)).toBe(false)
    } finally {
      withCap(undefined)
    }
  })

  // ── MALFORMED depth in the OPTIMIZATION layer ────────────────────────────────
  // The projection is an OPTIMIZATION (§4); the AUTHORITATIVE fail-closed guard is
  // `childDepthOf` in the runner/`admitsDaemonChild` (pinned in the wiring hellgate:
  // NaN/-1/2.5 all DENY there). Here we pin the projection's OWN behavior so a
  // regression is observable: NaN strips (NaN < cap is false ⇒ fail-closed). undefined
  // is a genuine root (spec: absent=root) ⇒ exposed. NOTE (finding): negative / non-
  // integer depths (-1, 2.5) currently fail-OPEN in THIS layer (`-1 < 1` ⇒ exposed) —
  // benign only because the runner authority (fail-closed) backstops an actual spawn.
  test("malformed depth in projection: NaN fail-closed (strips); undefined = root (exposes)", () => {
    const asTool = (name: string) =>
      ({ name }) as unknown as Parameters<typeof projectSpawnTools>[0][number]
    const tools = [asTool("agent")]
    withCap(1)
    try {
      const keeps = (depth: unknown) =>
        projectSpawnTools(tools, { depth } as never).some((t) => t.name === "agent")
      // NaN ⇒ `NaN < 1` is false ⇒ stripped (fail-closed, NOT treated as root).
      expect(keeps(Number.NaN)).toBe(false)
      // undefined ⇒ coerced to 0 (genuine root per spec) ⇒ exposed.
      expect(keeps(undefined)).toBe(true)
      // Paired control confirming the sweep axis is live at this cap.
      expect(keeps(0)).toBe(true)
      expect(keeps(1)).toBe(false)
    } finally {
      withCap(undefined)
    }
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
