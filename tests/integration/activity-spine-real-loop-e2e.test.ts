import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { runAgent } from "@/agent"
import {
  createActivityStore,
  fleetToActivity,
  renderActivity,
  seedStoreFromSnapshot,
} from "@/activity"
import { toAgentFleetRow } from "@/apps/cli/repl/slash-surface"
import type { SlashContext } from "@/apps/cli/slash-contract"
import { SURFACE_SLASH_COMMANDS } from "@/apps/cli/slash/registry-surface"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { SubagentObservation } from "@/protocol/subagent"
import { __resetRuntimeConfig } from "@/shared"
import { TaskRegistry } from "@/subagent"
import { defaultTools, ToolRegistry } from "@/tool"
import { cfg, RecordingStream, text, withTimeout } from "./_harness"

/**
 * REAL-LOOP fold hellgate for the Activity Spine (jul-15, verified-untested gap).
 *
 * The reducer is unit-proven and `activity-e2e-wire-hellgate.test.ts` drives the
 * COMPOSITION functions with hand-fed / DIRECT producers (0 `runAgent`). NO test
 * proves that a REAL `runAgent` producing a REAL subagent lifecycle folds into
 * the spine. That is the seam this file closes end-to-end:
 *
 *   fake LLM emits `agent(...)`  →  runAgent forks a REAL child loop
 *     →  parent TaskRegistry gains a lineage record        (the SSOT the fleet reads)
 *       →  `taskRegistry.list().map(toAgentFleetRow)`       (ctx.agents, slash-surface.ts:630)
 *         →  `/activity`: `fleetToActivity(rows)` → spine   (registry-surface.ts:493)
 *           →  `renderActivity(store.snapshot())`           (the live L0 tree)
 *
 * Ground-truth: the spawned child appears as an activity node with the correct
 * (`done`) status because the REAL loop settled the lineage record — NOT because
 * a producer was hand-fed a synthetic row.
 *
 * Non-vacuous:
 *  - CONTROL: the LLM never spawns ⇒ empty registry ⇒ empty spine ("(no active agents)").
 *  - RED-ON-INJECTION: neuter the fleet→spine producer (fold returns []) ⇒ the
 *    REAL child is absent from the materialized tree ⇒ the assertions RED.
 */

const agentCall = (id: string, prompt: string): StreamEvent[] => [
  { type: "tool_use_start", id, name: "agent" },
  { type: "tool_use_end", id, input: { prompt } },
  { type: "message_stop", stop_reason: "tool_use" },
]

const conversationText = (input: StreamInput): string =>
  input.messages
    .flatMap((m) =>
      m.content.map((b) => (b.type === "text" ? b.text : b.type === "tool_result" ? b.content : "")),
    )
    .join(" ")

/** Routes each turn by a substring match; `once` rules fire a single time. */
class RoutingLLM implements LLMPort {
  readonly model = "activity-real-loop-model"
  log: string[] = []
  private rules: { match: string; events: StreamEvent[]; once?: boolean; spent?: boolean }[]
  constructor(rules: { match: string; events: StreamEvent[]; once?: boolean }[]) {
    this.rules = rules.map((r) => ({ ...r }))
  }
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    const txt = conversationText(input)
    const rule = this.rules.find((r) => txt.includes(r.match) && !(r.once && r.spent))
    if (rule === undefined) {
      yield* text("unmatched fallback")
      return
    }
    if (rule.once) rule.spent = true
    this.log.push(rule.match)
    for (const e of rule.events) yield e
  }
}

const activityCmd = () => {
  const cmd = SURFACE_SLASH_COMMANDS.find((c) => c.name === "/activity")
  if (cmd === undefined) throw new Error("/activity command not registered")
  return cmd
}

/** Build a minimal SlashContext exposing ONLY the `/activity` slots the fold
 *  needs: the durable spine (`activityStore`) + the live fleet getter (`agents`)
 *  — wired to the REAL registry via `toAgentFleetRow` exactly as the production
 *  `buildReplSlashCtx` does (slash-surface.ts:630). This is the SAME shape the
 *  real `/activity` command reads; `renderFold` re-drives the command's own fold
 *  (registry-surface.ts:487-493) through an injectable producer for the red test. */
const activityCtx = (registry: TaskRegistry): { ctx: SlashContext; out: string[] } => {
  const out: string[] = []
  const ctx = {
    out: (s: string) => out.push(s),
    err: () => {},
    now: () => 1_000,
    activityStore: createActivityStore(),
    // The EXACT production wire: the live registry projected row-by-row.
    agents: () => registry.list().map(toAgentFleetRow),
  } as unknown as SlashContext
  return { ctx, out }
}

/** Run the REAL fold the way `/activity` does, but through the injectable
 *  `foldFleet` producer so the red variant can neuter it. Returns the rendered
 *  `/activity` lines off the SHARED spine snapshot. */
const renderFold = (ctx: SlashContext, foldFleet: typeof fleetToActivity): string => {
  const store = (ctx as unknown as { activityStore: ReturnType<typeof createActivityStore> })
    .activityStore
  const agents = (ctx as unknown as { agents: () => Parameters<typeof fleetToActivity>[0] }).agents
  const view = seedStoreFromSnapshot(store.snapshot())
  view.emitAll(foldFleet(agents()))
  return renderActivity(view.snapshot(), { now: 1_000 }).join("\n")
}

/** Drive the REAL loop with subagent + a shared activity store. The scripted LLM
 *  spawns a REAL child through the `agent` tool; the returned registry is the SSOT
 *  the spine folds. */
const runRealSpawn = async (opts: {
  spawn: boolean
}): Promise<{ registry: TaskRegistry; events: SubagentObservation[]; llm: RoutingLLM }> => {
  const llm = opts.spawn
    ? new RoutingLLM([
        { match: "PARENT-GO", events: agentCall("a1", "CHILD-INVESTIGATE the flake"), once: true },
        { match: "CHILD-INVESTIGATE", events: text("CHILD-ANSWER done") },
        { match: "CHILD-ANSWER", events: text("PARENT-DONE") },
      ])
    : // CONTROL: the parent finishes on turn 1 WITHOUT ever calling `agent`.
      new RoutingLLM([{ match: "PARENT-GO", events: text("PARENT-DONE no spawn"), once: true }])

  const registry = new TaskRegistry()
  const events: SubagentObservation[] = []

  const runResult = await withTimeout(
    runAgent(
      cfg({
        llm,
        stream: new RecordingStream(),
        registry: new ToolRegistry(defaultTools),
        messages: [{ role: "user", content: [{ type: "text", text: "PARENT-GO" }] }],
        subagent: { maxDepth: 3, taskRegistry: registry },
        onSubagentEvent: (e) => events.push(e),
        maxTurns: 8,
      }),
    ),
    15_000,
    "activity-spine-real-loop-e2e",
  )
  expect(runResult.reason).toBe("completed")
  return { registry, events, llm }
}

describe("Activity Spine — REAL loop-emitted subagent lifecycle folds into the spine", () => {
  beforeEach(() => {
    __resetRuntimeConfig()
  })
  afterEach(() => {
    __resetRuntimeConfig()
  })

  test("real `agent` spawn ⇒ the child is a LIVE activity node (done) in the materialized tree", async () => {
    const { registry, events, llm } = await runRealSpawn({ spawn: true })

    // Provenance: the child actually ran through the REAL loop (not a stub), and
    // the loop emitted the real spawn + completed status.
    expect(llm.log).toContain("CHILD-INVESTIGATE")
    const tasks = registry.list()
    expect(tasks.length).toBe(1)
    expect(tasks[0]?.status).toBe("completed") // the loop SETTLED the lineage record
    expect(events.some((e) => e.type === "subagent_spawn")).toBe(true)
    expect(
      events.some((e) => e.type === "subagent_status" && e.status === "completed"),
    ).toBe(true)

    // FOLD: drive the SAME chain `/activity` uses — registry → toAgentFleetRow →
    // fleetToActivity → spine — off the REAL registry.
    const rows = registry.list().map(toAgentFleetRow)
    const store = createActivityStore()
    store.emitAll(fleetToActivity(rows))
    const snap = store.snapshot()

    // The REAL child folded in as an activity `subagent` node with the mapped
    // (`completed`→`done`) SSOT status.
    const childId = tasks[0]?.id ?? ""
    const node = snap.byId.get(childId)
    expect(node).toBeDefined()
    expect(node?.kind).toBe("subagent")
    expect(node?.label).toContain("CHILD-INVESTIGATE")
    expect(node?.status).toBe("done")
    expect(snap.roots).toContain(childId)

    // And it materializes into the rendered `/activity` tree.
    const text = renderActivity(snap, { now: 1_000 }).join("\n")
    expect(text).toContain("ACTIVITY")
    expect(text).toContain("CHILD-INVESTIGATE")
    expect(text).toContain("✓") // done glyph on the settled child
  })

  test("REAL `/activity` command renders the live spine folded off the loop's registry", async () => {
    const { registry } = await runRealSpawn({ spawn: true })

    // Drive the ACTUAL registered `/activity` command with `ctx.agents` wired to
    // the REAL registry (the production `taskRegistry.list().map(toAgentFleetRow)`
    // getter). This exercises the REAL fold path inside the command body.
    const { ctx, out } = activityCtx(registry)
    const code = await activityCmd().run([], ctx)
    expect(code).toBe(0)

    const rendered = out.join("")
    expect(rendered).toContain("ACTIVITY")
    // The REAL loop's child surfaced through the command's own fleetToActivity fold.
    expect(rendered).toContain("CHILD-INVESTIGATE")
    expect(rendered).toContain("1 agent") // aggregate counted the folded subagent
  })

  test("CONTROL: no spawn ⇒ empty registry ⇒ empty spine (no phantom node)", async () => {
    const { registry, llm } = await runRealSpawn({ spawn: false })

    // The parent finished WITHOUT ever spawning — the registry is empty, so
    // nothing can fold into the spine.
    expect(llm.log).not.toContain("CHILD-INVESTIGATE")
    expect(registry.list().length).toBe(0)

    const store = createActivityStore()
    store.emitAll(fleetToActivity(registry.list().map(toAgentFleetRow)))
    const snap = store.snapshot()
    expect(snap.roots.length).toBe(0)
    expect(snap.byId.size).toBe(0)

    const text = renderActivity(snap, { now: 1_000 }).join("\n")
    expect(text).toContain("(no active agents)")

    // The REAL command agrees: nothing to render.
    const { ctx, out } = activityCtx(registry)
    await activityCmd().run([], ctx)
    expect(out.join("")).toContain("(no active agents)")
    expect(out.join("")).not.toContain("CHILD-INVESTIGATE")
  })

  test("RED-ON-INJECTION: neuter the fleet→spine producer ⇒ the REAL child is ABSENT from the tree", async () => {
    const { registry } = await runRealSpawn({ spawn: true })

    // Sanity: with the REAL producer the child IS present (guards the neuter is
    // load-bearing, not a vacuous pass on an already-empty tree).
    const { ctx: liveCtx } = activityCtx(registry)
    const live = renderFold(liveCtx, fleetToActivity)
    expect(live).toContain("CHILD-INVESTIGATE")

    // Neuter ONLY the fold producer (the seam under test). The registry is STILL
    // populated by the real loop and `ctx.agents()` still returns the real rows —
    // but the producer that folds them into the spine is broken.
    const neuteredFold: typeof fleetToActivity = () => []
    const { ctx: deadCtx } = activityCtx(registry)
    const dead = renderFold(deadCtx, neuteredFold)

    // With the fold neutered the spawned node vanishes from the materialized tree.
    expect(dead).not.toContain("CHILD-INVESTIGATE")
    expect(dead).toContain("(no active agents)")
  })
})
