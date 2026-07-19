/**
 * DOF-21 REAL-LOOP proof for `subagent-role-identity` (§20.1, config slot
 * `config.namedAgentResolver`).
 *
 * STALE/WEAK EXCERPT REPLACED — `tests/unit/subagent/named-agent-spawn-hellgate.test.ts`
 * drives the runner with a CAPTURING FAKE `runAgent` (`opts.run` injection):
 *
 *     const capturing = () => { const seen = []; return { run: async (c) => { seen.push(c); ... } } }
 *     await createSubagentRunner(parent, { run })(req({ agentType: "explorer" }))
 *     expect(seen[0].system).toBe(<role def system>)
 *
 * That asserts `buildChildConfig` PLACES `def.system` on the child config object,
 * but it NEVER runs a real child loop, so it does not prove the forked model
 * ACTUALLY RECEIVES the role system prompt in its turn input. `runAgent × role
 * identity == 0`.
 *
 * WHAT THIS DRIVES (the real fork loop, end-to-end):
 *   `runAgent` with a SCRIPTED `LLMPort` and `config.subagent` set (so the REAL
 *   `agent` tool is registered against a REAL `createSubagentRunner(config)`) PLUS
 *   `config.namedAgentResolver` wired to a fake resolver holding one role
 *   definition. The scripted parent calls `agent({ agent_type: "reviewer", prompt })`;
 *   the runner's `applyNamedAgent` folds `def.system` onto the child request, and
 *   the REAL forked child `runAgent` loop is handed that role prompt as its
 *   `input.system`. The child LLM RECORDS the `input.system` it actually received.
 *
 * GROUND TRUTH (what the child MODEL saw, not a captured config field):
 *   the child turn's `seenSystem` carries the ROLE identity string, NOT the
 *   parent's `system`. The one scripted LLM serves BOTH parent and child turns
 *   (routed by a marker in the latest user text — the subagent-fork-e2e idiom).
 *
 * PAIRED CONTROL (remove the one required condition ⇒ behavior fails):
 *   SAME spawn (`agent_type: "reviewer"`), but with `config.namedAgentResolver`
 *   OMITTED ⇒ `applyNamedAgent` is a no-op ⇒ the child inherits the PARENT's
 *   `system` verbatim (byte-identical default-OFF). The child model then sees the
 *   PARENT system, NOT the role prompt — proving the resolver, not some ambient
 *   default, is what specialized the child's identity. A second control axis: a
 *   spawn whose `agent_type` does NOT match any definition ⇒ resolver returns
 *   undefined ⇒ parent system inherited (matching, not merely wiring, is
 *   load-bearing).
 */

import { describe, expect, test } from "bun:test"
import { runAgent } from "@/agent"
import type { NamedAgentDefinition, NamedAgentResolver } from "@/agent/named-agent-registry"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { defaultTools, ToolRegistry } from "@/tool"
import { cfg, RecordingStream, withTimeout } from "./_harness"

const PARENT_SYSTEM = "PARENT-SYSTEM-IDENTITY: you are the ordinary root agent."
const ROLE_SYSTEM = "ROLE-SYSTEM-IDENTITY: you are a SECURITY REVIEWER. Refute everything."

const text = (t: string): StreamEvent[] => [
  { type: "text_delta", delta: t },
  { type: "message_stop", stop_reason: "end_turn" },
]
const agentCall = (id: string, agentType: string, prompt: string): StreamEvent[] => [
  { type: "tool_use_start", id, name: "agent" },
  { type: "tool_use_end", id, input: { prompt, agent_type: agentType } },
  { type: "message_stop", stop_reason: "tool_use" },
]

const conversationText = (input: StreamInput): string =>
  input.messages
    .flatMap((m) =>
      m.content.map((b) => (b.type === "text" ? b.text : b.type === "tool_result" ? b.content : "")),
    )
    .join(" ")

/** Routes each turn by a marker; RECORDS the `input.system` for every stream()
 *  call so we can read back what the CHILD model actually received. */
class RoutingLLM implements LLMPort {
  readonly model = "role-identity-routing-model"
  log: string[] = []
  /** Per-call captured system envelope, tagged with the matched rule. */
  readonly systemsByRule: { rule: string; system: string }[] = []
  private rules: { match: string; events: StreamEvent[]; once?: boolean; spent?: boolean }[]
  constructor(rules: { match: string; events: StreamEvent[]; once?: boolean }[]) {
    this.rules = rules.map((r) => ({ ...r }))
  }
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    const txt = conversationText(input)
    const rule = this.rules.find((r) => txt.includes(r.match) && !(r.once && r.spent))
    const sysText = systemText(input.system)
    if (!rule) {
      this.log.push(`UNMATCHED:${txt.slice(0, 40)}`)
      this.systemsByRule.push({ rule: "UNMATCHED", system: sysText })
      yield* text("unmatched fallback")
      return
    }
    if (rule.once) rule.spent = true
    this.log.push(rule.match)
    this.systemsByRule.push({ rule: rule.match, system: sysText })
    for (const e of rule.events) yield e
  }
}

/** Flatten the StreamInput.system envelope (string | block[]) to text. */
const systemText = (system: StreamInput["system"]): string => {
  if (system === undefined) return ""
  if (typeof system === "string") return system
  if (Array.isArray(system)) {
    return system
      .map((b) => (typeof b === "string" ? b : b?.type === "text" ? b.text : ""))
      .join("\n")
  }
  return ""
}

const makeResolver = (defs: NamedAgentDefinition[]): NamedAgentResolver => ({
  resolve: (agentType) => defs.find((d) => d.agentType === agentType),
  names: () => defs.map((d) => d.agentType),
})

const REVIEWER_DEF: NamedAgentDefinition = {
  agentType: "reviewer",
  system: ROLE_SYSTEM,
  sourcePath: "/fake/.quanta/agents/reviewer.md",
}

/** The system captured on the CHILD turn (routed by the child's seed marker). */
const childSystem = (llm: RoutingLLM, childMarker: string): string | undefined =>
  llm.systemsByRule.find((s) => s.rule === childMarker)?.system

describe("subagent-role-identity — REAL forked child loop receives the role system prompt", () => {
  test("gate ON (resolver wired, matching agent_type): child loop's input.system IS the role identity", async () => {
    const llm = new RoutingLLM([
      { match: "PARENT-GO", events: agentCall("a1", "reviewer", "CHILD-TASK review the diff"), once: true },
      { match: "Subagent completed", events: text("parent done") },
      { match: "CHILD-TASK", events: text("CHILD-ANSWER reviewed as security reviewer") },
    ])
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream: new RecordingStream(),
          registry: new ToolRegistry(defaultTools),
          messages: [{ role: "user", content: [{ type: "text", text: "PARENT-GO" }] }],
          system: PARENT_SYSTEM,
          subagent: { maxDepth: 3 },
          // GATE ON — the named-agent resolver holds the "reviewer" role def.
          namedAgentResolver: makeResolver([REVIEWER_DEF]),
          maxTurns: 5,
        } as never),
      ),
      15_000,
      "role-identity-on",
    )

    expect(out.reason).toBe("completed")
    // The child loop actually forked + streamed.
    expect(llm.log).toContain("CHILD-TASK")
    expect(llm.log).not.toContain("UNMATCHED")

    // GROUND TRUTH: the CHILD model received the ROLE identity as its system,
    // NOT the parent's system.
    const childSys = childSystem(llm, "CHILD-TASK")
    expect(childSys).toBeDefined()
    expect(childSys).toContain("SECURITY REVIEWER")
    expect(childSys).toContain(ROLE_SYSTEM)
    expect(childSys).not.toContain("ordinary root agent")

    // And the PARENT turn saw the parent identity (the specialization is scoped
    // to the child, not a global swap).
    const parentSys = childSystem(llm, "PARENT-GO")
    expect(parentSys).toContain(PARENT_SYSTEM)
    expect(parentSys).not.toContain("SECURITY REVIEWER")
  })

  test("PAIRED CONTROL (resolver OMITTED): SAME spawn ⇒ child inherits the PARENT system (no role identity)", async () => {
    const llm = new RoutingLLM([
      { match: "PARENT-GO", events: agentCall("a1", "reviewer", "CHILD-TASK review the diff"), once: true },
      { match: "Subagent completed", events: text("parent done") },
      { match: "CHILD-TASK", events: text("CHILD-ANSWER but no role identity") },
    ])
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream: new RecordingStream(),
          registry: new ToolRegistry(defaultTools),
          messages: [{ role: "user", content: [{ type: "text", text: "PARENT-GO" }] }],
          system: PARENT_SYSTEM,
          subagent: { maxDepth: 3 },
          // GATE OFF — no resolver ⇒ applyNamedAgent is a no-op.
          maxTurns: 5,
        } as never),
      ),
      15_000,
      "role-identity-off",
    )

    expect(out.reason).toBe("completed")
    expect(llm.log).toContain("CHILD-TASK")

    // Byte-identical default-OFF: the child inherited the PARENT system; the role
    // identity NEVER reached the model.
    const childSys = childSystem(llm, "CHILD-TASK")
    expect(childSys).toBeDefined()
    expect(childSys).toContain(PARENT_SYSTEM)
    expect(childSys).not.toContain("SECURITY REVIEWER")
    expect(childSys).not.toContain(ROLE_SYSTEM)
  })

  test("CONTROL (resolver wired, NON-matching agent_type): resolve() undefined ⇒ parent system inherited", async () => {
    // Isolates MATCHING from mere wiring: the resolver is present but the spawn's
    // agent_type has no definition ⇒ applyNamedAgent returns the request
    // unchanged ⇒ child inherits the parent system.
    const llm = new RoutingLLM([
      { match: "PARENT-GO", events: agentCall("a1", "nonexistent-role", "CHILD-TASK do work"), once: true },
      { match: "Subagent completed", events: text("parent done") },
      { match: "CHILD-TASK", events: text("CHILD-ANSWER generic") },
    ])
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream: new RecordingStream(),
          registry: new ToolRegistry(defaultTools),
          messages: [{ role: "user", content: [{ type: "text", text: "PARENT-GO" }] }],
          system: PARENT_SYSTEM,
          subagent: { maxDepth: 3 },
          namedAgentResolver: makeResolver([REVIEWER_DEF]), // only "reviewer" exists
          maxTurns: 5,
        } as never),
      ),
      15_000,
      "role-identity-nomatch",
    )

    expect(out.reason).toBe("completed")
    expect(llm.log).toContain("CHILD-TASK")
    const childSys = childSystem(llm, "CHILD-TASK")
    expect(childSys).toContain(PARENT_SYSTEM)
    expect(childSys).not.toContain("SECURITY REVIEWER")
  })
})
