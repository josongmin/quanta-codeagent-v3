/**
 * RFC-01 A5 — product closure / attention-navigation e2e (`codex/aug22-a5`).
 *
 * This is the north-star RECEIPT (RFC-01 §Product closure, ~line 48/236): a child
 * emits a REAL `request_user_input` question → the operator command selects THAT
 * exact opaque request → the response reaches the waiting request → the child
 * RESUMES (emits a post-answer marker) → the pending marker CLEARS. Until this
 * rail is RED-then-GREEN the feature is an attention *list*, not attention
 * *navigation*.
 *
 * FIDELITY: every wire on the attention rail is the PRODUCTION module, driven end
 * to end with NO stub of the wire:
 *   - the REAL dispatch seam `buildToolContext` (`@/agent/dispatch/tool-context`)
 *     resolves `ctx.requestUserInput` from `AgentConfig.questionBroker` +
 *     `spawnedAsTaskId` exactly as a spawned child does;
 *   - the REAL `request_user_input` tool (`@/tool`) the child would call;
 *   - the REAL A1 broker (`@/session/user-question`);
 *   - the REAL A2 assembly join (`buildSessionAuthorities` → `AttentionReader`)
 *     AND the REAL CLI lifecycle composition (`buildLifecycleBundle`);
 *   - the REAL CLI `/attention` command (`@/apps/cli/slash/attention-cmd`).
 * The only thing NOT crossed is an OS process boundary — this worktree cannot
 * spawn the compiled CLI binary — so the "child" is the real tool call awaited on
 * its own async task rather than in a forked PID. That boundary is orthogonal to
 * the attention rail (the rail is the tool→broker→reader→command→answer graph),
 * so the receipt is a genuine product RED/GREEN, not a stub.
 *
 * SLICE FENCE (ADR-0024): this file is on the `biome.json` allowlist for
 * `src/apps/cli/**` imports — the same "explicitly-allowed CLI test" mechanism as
 * `tests/integration/subagent-panel-e2e.test.ts` / `hitl-approval-e2e.test.ts`.
 * It is legitimate here because the CLI surface IS the subject under test: the
 * receipt is worthless unless it drives the REAL `/attention` command, the REAL
 * CLI lifecycle composition and the REAL fleet renderer. There is no library-side
 * facade to route through — `src/apps/cli/internal.ts` sits INSIDE the same fenced
 * group, so re-exporting through it would launder the coupling, not remove it.
 * NO production code is touched by this test.
 *

 * receipt: removing the dispatch broker branch (`resolveRequestUserInput`) makes
 * the child's question never reach the broker → `/attention` shows no row → the
 * answer route cannot reach the child → section (1) fails. Replacing the explicit
 * `spawnedAsTaskId` correlation with parent-chain inference makes the child row
 * disappear → section (2, task binding) fails (Architectural completion gate:
 * RED-on-injection).
 */

import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { buildToolContext } from "@/agent/dispatch/tool-context"
import { renderAgentFleet } from "@/apps/cli/agents-fleet-panel"
import type { CliFeatureConfig } from "@/apps/cli/repl/cli-feature-config"
import { buildLifecycleBundle } from "@/apps/cli/repl/factories/lifecycle"
import { toAgentFleetRow } from "@/apps/cli/repl/slash-surface"
import { attentionCmd, buildAttentionSlashState } from "@/apps/cli/slash/attention-cmd"
import { buildSurfaceSlashCommands } from "@/apps/cli/slash/registry-surface"
import type { SlashCommand, SlashContext } from "@/apps/cli/slash-contract"
import { buildSessionAuthorities } from "@/runner/assemble/session-authorities"
import { createUserQuestionBroker, type UserQuestionBroker } from "@/session/user-question"
import { TaskRegistry } from "@/subagent"
import {
  requestUserInputTool,
  type Tool,
  type ToolContext,
  type ToolEvent,
  ToolRegistry,
  type UserInputOutcome,
  type UserInputRequester,
} from "@/tool"

// ── shared real-rail helpers ────────────────────────────────────────────────

const baseCfg = (over: Partial<AgentConfig>): AgentConfig =>
  ({
    registry: new ToolRegistry([]),
    stream: {} as AgentConfig["stream"],
    permission: { mode: "acceptEdits" },
    messages: [],
    system: "t",
    cwd: "/tmp",
    maxTurns: 5,
    signal: new AbortController().signal,
    llm: {} as AgentConfig["llm"],
    ...over,
  }) as AgentConfig

/** The REAL dispatch-seam ToolContext a spawned child receives. */
const ctxFor = (config: AgentConfig): ToolContext =>
  buildToolContext({ config, workingState: undefined, collabMode: "default", toolCallId: "call-1" })

/** Drive the REAL request_user_input tool with `ctx`; resolve when the tool
 *  settles (the child "resumes"). The tool publishes to the broker synchronously
 *  before it awaits. */
const askViaTool = (ctx: ToolContext, prompt: string): Promise<ToolEvent> => {
  const tool: Tool = requestUserInputTool() as Tool
  const gen = tool.execute({ prompt }, ctx)
  return (async () => {
    let last: ToolEvent | undefined
    for await (const e of gen) last = e
    if (last === undefined) throw new Error("tool yielded nothing")
    return last
  })()
}

/** Pump microtasks until the broker holds >= `n` pending records. */
const waitPending = async (broker: UserQuestionBroker, n: number): Promise<void> => {
  for (let i = 0; i < 200 && broker.listPending().length < n; i++) await Promise.resolve()
}

const withEnv = <T>(key: string, val: string | undefined, fn: () => T): T => {
  const prev = process.env[key]
  if (val === undefined) delete process.env[key]
  else process.env[key] = val
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env[key]
    else process.env[key] = prev
  }
}

/** Build the real authority graph (gate ON), deterministic clock/id. */
const buildRig = () => {
  const tasks = new TaskRegistry()
  let idN = 0
  const authorities = buildSessionAuthorities({
    tasks,
    env: { QUANTA_ATTENTION_NAV: "1" },
    questionDeps: { now: () => 1_000 + idN, mintId: () => `q_fixed_${idN++}` },
  })
  const broker = authorities.questions
  const attention = authorities.attention
  if (broker === undefined || attention === undefined) throw new Error("gate ON must construct")
  const state = buildAttentionSlashState(attention, broker)
  return { tasks, broker, attention, state }
}

const registerChild = (tasks: TaskRegistry, id: string, description: string): void => {
  tasks.register({ id, description, depth: 1 })
}

const capture = (
  state: ReturnType<typeof buildRig>["state"],
  tasks: TaskRegistry,
): { box: { out: string; err: string }; ctx: SlashContext } => {
  const box = { out: "", err: "" }
  const ctx: Partial<SlashContext> & Pick<SlashContext, "out" | "err"> = {
    out: (s) => {
      box.out += s
    },
    err: (s) => {
      box.err += s
    },
    now: () => 5_000,
    attention: state,
    agents: () => tasks.list().map(toAgentFleetRow),
  }
  return { box, ctx: ctx as SlashContext }
}

// ── (1) PRODUCT CLOSURE — the north-star receipt ────────────────────────────

describe("RFC-01 A5 — product closure receipt (real rail)", () => {
  test("child asks → row appears → answer by exact id → child resumes (post-answer marker) → row clears", async () => {
    const { tasks, broker, state } = buildRig()
    registerChild(tasks, "child-A", "db-migrator")
    registerChild(tasks, "child-B", "log-cleaner") // clean sibling: never asks

    // The REAL spawned-child seam: its config carries the broker + its OWN
    // spawnedAsTaskId, so ctx.requestUserInput routes through the broker bound to
    // task child-A. This is the exact production wire (dispatch tool-context).
    const childCtx = ctxFor(baseCfg({ questionBroker: broker, spawnedAsTaskId: "child-A" }))

    // The child runs on its own task and BLOCKS in request_user_input. A
    // post-answer marker fires only if it actually resumes.
    const markers: string[] = []
    const childRun = (async () => {
      const ev = await askViaTool(childCtx, "Which database should I target?")
      if (ev.type === "result" && ev.result.ok) markers.push(`resumed:${ev.result.output}`)
    })()

    await waitPending(broker, 1)

    // Pending row appears — before the answer, the child has NOT resumed.
    const rid = state.list()[0]?.requestId
    expect(state.list()).toHaveLength(1)
    expect(rid).toBe("q_fixed_0")
    expect(markers).toEqual([]) // still blocked

    // /attention list surfaces the exact opaque requestId + the awaiting task.
    {
      const { box, ctx } = capture(state, tasks)
      expect(await attentionCmd.run(["list"], ctx)).toBe(0)
      expect(box.out).toContain("child-A")
      expect(box.out).toContain("q_fixed_0")
    }

    // /attention next → REAL select+drill (the awaiting agent's inspect view).
    {
      const { box, ctx } = capture(state, tasks)
      expect(await attentionCmd.run(["next"], ctx)).toBe(0)
      expect(box.out).toContain("next needing attention")
      expect(box.out).toContain("db-migrator") // drilled the fleet detail, not just the id
    }

    // /attention answer <exact id> → the response reaches THAT waiting request.
    {
      const { box, ctx } = capture(state, tasks)
      expect(await attentionCmd.run(["answer", rid as string, "use", "postgres"], ctx)).toBe(0)
      // Unified ✅ success receipt (CLI-render polish): "✅ Answered <id> — …".
      expect(box.out).toContain("Answered")
      expect(box.out).toContain(rid as string) // still echoes the FULL routing id
    }

    // The child RESUMES with the exact answer text (the post-answer marker).
    await childRun
    expect(markers).toEqual(["resumed:use postgres"])

    // The pending marker CLEARS from the live projection.
    expect(state.list()).toHaveLength(0)
  })
})

// ── (2) ANTI-VACUUM — every arm exercised on the real rail ──────────────────

describe("RFC-01 A5 — anti-vacuum (root · child · parked · cancel · stale/double)", () => {
  test("root question is NEVER a fleet row; a task question IS (exact-id binding)", async () => {
    const { tasks, broker, state } = buildRig()
    registerChild(tasks, "child-A", "worker")

    // 1 ROOT question (no spawnedAsTaskId) — session-level, never a fleet row.
    const rootCtx = ctxFor(baseCfg({ questionBroker: broker /* root */ }))
    const rootRun = askViaTool(rootCtx, "root-level question")
    // 1 CHILD question (explicit spawnedAsTaskId) — a fleet row.
    const childCtx = ctxFor(baseCfg({ questionBroker: broker, spawnedAsTaskId: "child-A" }))
    const childRun = askViaTool(childCtx, "child question")
    await waitPending(broker, 2)

    // Broker holds BOTH; the reader/list surfaces ONLY the task-owned one.
    expect(broker.listPending()).toHaveLength(2)
    const rows = state.list()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.taskId).toBe("child-A")

    // RED-on-injection ANCHOR: the child row is bound to the EXACT task id, never
    // "the newest task". (task-correlation.ts inference injection makes this fail.)
    const rootPending = broker.listPending().find((p) => p.owner.kind === "root")
    expect(rootPending).toBeDefined()

    broker.cancelAll("teardown")
    await rootRun
    await childRun
  })

  test("1 ORDINARY parked child (never asks) produces NO attention row", async () => {
    const { tasks, broker, state } = buildRig()
    registerChild(tasks, "child-A", "asker")
    registerChild(tasks, "child-P", "parked-clean") // registered, running, never asks

    const askCtx = ctxFor(baseCfg({ questionBroker: broker, spawnedAsTaskId: "child-A" }))
    const askRun = askViaTool(askCtx, "only-A-asks")
    await waitPending(broker, 1)

    // Only the asking child appears; the ordinary parked/running child does not.
    expect(state.list().map((r) => r.taskId)).toEqual(["child-A"])

    broker.cancelAll("teardown")
    await askRun
  })

  test("1 CANCELLATION clears the row and the child unblocks (not answered)", async () => {
    const { tasks, broker, state } = buildRig()
    registerChild(tasks, "child-A", "worker")
    const ac = new AbortController()
    const childCtx = ctxFor(
      baseCfg({ questionBroker: broker, spawnedAsTaskId: "child-A", signal: ac.signal }),
    )
    const ev = askViaTool(childCtx, "blocking?")
    await waitPending(broker, 1)
    expect(state.list()).toHaveLength(1)

    // Abort cancels the pending in finally — the child unblocks with a NON-ok
    // (cancelled) result, and the row clears.
    ac.abort()
    const settled = await ev
    expect(settled.type).toBe("result")
    if (settled.type === "result") expect(settled.result.ok).toBe(false)
    expect(state.list()).toHaveLength(0)
  })

  test("1 STALE + 1 DOUBLE answer are CAS-rejected; the child is untouched", async () => {
    const { tasks, broker, state } = buildRig()
    registerChild(tasks, "child-A", "worker")
    const childCtx = ctxFor(baseCfg({ questionBroker: broker, spawnedAsTaskId: "child-A" }))
    const markers: string[] = []
    const childRun = (async () => {
      const ev = await askViaTool(childCtx, "q?")
      if (ev.type === "result") markers.push(ev.result.ok ? `ok:${ev.result.output}` : "cancelled")
    })()
    await waitPending(broker, 1)
    const rid = broker.listPending()[0]?.requestId as string

    // STALE: answering against an OUTDATED expected revision is rejected (CAS).
    const stale = broker.answer(rid, { text: "stale" }, broker.revision() - 1)
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.reason).toBe("stale")
    expect(state.list()).toHaveLength(1) // still pending; child untouched
    expect(markers).toEqual([])

    // Real answer (current revision) settles exactly once.
    const ok = broker.answer(rid, { text: "real" }, broker.revision())
    expect(ok.ok).toBe(true)
    await childRun
    expect(markers).toEqual(["ok:real"])

    // DOUBLE: a second answer to the now-settled id is rejected as unknown — it
    // can NEVER resume another child.
    const dbl = broker.answer(rid, { text: "again" }, broker.revision())
    expect(dbl.ok).toBe(false)
    if (!dbl.ok) expect(dbl.reason).toBe("unknown")
    expect(state.list()).toHaveLength(0)

    // The CLI answer verb also rejects a foreign id (never delivered).
    const { box, ctx } = capture(state, tasks)
    expect(await attentionCmd.run(["answer", "q_not_real", "hi"], ctx)).toBe(1)
    expect(box.err).toContain("no pending question")
  })

  // M6 — the CLI `/attention next` cursor is routed through A1's pure
  // `nextNeedingAttention` (the ONE ordering authority) via the live
  // `AttentionReader.next`, so the resolver's LINEAGE GATE (jul-15 sibling-leak
  // class) is actually EXERCISED on the real CLI wire — not the prior un-gated
  // re-implementation that cycled the flat session-wide list.
  test("lineage gate: cycling past an own agent NEVER jumps to a foreign-lineage sibling", async () => {
    const { tasks, broker, state } = buildRig()
    // Two DIRECT children ⇒ each is its OWN lineage root (parentTaskId absent).
    registerChild(tasks, "child-A", "own-lineage")
    registerChild(tasks, "child-X", "foreign-lineage")

    // child-A asks FIRST (older); the FOREIGN child-X asks SECOND (newer). In the
    // flat session-wide order child-X is therefore the row AFTER child-A.
    const aCtx = ctxFor(baseCfg({ questionBroker: broker, spawnedAsTaskId: "child-A" }))
    const xCtx = ctxFor(baseCfg({ questionBroker: broker, spawnedAsTaskId: "child-X" }))
    const aRun = askViaTool(aCtx, "own?")
    await waitPending(broker, 1)
    const xRun = askViaTool(xCtx, "foreign?")
    await waitPending(broker, 2)

    // List (full inventory) shows BOTH, oldest-first — unchanged.
    const rows = state.list()
    expect(rows.map((r) => r.taskId)).toEqual(["child-A", "child-X"])
    const aReq = rows[0]?.requestId
    expect(aReq).toBeDefined()

    // Cursor PAST child-A stays inside child-A's lineage: child-X is foreign, so
    // it is gated out ⇒ "all caught up". RED-on-injection: reverting `next` to the
    // un-gated flat re-impl returns child-X here (the sibling leak).
    expect(state.next(aReq)).toBeUndefined()

    // No-cursor still surfaces the globally-oldest own agent (not over-gated).
    expect(state.next()?.taskId).toBe("child-A")

    broker.cancelAll("teardown")
    await aRun
    await xRun
  })
})

// ── (3) CROSS-CASE — subagent panel ON + attention OFF: zero delta ──────────

describe("RFC-01 A5 — cross-case byte-identity (panel ON + attention OFF)", () => {
  test("no attention COMMAND byte: /attention is not registered when gate unset", () => {
    const names = (): string[] =>
      buildSurfaceSlashCommands((): readonly SlashCommand[] => []).map((c) => c.name)
    // Panel ON, attention OFF.
    withEnv("QUANTA_WEB_SUBAGENTS", "1", () => {
      withEnv("QUANTA_ATTENTION_NAV", undefined, () => {
        expect(names()).not.toContain("/attention")
      })
    })
    // Sanity: the gate is the ONLY thing that adds it (red-on-injection anchor).
    withEnv("QUANTA_ATTENTION_NAV", "1", () => {
      expect(names()).toContain("/attention")
    })
  })

  test("no attention PROJECTION byte: producer routes the legacy port, broker untouched, fleet render identical", async () => {
    // Panel ON is modeled by onSubagentEvent + spawnedAsTaskId present; attention
    // OFF is modeled by NO questionBroker on the config.
    const tasks = new TaskRegistry()
    registerChild(tasks, "child-A", "worker")
    const idleBroker = createUserQuestionBroker() // exists but is NOT wired

    const baselineFleet = renderAgentFleet(tasks.list().map(toAgentFleetRow), {
      format: "table",
      now: 5_000,
    })

    const seen: string[] = []
    const legacyPort: UserInputRequester = async (req) => {
      seen.push(req.prompt)
      return { decision: "answer", text: "legacy" } satisfies UserInputOutcome
    }
    const ctx = ctxFor(
      baseCfg({
        spawnedAsTaskId: "child-A",
        onSubagentEvent: () => {}, // panel emitter present
        userInputPort: legacyPort,
        // questionBroker intentionally ABSENT (attention OFF)
      }),
    )
    // The dispatch seam resolves to the legacy port VERBATIM (byte-identical).
    expect(ctx.requestUserInput).toBe(legacyPort)
    const ev = await askViaTool(ctx, "cross-case?")
    expect(seen).toEqual(["cross-case?"])
    expect(ev.type).toBe("result")
    if (ev.type === "result") expect(ev.result.output).toBe("legacy")

    // No broker interaction; the fleet render is byte-identical to baseline (no
    // attention field leaked into any registry projection).
    expect(idleBroker.listPending()).toHaveLength(0)
    expect(
      renderAgentFleet(tasks.list().map(toAgentFleetRow), { format: "table", now: 5_000 }),
    ).toBe(baselineFleet)
  })
})

// ── (4) REGISTRY IDENTITY — one instance across the real CLI composition ────

describe("RFC-01 A5 — registry identity (one instance shared)", () => {
  const featureCfg = (): CliFeatureConfig =>
    ({
      pills: { enabled: true, hideTasks: false, hideFollowUp: false, hideMcp: false },
      subagentForPills: true,
    }) as CliFeatureConfig

  test("CLI lifecycle: /attention reader + broker + registry are ONE joined graph (red-on-injection)", async () => {
    const bundle = buildLifecycleBundle(featureCfg(), { QUANTA_ATTENTION_NAV: "1" })
    expect(bundle.taskRegistry).toBeDefined()
    expect(bundle.questionBroker).toBeDefined()
    expect(bundle.attentionReader).toBeDefined()
    const reg = bundle.taskRegistry as TaskRegistry
    const broker = bundle.questionBroker as UserQuestionBroker
    const reader = bundle.attentionReader

    // Register a child in the SAME registry the bundle exposes and publish a
    // question bound to it via the producer. The reader (assembled over the
    // bundle's registry+broker) surfaces it ⇒ they are the SAME instances.
    registerChild(reg, "child-A", "worker")
    const childCtx = ctxFor(baseCfg({ questionBroker: broker, spawnedAsTaskId: "child-A" }))
    const run = askViaTool(childCtx, "shared?")
    await waitPending(broker, 1)
    expect(reader?.snapshot().map((a) => a.id)).toEqual(["child-A"])

    // Red-on-injection: a task registered in a DIFFERENT registry never surfaces
    // in the bundle's reader (proves the reader is bound to THIS registry, not
    // just "some" registry).
    const foreign = new TaskRegistry()
    registerChild(foreign, "child-X", "foreign")
    const foreignBroker = createUserQuestionBroker()
    const foreignCtx = ctxFor(
      baseCfg({ questionBroker: foreignBroker, spawnedAsTaskId: "child-X" }),
    )
    const frun = askViaTool(foreignCtx, "foreign?")
    await waitPending(foreignBroker, 1)
    expect(reader?.snapshot().map((a) => a.id)).toEqual(["child-A"]) // NOT child-X

    broker.cancelAll("teardown")
    foreignBroker.cancelAll("teardown")
    await run
    await frun
  })

  test("attention gate OFF ⇒ bundle omits broker + reader (byte-identical)", () => {
    const bundle = buildLifecycleBundle(featureCfg(), {}) // no QUANTA_ATTENTION_NAV
    expect(bundle.taskRegistry).toBeDefined() // subagent pills still allocate it
    expect(bundle.questionBroker).toBeUndefined()
    expect(bundle.attentionReader).toBeUndefined()
  })
})

// ── (5) REGISTRY COMPLETENESS — constructor-call source scan (drift guard) ──

describe("RFC-01 A5 — TaskRegistry constructor completeness (source scan)", () => {
  /**
   * The scan requires a constructor CALL `new TaskRegistry(` (not a bare symbol /
   * type reference). RFC-01 §Existing owner map targets ONE construction owner in
   * session-authority assembly; A2's consolidation (delete the four fallback
   * mints) is NOT yet landed. This guard PINS the exact current construction set
   * so no NEW competing constructor can appear (board §8 stop: "a new competing
   * writer/constructor appears"), and documents the remaining consolidation.
   */
  test("no production `new TaskRegistry()` outside the KNOWN construction sites", async () => {
    const { Glob } = await import("bun")
    const root = new URL("../../src/", import.meta.url).pathname
    const glob = new Glob("**/*.ts")
    const CALL = /new\s+TaskRegistry\s*\(/
    // Strip block + line comments so a constructor CALL is required, never a bare
    // symbol/prose mention (e.g. subagent.ts's "defaults to `new TaskRegistry()`").
    const stripComments = (s: string): string =>
      s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    const hits: string[] = []
    for await (const rel of glob.scan(root)) {
      if (rel.endsWith(".test.ts")) continue
      const text = stripComments(await Bun.file(root + rel).text())
      if (CALL.test(text)) hits.push(rel.replace(/\\/g, "/"))
    }
    hits.sort()

    // KNOWN sites, each classified. TARGET = the single authority builder; the
    // two surface roots + two fallback mints are A2's pending consolidation.
    const KNOWN = [
      "agent/optional-ports.ts", // FALLBACK mint (env-gated surfaces) — A2 must remove
      "apps/cli/repl/factories/lifecycle.ts", // CLI surface root — A2 moves to builder
      "apps/web-daemon/runtime-factory/session-collaborators.ts", // web surface root (god-module split of runtime-factory.ts) — A2 moves to builder
      "subagent/agent-tool.ts", // FALLBACK `?? new TaskRegistry()` — A2 must remove
    ]
    // Exact-set drift guard: catches BOTH a new competing constructor (hit not in
    // KNOWN) AND the eventual A2 consolidation (a KNOWN site removed ⇒ update).
    expect(hits).toEqual(KNOWN)
  })
})
