import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runAgent } from "@/agent"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { __resetRuntimeConfig } from "@/shared"
import { defaultTools, ToolRegistry } from "@/tool"
import { cfg, RecordingStream, withTimeout } from "./_harness"

/**
 * rev.4 MIN-CAP (RFC jul-13 §4.3): the effective spawn cap is
 * `min(operator policy = runtimeConfig().maxDescendantDepth [default 1],
 * requested = config.subagent?.maxDepth ?? +∞)`. A per-run `subagent.maxDepth`
 * can only TIGHTEN the operator policy, NEVER raise it. The MULTI-LEVEL
 * MECHANISM tests below (parent→child→grandchild…) need real depth HEADROOM to
 * exercise the depth machinery, so they RAISE THE OPERATOR POLICY via
 * `QUANTA_MAX_DESCENDANT_DEPTH` to the SAME value as their `subagent.maxDepth`
 * (e.g. a `maxDepth:3` test pins the policy to 3 ⇒ `min(3,3)=3`). This restores
 * the policy headroom the pre-rev.4 default 3 used to provide, WITHOUT changing
 * what each test proves (recursion bounded at N, deny at the bound, cascade
 * abort). runtimeConfig() is first-access-frozen, so each such test sets the env
 * then calls `__resetRuntimeConfig()` BEFORE `runAgent`, and the afterEach in the
 * owning describe restores it.
 */
const withPolicyCap = (value: string | undefined): void => {
  if (value === undefined) delete process.env.QUANTA_MAX_DESCENDANT_DEPTH
  else process.env.QUANTA_MAX_DESCENDANT_DEPTH = value
  __resetRuntimeConfig()
}

/**
 * GAP 6 — a REAL recursive subagent fork through `runAgent`.
 *
 * `config.subagent` is set, so features.ts builds the `agent`/`task_output`/
 * `task_stop` tools wired against a real `createSubagentRunner(config)` — the
 * ACTUAL fork path (no injected fake runner). When the scripted parent model
 * calls the `agent` tool, the runner builds a child `AgentConfig`
 * (`buildChildConfig`: keeps `parent.llm`) and calls the real `runAgent` on
 * the child. The child runs its own loop on the SAME `llm`; we route turns by
 * a unique marker in the latest user message so parent / child / grandchild
 * are deterministic and isolated.
 *
 * Asserts: (1) the child actually forked and ran (its scripted turn produced
 * the answer the parent surfaces as a tool_result summary), (2) the parent
 * then completes, and (3) ADR-0011: `buildChildConfig` now PROPAGATES
 * `config.subagent` into the child, so a forked child ALSO registers the
 * `agent` tool and CAN spawn sub-subagents. Recursion is bounded MULTI-LEVEL
 * by `maxDepth`: with `maxDepth:2` a parent→child→grandchild chain spawns real
 * nested subagents, and the FIRST spawn attempt that would exceed the ceiling
 * returns a recoverable "max subagent depth exceeded" tool_result (never a
 * throw, never an unbounded spawn) while the whole chain still completes.
 */

const text = (t: string): StreamEvent[] => [
  { type: "text_delta", delta: t },
  { type: "message_stop", stop_reason: "end_turn" },
]
const agentCall = (id: string, prompt: string): StreamEvent[] => [
  { type: "tool_use_start", id, name: "agent" },
  { type: "tool_use_end", id, input: { prompt } },
  { type: "message_stop", stop_reason: "tool_use" },
]

/** All conversation text (every message, every block) so routing is robust
 *  against the ephemeral trailing `<system-reminder>` `buildTurnContext`
 *  appends — the marker we route on lives in a real user/tool_result block. */
const conversationText = (input: StreamInput): string =>
  input.messages
    .flatMap((m) =>
      m.content.map((b) =>
        b.type === "text" ? b.text : b.type === "tool_result" ? b.content : "",
      ),
    )
    .join(" ")

/**
 * Routes each turn by a substring match against the latest user message.
 * `once:true` rules fire a single time then are spent (so a parent that polls
 * again after a tool_result moves to its follow-up rule).
 */
class RoutingLLM implements LLMPort {
  readonly model = "routing-test-model"
  log: string[] = []
  private rules: { match: string; events: StreamEvent[]; once?: boolean; spent?: boolean }[]
  constructor(rules: { match: string; events: StreamEvent[]; once?: boolean }[]) {
    this.rules = rules.map((r) => ({ ...r }))
  }
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    const txt = conversationText(input)
    const rule = this.rules.find((r) => txt.includes(r.match) && !(r.once && r.spent))
    if (!rule) {
      this.log.push(`UNMATCHED:${txt.slice(0, 40)}`)
      yield* text("unmatched fallback")
      return
    }
    if (rule.once) rule.spent = true
    this.log.push(`${rule.match}`)
    for (const e of rule.events) yield e
  }
}

describe("GAP 6 — real recursive subagent fork through runAgent", () => {
  test("parent forks a real child runAgent; child summary returned to parent", async () => {
    const llm = new RoutingLLM([
      // Parent root turn: delegate via the real `agent` tool.
      {
        match: "PARENT-GO",
        events: agentCall("a1", "CHILD-TASK do the subtask"),
        once: true,
      },
      // After the child's tool_result returns, parent finishes.
      { match: "Subagent completed", events: text("parent done with child result") },
      // Child root turn (its seed = the req.prompt) — real forked loop.
      { match: "CHILD-TASK", events: text("CHILD-ANSWER computed in the fork") },
    ])
    const stream = new RecordingStream()
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream,
          registry: new ToolRegistry(defaultTools),
          messages: [{ role: "user", content: [{ type: "text", text: "PARENT-GO" }] }],
          subagent: { maxDepth: 3 },
          maxTurns: 5,
        }),
      ),
      15_000,
      "subagent-fork",
    )

    expect(out.reason).toBe("completed")
    // The child loop actually ran (its routed turn fired between the parent's).
    expect(llm.log).toContain("CHILD-TASK")
    expect(llm.log.indexOf("PARENT-GO")).toBeLessThan(llm.log.indexOf("CHILD-TASK"))

    // The child's answer comes back to the PARENT as the agent tool_result.
    const tr = out.messages.flatMap((m) => m.content.filter((b) => b.type === "tool_result"))
    expect(tr).toHaveLength(1)
    if (tr[0]?.type !== "tool_result") throw new Error("expected tool_result")
    expect(tr[0].content).toContain("Subagent completed")
    expect(tr[0].content).toContain("CHILD-ANSWER computed in the fork")

    // Parent then completed with its own final assistant turn.
    const finalAssistant = out.messages.findLast((m) => m.role === "assistant")
    const finalText = (finalAssistant?.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
    expect(finalText).toContain("parent done with child result")
  })

  test("recursion is bounded MULTI-LEVEL by maxDepth: parent→child→grandchild, the next spawn is a recoverable deny", async () => {
    // ADR-0011: `buildChildConfig` (subagent-runner.ts) NOW propagates
    // `config.subagent` into the child, so the child's own `runAgent`/
    // `buildSessionFeatures` DOES register an `agent` tool — a forked child can
    // itself spawn sub-subagents. Recursion is bounded MULTI-LEVEL by
    // `maxDepth` (the real, load-bearing bound): with `maxDepth:2` the depth
    // chain is parent(depth 0) → child(depth 1) → grandchild(depth 2). The
    // grandchild's attempt to spawn a 4th level computes `childDepth = 3 >
    // maxDepth 2`, so the `agent` tool yields a recoverable deny tool_result
    // ("recursion depth 3 exceeds maxDepth 2") WITHOUT ever calling the runner
    // — never a throw, never an unbounded spawn. The runner's own
    // `req.depth > maxDepth ⇒ "max subagent depth exceeded"` guard is the
    // mirror of the same bound (it would fire if a req.depth of 3 ever reached
    // it). The deny is recoverable, so the grandchild, child and parent all
    // still complete cleanly.
    //
    // Determinism + hard bound against a logic regression: each level routes on
    // its OWN unique seed marker. Every spawn rule is `once`, so a level spawns
    // AT MOST one child; after it is spent the same marker matches that level's
    // follow-up rule. Markers are disjoint and there is NO rule that would
    // spawn a 4th-level loop, so a depth-guard regression cannot infinite-loop
    // — it would instead surface as an UNMATCHED fallback / spawn-count
    // assertion failure. maxTurns is also low per the cfg default.
    // rev.4 min-cap: RAISE the operator policy to 2 so the intended
    // `subagent.maxDepth:2` is EFFECTIVE (min(2,2)=2). Without this the default
    // policy 1 would clamp to min(1,2)=1 and the depth-1 child would already be a
    // leaf — the multi-level mechanism could not be exercised.
    withPolicyCap("2")
    const llm = new RoutingLLM([
      // Parent (depth 0): spawn child once, then finish.
      { match: "PARENT-GO", events: agentCall("a1", "LEVEL1-TASK spawn child"), once: true },
      { match: "PARENT-GO", events: text("PARENT-DONE") },
      // Child (depth 1): spawn grandchild once, then finish.
      { match: "LEVEL1-TASK", events: agentCall("a2", "LEVEL2-TASK spawn grandchild"), once: true },
      { match: "LEVEL1-TASK", events: text("CHILD-DONE") },
      // Grandchild (depth 2): attempt a 4th level — the `agent` tool denies it
      // (childDepth 3 > effectiveCap 2). Recover from the deny tool_result, finish.
      {
        match: "LEVEL2-TASK",
        events: agentCall("a3", "LEVEL3-TASK must never spawn a real loop"),
        once: true,
      },
      { match: "exceeds maxDepth", events: text("GRANDCHILD-SAW-DENY-AND-STOPPED") },
      // Guard: a real 4th-level loop would seed on LEVEL3-TASK. It must NEVER
      // run — if this fires the depth bound regressed.
      { match: "LEVEL3-TASK", events: text("LEVEL4-RAN-ILLEGALLY") },
    ])
    let out: Awaited<ReturnType<typeof runAgent>>
    try {
      out = await withTimeout(
        runAgent(
          cfg({
            llm,
            registry: new ToolRegistry(defaultTools),
            messages: [{ role: "user", content: [{ type: "text", text: "PARENT-GO" }] }],
            subagent: { maxDepth: 2 },
            maxTurns: 6,
          }),
        ),
        15_000,
        "subagent-depth-multi",
      )
    } finally {
      withPolicyCap(undefined)
    }

    expect(out.reason).toBe("completed")

    // All three real levels ran, in order, exactly once each.
    expect(llm.log).toContain("LEVEL1-TASK")
    expect(llm.log).toContain("LEVEL2-TASK")
    // The 4th-level loop NEVER executed (recursion bounded at maxDepth).
    expect(llm.log).not.toContain("LEVEL3-TASK")
    expect(llm.log).not.toContain("LEVEL4-RAN-ILLEGALLY")
    expect(llm.log).not.toContain("UNMATCHED")
    // The grandchild saw the deny tool_result and recovered (proves the bound
    // is a recoverable deny, not a throw and not an unbounded spawn).
    expect(llm.log).toContain("exceeds maxDepth")

    // Hard call-count bound: a depth-guard regression cannot infinite-loop.
    // Exactly the 6 scripted turns: parent ×2 (spawn child, then finish),
    // child ×2 (spawn grandchild, then finish), grandchild ×2 (attempt 4th
    // level → denied, then recover). A regression that let the grandchild
    // actually fork a 4th loop would add a "LEVEL3-TASK" turn (asserted absent
    // above) and push this count past 6 / surface as UNMATCHED.
    expect(llm.log.length).toBe(6)
    expect(llm.log).toEqual([
      "PARENT-GO", // parent forks child (req.depth 1 ≤ 2)
      "LEVEL1-TASK", // child forks grandchild (req.depth 2 ≤ 2)
      "LEVEL2-TASK", // grandchild attempts 4th level → tool deny (childDepth 3 > 2)
      "exceeds maxDepth", // grandchild recovers from the deny tool_result
      "LEVEL1-TASK", // child finishes after grandchild summary
      "PARENT-GO", // parent finishes after child summary
    ])

    // Order: each level forked before the level below it could route.
    expect(llm.log.indexOf("PARENT-GO")).toBeLessThan(llm.log.indexOf("LEVEL1-TASK"))
    expect(llm.log.indexOf("LEVEL1-TASK")).toBeLessThan(llm.log.indexOf("LEVEL2-TASK"))
    expect(llm.log.indexOf("LEVEL2-TASK")).toBeLessThan(llm.log.indexOf("exceeds maxDepth"))

    // The whole chain still completed. The parent's single tool_result carries
    // the child's summary; per the runner's contract `finalText` is the child's
    // TRAILING assistant text only (`lastAssistantText`) — the grandchild's
    // summary was a tool_result *inside the child loop*, not the child's final
    // assistant turn, so it does NOT string-nest into the parent's tool_result.
    // Transitive completion across all three levels is instead proven by the
    // exact `llm.log` ordering asserted above (each level forked the one below
    // and the grandchild recovered from the deny before any level finished).
    const tr = out.messages.flatMap((m) => m.content.filter((b) => b.type === "tool_result"))
    expect(tr).toHaveLength(1)
    if (tr[0]?.type !== "tool_result") throw new Error("expected tool_result")
    expect(tr[0].content).toContain("Subagent completed")
    expect(tr[0].content).toContain("CHILD-DONE")

    // Parent then completed with its own final assistant turn.
    const finalAssistant = out.messages.findLast((m) => m.role === "assistant")
    const finalText = (finalAssistant?.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
    expect(finalText).toContain("PARENT-DONE")
  })
})

// ============================================================================
// Hell-cases — adversarial scenarios for the subagent fork path. Pins exact
// behavior under depth attacks, cancellation storms, malformed inputs,
// concurrent forks, worktree isolation edge cases, and result-shape drift.
// NO production code is modified; every test exists to break the fork engine
// the instant a regression sneaks in.
// ============================================================================

/** Helper: a routing LLM rule that responds to a given seed marker with a
 *  single text turn so the matched child finishes after one stream call.
 *  Used for stress tests where we don't care about routing precision. */
const finishingRules = (label: string) => ({
  match: label,
  events: [
    { type: "text_delta" as const, delta: `finished-${label}` },
    { type: "message_stop" as const, stop_reason: "end_turn" },
  ],
})

describe("subagent hell-cases — recursion depth attack", () => {
  afterEach(() => {
    withPolicyCap(undefined)
  })

  test("(SH1.a) 10-level nested fork attempt bottoms out at maxDepth=3, depth-bound surfaces as deny", async () => {
    // Each level tries to spawn the next. With maxDepth=3 the chain runs:
    // parent(0) → child(1) → grandchild(2) → great-grandchild(3) and the
    // FIFTH spawn (childDepth=4 > maxDepth=3) yields the recoverable deny.
    // The 10-level intent is captured by the script presence of LEVEL{4..9}
    // rules — they MUST never fire.
    //
    // rev.4 min-cap: RAISE the operator policy to 3 so `subagent.maxDepth:3` is
    // EFFECTIVE (min(3,3)=3). Default policy 1 would clamp to 1 and bottom the
    // chain at depth 1, defeating the 3-level mechanism under test.
    withPolicyCap("3")
    const llm = new RoutingLLM([
      { match: "PARENT-GO", events: agentCall("a1", "LEVEL1-TASK spawn"), once: true },
      { match: "PARENT-GO", events: text("PARENT-DONE") },
      { match: "LEVEL1-TASK", events: agentCall("a2", "LEVEL2-TASK spawn"), once: true },
      { match: "LEVEL1-TASK", events: text("L1-DONE") },
      { match: "LEVEL2-TASK", events: agentCall("a3", "LEVEL3-TASK spawn"), once: true },
      { match: "LEVEL2-TASK", events: text("L2-DONE") },
      { match: "LEVEL3-TASK", events: agentCall("a4", "LEVEL4-TASK spawn"), once: true },
      // After the depth-deny tool_result arrives, the L3 child finishes.
      { match: "exceeds maxDepth", events: text("L3-DEPTH-DENY-OBSERVED") },
      // Sentinels — these must NEVER fire (depth guard regression detector):
      { match: "LEVEL4-TASK", events: text("LEVEL4-LEAKED") },
      { match: "LEVEL5-TASK", events: text("LEVEL5-LEAKED") },
      { match: "LEVEL6-TASK", events: text("LEVEL6-LEAKED") },
      { match: "LEVEL7-TASK", events: text("LEVEL7-LEAKED") },
      { match: "LEVEL8-TASK", events: text("LEVEL8-LEAKED") },
      { match: "LEVEL9-TASK", events: text("LEVEL9-LEAKED") },
    ])
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          registry: new ToolRegistry(defaultTools),
          messages: [{ role: "user", content: [{ type: "text", text: "PARENT-GO" }] }],
          subagent: { maxDepth: 3 },
          maxTurns: 10,
        }),
      ),
      15_000,
      "10-level-depth-attack",
    )

    expect(out.reason).toBe("completed")
    // Levels 1..3 each ran exactly once (chain bottomed at depth 3); level 4+
    // never executed (the depth-bound deny short-circuits before the runner is
    // invoked).
    expect(llm.log).toContain("LEVEL1-TASK")
    expect(llm.log).toContain("LEVEL2-TASK")
    expect(llm.log).toContain("LEVEL3-TASK")
    expect(llm.log).toContain("exceeds maxDepth")
    // No level deeper than 3 ever ran. Strong leak detector.
    for (const sentinel of [
      "LEVEL4-TASK",
      "LEVEL5-TASK",
      "LEVEL6-TASK",
      "LEVEL7-TASK",
      "LEVEL8-TASK",
      "LEVEL9-TASK",
    ]) {
      expect(llm.log).not.toContain(sentinel)
    }
    expect(llm.log).not.toContain("UNMATCHED")
  })

  test("(SH1.b) parent at depth=3 tries to fork → child returns non-ok result (recoverable deny, never throws)", async () => {
    // With maxDepth=2 the chain parent(0) → child(1) → grandchild(2) works,
    // but the grandchild's attempt at a 4th spawn (childDepth=3 > 2) MUST
    // surface a recoverable deny tool_result and not throw. (This is the
    // mirror of SH1.a at a tighter depth so the deny edge fires earlier and
    // we can pin the deny content shape precisely.)
    //
    // rev.4 min-cap: RAISE the operator policy to 2 so `subagent.maxDepth:2` is
    // EFFECTIVE (min(2,2)=2); default policy 1 would clamp the grandchild away.
    withPolicyCap("2")
    const llm = new RoutingLLM([
      { match: "PARENT-GO", events: agentCall("a1", "LEVEL1-TASK"), once: true },
      { match: "PARENT-GO", events: text("PARENT-DONE") },
      { match: "LEVEL1-TASK", events: agentCall("a2", "LEVEL2-TASK"), once: true },
      { match: "LEVEL1-TASK", events: text("L1-DONE") },
      { match: "LEVEL2-TASK", events: agentCall("a3", "LEVEL3-NEVER-RUNS"), once: true },
      { match: "exceeds maxDepth", events: text("L2-OBSERVED-DENY") },
      // Sentinel: must NEVER fire.
      { match: "LEVEL3-NEVER-RUNS", events: text("DEPTH-LEAKED") },
    ])
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          registry: new ToolRegistry(defaultTools),
          messages: [{ role: "user", content: [{ type: "text", text: "PARENT-GO" }] }],
          subagent: { maxDepth: 2 },
          maxTurns: 8,
        }),
      ),
      15_000,
      "depth-3-fork-deny",
    )

    expect(out.reason).toBe("completed")
    // The depth deny was observed by the grandchild and surfaced cleanly.
    expect(llm.log).toContain("exceeds maxDepth")
    expect(llm.log).not.toContain("LEVEL3-NEVER-RUNS")
    expect(llm.log).not.toContain("UNMATCHED")
    // The PARENT's single agent tool_result eventually carries the child summary.
    const tr = out.messages.flatMap((m) => m.content.filter((b) => b.type === "tool_result"))
    expect(tr).toHaveLength(1)
    if (tr[0]?.type === "tool_result") {
      // The deny message lives inside the chain (grandchild's inner tool_result),
      // not nested into the parent's tool_result — the parent only sees the
      // child's trailing assistant text per the `lastAssistantText` contract.
      expect(tr[0].content).toContain("Subagent completed")
    }
  })
})

describe("subagent hell-cases — cancellation storm", () => {
  afterEach(() => {
    withPolicyCap(undefined)
  })

  test("(SH2.a) parent aborted before any child spawn → outcome.reason=aborted cleanly", async () => {
    // Cancellation storm baseline: parent's signal aborts BEFORE the first
    // turn streams. The whole fork tree collapses cleanly — no half-spawned
    // children, no hangs, exactly one done(aborted) event.
    const llm = new RoutingLLM([
      { match: "PARENT-GO", events: agentCall("a1", "CHILD1"), once: true },
      // Sentinel: must NEVER fire (parent aborted before reaching the loop).
      { match: "CHILD1", events: text("LEAKED") },
    ])
    const ac = new AbortController()
    ac.abort()
    const stream = new RecordingStream()
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream,
          registry: new ToolRegistry(defaultTools),
          messages: [{ role: "user", content: [{ type: "text", text: "PARENT-GO" }] }],
          subagent: { maxDepth: 3 },
          maxTurns: 5,
          signal: ac.signal,
        }),
      ),
      10_000,
      "pre-spawn-abort",
    )

    expect(out.reason).toBe("aborted")
    expect(out.turns).toBe(0)
    // No child ever spawned.
    expect(llm.log).not.toContain("CHILD1")
    // Exactly one done event.
    const done = stream.events.filter((e) => e.type === "done")
    expect(done).toHaveLength(1)
  })

  test("(SH2.b) parent aborts mid-child-stream → child aborts too (cascade)", async () => {
    // Parent spawns child; child's stream consults the chained signal; parent
    // aborts WHILE the child is mid-stream. Both must collapse cleanly.
    const ac = new AbortController()
    const llm = new RoutingLLM([
      { match: "PARENT-GO", events: agentCall("a1", "CHILD-RUN"), once: true },
      // After child returns, parent finishes — but it should never reach here
      // because we abort during the child.
      { match: "Subagent", events: text("PARENT-AFTER-ABORT-NEVER") },
      {
        match: "CHILD-RUN",
        events: [
          { type: "text_delta", delta: "child started..." },
          { type: "message_stop", stop_reason: "end_turn" },
        ],
      },
    ])
    // Wrap stream to fire abort on the first child event (heuristic via input
    // routing — we abort once the child stream is being constructed).
    const baseLlm = llm
    const interceptor: LLMPort = {
      model: baseLlm.model,
      async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
        // If this is the child's seed (contains CHILD-RUN as the prompt seed
        // marker, NOT yet a tool_result), abort mid-stream after one event.
        const txt = input.messages
          .flatMap((m) => m.content.map((b) => (b.type === "text" ? b.text : "")))
          .join(" ")
        const isChild = txt.includes("CHILD-RUN") && !txt.includes("Subagent")
        if (isChild) {
          yield { type: "text_delta", delta: "child got going..." }
          ac.abort()
          yield { type: "text_delta", delta: "...never observed" }
          yield { type: "message_stop", stop_reason: "end_turn" }
          return
        }
        yield* baseLlm.stream(input)
      },
    }
    const stream = new RecordingStream()
    const out = await withTimeout(
      runAgent(
        cfg({
          llm: interceptor,
          stream,
          registry: new ToolRegistry(defaultTools),
          messages: [{ role: "user", content: [{ type: "text", text: "PARENT-GO" }] }],
          subagent: { maxDepth: 3 },
          maxTurns: 5,
          signal: ac.signal,
        }),
      ),
      10_000,
      "parent-abort-mid-child",
    )

    expect(out.reason).toBe("aborted")
    // Parent never reached the post-child finish.
    expect(llm.log).not.toContain("Subagent")
    // Bounded outcome.turns — abort came before any productive parent turn
    // completed (the agent tool call was streamed but the child aborted
    // mid-flight, so the tool_use turn never settled to a productive count).
    expect(out.turns).toBeLessThanOrEqual(1)
  })

  test("(SH2.c) 5 sequential foreground child spawns, each exhausts its tiny budget → 5 non-ok tool_results, parent recovers", async () => {
    // Cancellation storm flavor: parent spawns 5 child agents sequentially.
    // Each child has a tiny per-task budget (max_turns:1) and only ever emits
    // tool_use that drives it past its budget ⇒ runner returns
    // reason:"max_turns" ⇒ `toResult` maps to ok:false (`is_error:true`).
    // The parent's recovery rule emits the NEXT agent call directly (NOT a
    // text marker), so each non-ok tool_result advances the chain to the
    // next spawn. Pin: 5 distinct child loops, 5 non-ok tool_results.
    let childStreamCount = 0
    let parentSpawnIdx = 0
    const spawn = (i: number): StreamEvent[] => [
      { type: "tool_use_start", id: `a${i}`, name: "agent" },
      {
        type: "tool_use_end",
        id: `a${i}`,
        input: { prompt: `CHILD-SX-${i}`, max_turns: 1 },
      },
      { type: "message_stop", stop_reason: "tool_use" },
    ]
    const baseLlm: LLMPort = {
      model: "seq-spawn-llm",
      async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
        const txt = input.messages
          .flatMap((m) => m.content.map((b) => (b.type === "text" ? b.text : "")))
          .join(" ")
        // Latest message is a child seed (contains CHILD-SX-<N> WITHOUT
        // "Subagent ...") OR the parent saw a tool_result back.
        const isChildSeed = /CHILD-SX-\d+/.test(txt) && !txt.includes("Subagent")
        if (isChildSeed) {
          childStreamCount += 1
          // Child emits a tool_use that fails to satisfy its budget.
          yield { type: "tool_use_start", id: "r", name: "read" }
          yield { type: "tool_use_end", id: "r", input: { path: "/tmp/__nope__.txt" } }
          yield { type: "message_stop", stop_reason: "tool_use" }
          return
        }
        // Parent path: first spawn on PARENT-GO; subsequent spawns on each
        // "Subagent failed" tool_result. After 5 spawns, end.
        if (parentSpawnIdx < 5) {
          parentSpawnIdx += 1
          for (const e of spawn(parentSpawnIdx)) yield e
          return
        }
        // All 5 done → parent finishes.
        yield { type: "text_delta", delta: "ALL-DONE" }
        yield { type: "message_stop", stop_reason: "end_turn" }
      },
    }
    const stream = new RecordingStream()
    const out = await withTimeout(
      runAgent(
        cfg({
          llm: baseLlm,
          stream,
          registry: new ToolRegistry(defaultTools),
          messages: [{ role: "user", content: [{ type: "text", text: "PARENT-GO" }] }],
          subagent: { maxDepth: 2 },
          maxTurns: 30,
        }),
      ),
      15_000,
      "5-sequential-child-budget-aborts",
    )

    expect(out.reason).toBe("completed")
    // 5 distinct child loops actually streamed (one per spawn).
    expect(childStreamCount).toBe(5)
    expect(parentSpawnIdx).toBe(5)
    // 5 tool_result blocks landed in the parent — each carrying the failure.
    const tr = out.messages.flatMap((m) => m.content.filter((b) => b.type === "tool_result"))
    expect(tr.length).toBe(5)
    for (const block of tr) {
      if (block.type === "tool_result") {
        expect(block.is_error).toBe(true) // ok:false propagated to is_error
        expect(block.content).toContain("Subagent failed")
      }
    }
  })

  test("(SH2.d) cascade abort: parent → child → grandchild all collapse when root aborts", async () => {
    // Chain: parent(0) spawns child(1) which spawns grandchild(2). Root
    // signal trips while the grandchild is mid-stream. Both child and parent
    // must unwind cleanly via the chained signal.
    //
    // rev.4 min-cap: RAISE the operator policy to 2 so `subagent.maxDepth:2` is
    // EFFECTIVE (min(2,2)=2) and the grandchild at depth 2 actually spawns — the
    // whole point of this cascade-abort test. Default policy 1 would clamp the
    // child to a leaf so the grandchild never streams and the abort never trips.
    withPolicyCap("2")
    const ac = new AbortController()
    const baseLlm = new RoutingLLM([
      { match: "PARENT-GO", events: agentCall("a1", "L1-TASK"), once: true },
      { match: "Subagent", events: text("PARENT-NEVER-FINISHES") },
      { match: "L1-TASK", events: agentCall("a2", "L2-GRANDCHILD"), once: true },
      // After grandchild aborts the child would normally see it — but we abort
      // root mid-grandchild, so the child also collapses.
      { match: "L1-TASK", events: text("CHILD-NEVER-FINISHES") },
    ])
    const interceptor: LLMPort = {
      model: baseLlm.model,
      async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
        const txt = input.messages
          .flatMap((m) => m.content.map((b) => (b.type === "text" ? b.text : "")))
          .join(" ")
        const isGrandchild = txt.includes("L2-GRANDCHILD") && !txt.includes("Subagent")
        if (isGrandchild) {
          yield { type: "text_delta", delta: "grandchild streaming..." }
          ac.abort() // root signal trips during grandchild
          yield { type: "text_delta", delta: "...unreached" }
          yield { type: "message_stop", stop_reason: "end_turn" }
          return
        }
        yield* baseLlm.stream(input)
      },
    }
    const out = await withTimeout(
      runAgent(
        cfg({
          llm: interceptor,
          registry: new ToolRegistry(defaultTools),
          messages: [{ role: "user", content: [{ type: "text", text: "PARENT-GO" }] }],
          subagent: { maxDepth: 3 },
          maxTurns: 10,
          signal: ac.signal,
        }),
      ),
      15_000,
      "cascade-abort-3-levels",
    )

    // The root signal trips ⇒ the parent's outcome must be "aborted".
    expect(out.reason).toBe("aborted")
    // Neither parent nor child saw their finish-rule (root aborted them all).
    expect(baseLlm.log).not.toContain("PARENT-NEVER-FINISHES")
    expect(baseLlm.log).not.toContain("CHILD-NEVER-FINISHES")
  })
})

describe("subagent hell-cases — malformed task input", () => {
  test("(SH3.a) prompt with NUL byte → runner accepts and forwards to child seed verbatim", async () => {
    // The agent tool's zod schema accepts arbitrary strings, including NUL
    // bytes. The runner injects the prompt into the child's seed text.
    // Behavior: child sees the NUL in its seed and completes; the parent
    // surfaces the child's normal completion. NO production code should
    // sanitize or reject — we pin pass-through behavior.
    const NUL_PROMPT = "do task\x00with embedded nul"
    const llm = new RoutingLLM([
      { match: "PARENT-GO", events: agentCall("a1", NUL_PROMPT), once: true },
      { match: "Subagent completed", events: text("PARENT-DONE-WITH-NUL") },
      { match: "with embedded nul", events: text("CHILD-SAW-NUL") },
    ])
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          registry: new ToolRegistry(defaultTools),
          messages: [{ role: "user", content: [{ type: "text", text: "PARENT-GO" }] }],
          subagent: { maxDepth: 3 },
          maxTurns: 5,
        }),
      ),
      10_000,
      "nul-byte-prompt",
    )

    expect(out.reason).toBe("completed")
    // The child DID run on the NUL prompt.
    expect(llm.log).toContain("with embedded nul")
    // The parent saw the child's summary.
    const tr = out.messages.flatMap((m) => m.content.filter((b) => b.type === "tool_result"))
    expect(tr).toHaveLength(1)
    if (tr[0]?.type === "tool_result") {
      expect(tr[0].content).toContain("CHILD-SAW-NUL")
    }
  })

  test("(SH3.b) 100k-char prompt → runner forwards verbatim, child receives full seed", async () => {
    // Oversized prompt: 100k chars. Runner has no length cap; the child sees
    // the full prompt. Pin: no truncation, no throw, child completes.
    const huge = `BIG-PROMPT ${"X".repeat(100_000)} END-BIG`
    const llm = new RoutingLLM([
      { match: "PARENT-GO", events: agentCall("a1", huge), once: true },
      { match: "Subagent completed", events: text("PARENT-DONE-BIG") },
      { match: "BIG-PROMPT", events: text("CHILD-SAW-BIG") },
    ])
    const start = performance.now()
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          registry: new ToolRegistry(defaultTools),
          messages: [{ role: "user", content: [{ type: "text", text: "PARENT-GO" }] }],
          subagent: { maxDepth: 3 },
          maxTurns: 5,
        }),
      ),
      15_000,
      "100k-prompt",
    )
    const elapsed = performance.now() - start

    expect(out.reason).toBe("completed")
    expect(llm.log).toContain("BIG-PROMPT")
    // Bounded runtime: no quadratic blow-up while routing 100k chars.
    expect(elapsed).toBeLessThan(10_000)
  })

  test("(SH3.c) owned_surfaces with path traversal segments → passed to model AS-IS (no sanitization)", async () => {
    // The seed-augmentation step injects `ownedSurfaces` literally into the
    // child seed text. Path traversal segments like "../etc/passwd" are NOT
    // sanitized by the runner — they are documentation/intent only. Worktree
    // isolation (physical) is the real safety; this field is just text the
    // LLM is told to honor. Pin: pass-through, no rewrite.
    const llm = new RoutingLLM([
      {
        match: "PARENT-GO",
        events: [
          { type: "tool_use_start", id: "a1", name: "agent" },
          {
            type: "tool_use_end",
            id: "a1",
            input: {
              prompt: "INSPECT-TASK",
              owned_surfaces: ["../etc/passwd", "/etc/hosts", "../../root/.ssh/id_rsa"],
              forbidden_surfaces: ["../../../sensitive"],
            },
          },
          { type: "message_stop", stop_reason: "tool_use" },
        ],
        once: true,
      },
      { match: "Subagent completed", events: text("PARENT-DONE-TRAVERSAL") },
      // The child seed will contain BOTH the prompt AND the literal traversal
      // segments under "Owned surfaces"/"Forbidden surfaces" blocks. Route on
      // the literal traversal string to prove they were embedded verbatim.
      { match: "../etc/passwd", events: text("CHILD-SAW-TRAVERSAL-VERBATIM") },
    ])
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          registry: new ToolRegistry(defaultTools),
          messages: [{ role: "user", content: [{ type: "text", text: "PARENT-GO" }] }],
          subagent: { maxDepth: 3 },
          maxTurns: 5,
        }),
      ),
      10_000,
      "path-traversal-surfaces",
    )

    expect(out.reason).toBe("completed")
    // Confirm: the traversal substring routed inside the child — proving
    // verbatim seed injection. NO sanitization layer rewrites/escapes them.
    expect(llm.log).toContain("../etc/passwd")
    // Parent saw the child summary cleanly.
    const tr = out.messages.flatMap((m) => m.content.filter((b) => b.type === "tool_result"))
    expect(tr).toHaveLength(1)
  })
})

describe("subagent hell-cases — concurrent fork stress", () => {
  test("(SH4.a) 10 parallel agent-tool calls in ONE assistant turn → all dispatch, all results in order", async () => {
    // ONE assistant turn emits 10 `agent` tool_use blocks. `agent` is
    // concurrency-unsafe (isConcurrencySafe: () => false), so they all become
    // post-stream serial dispatches. Result order is strictly preserved.
    const ids = Array.from({ length: 10 }, (_, i) => `a${i}`)
    const llm = new RoutingLLM([
      {
        match: "PARENT-GO",
        events: [
          ...ids.flatMap((id, i) => [
            { type: "tool_use_start" as const, id, name: "agent" },
            {
              type: "tool_use_end" as const,
              id,
              input: { prompt: `CHILD-P${i}` },
            },
          ]),
          { type: "message_stop", stop_reason: "tool_use" },
        ],
        once: true,
      },
      // After all 10 children return, parent finishes.
      { match: "PARENT-GO", events: text("PARENT-DONE-CONCURRENT") },
      // Each child finishes immediately with a distinct marker.
      ...ids.map((_, i) => finishingRules(`CHILD-P${i}`)),
    ])
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          registry: new ToolRegistry(defaultTools),
          messages: [{ role: "user", content: [{ type: "text", text: "PARENT-GO" }] }],
          subagent: { maxDepth: 3 },
          maxTurns: 5,
        }),
      ),
      15_000,
      "10-parallel-agents",
    )

    expect(out.reason).toBe("completed")
    // 10 distinct child loops ran (one per id).
    for (let i = 0; i < 10; i++) {
      expect(llm.log).toContain(`CHILD-P${i}`)
    }
    // The user message after the assistant turn carries 10 tool_result blocks
    // in EXACT model-call order (a0..a9). This is the streaming-dispatch
    // ordering invariant pinned end-to-end under fork pressure.
    const resultMsg = out.messages.find(
      (m) => m.role === "user" && m.content.some((b) => b.type === "tool_result"),
    )
    const observedIds = resultMsg?.content
      .filter((b) => b.type === "tool_result")
      .map((b) => (b.type === "tool_result" ? b.tool_use_id : ""))
    expect(observedIds).toEqual(ids)
  })

  test("(SH4.b) 5 background spawns + 5 foreground spawns interleaved → all complete, no LRU evictions of running", async () => {
    // Mixed workload: 5 background (returns task_id immediately, runs in the
    // registry) + 5 foreground (parent awaits each). Background tasks should
    // never be evicted while running — this exercises TaskRegistry's
    // "never-evict-running" invariant under pressure.
    // Streaming agent IDs in ONE turn — half background, half foreground.
    const callBlocks: StreamEvent[] = []
    for (let i = 0; i < 10; i++) {
      callBlocks.push(
        { type: "tool_use_start", id: `m${i}`, name: "agent" },
        {
          type: "tool_use_end",
          id: `m${i}`,
          input: { prompt: `MIX-P${i}`, ...(i % 2 === 0 ? { background: true } : {}) },
        },
      )
    }
    callBlocks.push({ type: "message_stop", stop_reason: "tool_use" })

    const llm = new RoutingLLM([
      { match: "PARENT-GO", events: callBlocks, once: true },
      { match: "PARENT-GO", events: text("PARENT-DONE-MIX") },
      ...Array.from({ length: 10 }, (_, i) => finishingRules(`MIX-P${i}`)),
    ])
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          registry: new ToolRegistry(defaultTools),
          messages: [{ role: "user", content: [{ type: "text", text: "PARENT-GO" }] }],
          subagent: { maxDepth: 3 },
          maxTurns: 5,
        }),
      ),
      15_000,
      "mix-bg-fg-spawns",
    )

    expect(out.reason).toBe("completed")
    // All 10 tool_results landed in order.
    const resultMsg = out.messages.find(
      (m) => m.role === "user" && m.content.some((b) => b.type === "tool_result"),
    )
    const observedIds = resultMsg?.content
      .filter((b) => b.type === "tool_result")
      .map((b) => (b.type === "tool_result" ? b.tool_use_id : ""))
    expect(observedIds).toEqual(Array.from({ length: 10 }, (_, i) => `m${i}`))
    // Background spawn results carry "task_id:" preamble; foreground results
    // carry "Subagent completed" preamble. Pin both shapes appear.
    const trBlocks = resultMsg?.content.filter((b) => b.type === "tool_result") ?? []
    const bgResults = trBlocks.filter(
      (b) => b.type === "tool_result" && b.content.includes("task_id:"),
    )
    const fgResults = trBlocks.filter(
      (b) => b.type === "tool_result" && b.content.includes("Subagent completed"),
    )
    expect(bgResults).toHaveLength(5) // even-indexed → background
    expect(fgResults).toHaveLength(5) // odd-indexed → foreground
  })
})

describe("subagent hell-cases — worktree isolation fallback", () => {
  let nonGitDir: string

  beforeEach(() => {
    nonGitDir = mkdtempSync(join(tmpdir(), "subagent-non-git-"))
  })
  afterEach(() => {
    rmSync(nonGitDir, { recursive: true, force: true })
  })

  test("(SH5.a) isolation:worktree against a non-git cwd → silent fallback (no throw, child still runs)", async () => {
    // The runner's documented fallback: when `isolation:"worktree"` is
    // requested but parent.cwd is NOT a git repo, the runner silently falls
    // back to no isolation. The child runs in parent.cwd. NEVER throws.
    const llm = new RoutingLLM([
      {
        match: "PARENT-GO",
        events: [
          { type: "tool_use_start", id: "a1", name: "agent" },
          {
            type: "tool_use_end",
            id: "a1",
            input: { prompt: "NON-GIT-CHILD", isolation: "worktree" },
          },
          { type: "message_stop", stop_reason: "tool_use" },
        ],
        once: true,
      },
      { match: "Subagent completed", events: text("PARENT-DONE-NON-GIT") },
      { match: "NON-GIT-CHILD", events: text("CHILD-RAN-NO-WORKTREE") },
    ])
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          cwd: nonGitDir,
          registry: new ToolRegistry(defaultTools),
          messages: [{ role: "user", content: [{ type: "text", text: "PARENT-GO" }] }],
          subagent: { maxDepth: 3 },
          maxTurns: 5,
        }),
      ),
      10_000,
      "non-git-worktree-fallback",
    )

    expect(out.reason).toBe("completed")
    // The child DID run despite the failed isolation request.
    expect(llm.log).toContain("NON-GIT-CHILD")
    // Parent sees a clean Subagent completed result (no error, no throw).
    const tr = out.messages.flatMap((m) => m.content.filter((b) => b.type === "tool_result"))
    expect(tr).toHaveLength(1)
    if (tr[0]?.type === "tool_result") {
      expect(tr[0].content).toContain("Subagent completed")
      expect(tr[0].is_error).toBeUndefined() // ok=true ⇒ no is_error flag
    }
  })
})

describe("subagent hell-cases — result shape drift", () => {
  test("(SH6.a) child returns 1MB final-text → parent surfaces it without OOM (preview may be capped)", async () => {
    // The child's final assistant text is 1MB. Per the `lastAssistantText`
    // contract, the runner stringifies it into the parent's tool_result
    // content. The `tool_result` event PREVIEW may be capped by the output-
    // spill cap, but the canonical tool_result block in the parent's
    // messages contains the full child summary.
    const HUGE = "Z".repeat(1_000_000) // 1MB single string
    const llm = new RoutingLLM([
      { match: "PARENT-GO", events: agentCall("a1", "HUGE-CHILD-TASK"), once: true },
      { match: "Subagent completed", events: text("PARENT-DONE-HUGE") },
      {
        match: "HUGE-CHILD-TASK",
        events: [
          { type: "text_delta", delta: HUGE },
          { type: "message_stop", stop_reason: "end_turn" },
        ],
      },
    ])
    const start = performance.now()
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          registry: new ToolRegistry(defaultTools),
          messages: [{ role: "user", content: [{ type: "text", text: "PARENT-GO" }] }],
          subagent: { maxDepth: 3 },
          maxTurns: 5,
        }),
      ),
      15_000,
      "1mb-child-result",
    )
    const elapsed = performance.now() - start

    expect(out.reason).toBe("completed")
    // PINNED CURRENT BEHAVIOR: the dispatch seam routes every tool result
    // (including the `agent` tool's wrapped child summary) through
    // `capToolOutput` (output-spill), so a 1MB child final-text lands as a
    // `<persisted-output>…</persisted-output>` placeholder in the parent's
    // tool_result content. The placeholder is bounded (~head 8k + tail 4k +
    // wrapper) and the FULL original is written to a spill file under
    // `.quanta/tool-output/`. No OOM, no quadratic blowup, no throw.
    const tr = out.messages.flatMap((m) => m.content.filter((b) => b.type === "tool_result"))
    expect(tr).toHaveLength(1)
    if (tr[0]?.type === "tool_result") {
      // Either the full payload OR a bounded persisted-output placeholder.
      const c = tr[0].content
      const isPlaceholder = c.includes("<persisted-output>") && c.includes("</persisted-output>")
      const isFullPayload = c.length >= HUGE.length
      expect(isPlaceholder || isFullPayload).toBe(true)
      // If placeholder: length is bounded well below the original.
      if (isPlaceholder) expect(c.length).toBeLessThan(HUGE.length)
    }
    // No quadratic blowup; pin a generous-but-finite budget.
    expect(elapsed).toBeLessThan(10_000)
  })

  test("(SH6.b) child task_kind=read tries to call `write` → field is documentation/intent only, no runtime enforcement", async () => {
    // PIN: `task_kind` is intent (drives the default tool allowlist when
    // `tools` is unset), NOT a runtime guard. When the parent passes
    // task_kind:"read" the default allowlist EXCLUDES `write`/`edit`/`bash`,
    // so the child registry won't include them — a write attempt yields
    // "Unknown tool: write" at dispatch. We pin THIS observable, not a
    // hypothetical post-dispatch "task_kind says read" check (which v3 does
    // NOT implement).
    const llm = new RoutingLLM([
      {
        match: "PARENT-GO",
        events: [
          { type: "tool_use_start", id: "a1", name: "agent" },
          {
            type: "tool_use_end",
            id: "a1",
            input: { prompt: "READ-ONLY-TASK try a write", task_kind: "read" },
          },
          { type: "message_stop", stop_reason: "tool_use" },
        ],
        once: true,
      },
      { match: "Subagent", events: text("PARENT-DONE-READONLY") },
      {
        match: "READ-ONLY-TASK",
        events: [
          { type: "tool_use_start", id: "w1", name: "write" },
          { type: "tool_use_end", id: "w1", input: { path: "/tmp/x.txt", content: "y" } },
          { type: "message_stop", stop_reason: "tool_use" },
        ],
        once: true,
      },
      // After the child sees the "Unknown tool: write" deny, it recovers.
      { match: "Unknown tool: write", events: text("CHILD-OBSERVED-DENY") },
    ])
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          registry: new ToolRegistry(defaultTools),
          messages: [{ role: "user", content: [{ type: "text", text: "PARENT-GO" }] }],
          subagent: { maxDepth: 3 },
          maxTurns: 8,
        }),
      ),
      15_000,
      "task-kind-read-no-enforcement",
    )

    expect(out.reason).toBe("completed")
    // The child observed the registry-level deny ("Unknown tool: write") —
    // the deny path is the `task_kind:"read"` default toolFilter excluding
    // `write`, NOT a post-dispatch enforcement of the kind itself.
    expect(llm.log).toContain("Unknown tool: write")
  })
})
