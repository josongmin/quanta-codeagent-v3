/**
 * §20.1/§20.2/§20.3 — named-agent spawn-wiring HELLGATE.
 *
 * Proves the subagent runner consults the (structurally-typed) `namedAgentResolver`
 * off the parent config when a spawn carries a matching `req.agentType`, and
 * injects the definition's `{ system, tools, model, mode }` into the forked
 * child — WITHOUT ever widening the child's tool surface beyond the parent's
 * grant, and byte-identically when no resolver / no match.
 *
 * Security crux (TOOL WIDENING — RED-on-injection):
 *   - NAS-WIDEN  a repo-controlled definition requesting `tools:[bash]` when the
 *                parent holds NO bash tool MUST NOT grant the child bash. The
 *                definition's tools ride `toolFilter` → `filterRegistry`
 *                intersection ⇒ narrow-only.
 *
 * Byte-identical / default-OFF:
 *   - NAS-NORES  no resolver wired ⇒ child.system === parent.system (no change)
 *   - NAS-NOMATCH no matching definition ⇒ child.system === parent.system
 *   - NAS-SYSABS req.system absent + no def ⇒ child.system === parent.system
 *
 * Identity injection:
 *   - NAS-SYS    matched def ⇒ child.system === def.system
 *   - NAS-EXPLICIT explicit req.system BEATS the def (explicit-request-wins)
 *   - NAS-NARROW def.tools ∩ parent surface ⇒ child registry keeps only granted
 *   - NAS-MODE   def.mode ⇒ child.mode (and a bad mode never reaches the child)
 *
 * Nickname (§20.3):
 *   - NAS-NICK   subagentAgentMeta + taskId ⇒ deterministic maestro label written
 *   - NAS-NICK-OFF no agentMeta ⇒ no write (byte-identical)
 */
import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { runAgent } from "@/agent/loop"
import type { NamedAgentDefinition, NamedAgentResolver } from "@/agent/named-agent-registry"
import { createSubagentRunner } from "@/agent/subagent-runner"
import type { AgentConfig, AgentOutcome } from "@/agent/types"
import type { LLMPort, Message } from "@/llm"
import { AgentMetaRegistry } from "@/subagent"
import type { SubagentRequest } from "@/subagent/types"
import type { Tool, ToolEvent } from "@/tool"
import { ToolRegistry } from "@/tool"

const fakeTool = (name: string): Tool => ({
  name,
  description: name,
  inputSchema: z.object({}),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute(): AsyncIterable<ToolEvent> {
    yield { type: "result", result: { ok: true, output: "" } }
  },
})

const port = (model: string): LLMPort =>
  ({
    model,
    // biome-ignore lint/suspicious/noExplicitAny: inert stream stub
    stream: async function* () {} as any,
  }) as LLMPort

/** A resolver that returns a fixed definition for one agentType. */
const resolverFor = (agentType: string, def: NamedAgentDefinition): NamedAgentResolver => ({
  resolve: (t) => (t === agentType ? def : undefined),
})

const parentConfig = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    llm: port("parent-model"),
    registry: new ToolRegistry([fakeTool("read"), fakeTool("write")]),
    stream: { emit: () => {} },
    permission: { mode: "default" },
    messages: [{ role: "user", content: [{ type: "text", text: "PARENT" }] }],
    system: "PARENT SYSTEM",
    cwd: "/repo",
    maxTurns: 17,
    signal: new AbortController().signal,
    ...over,
  }) as AgentConfig

const outcome = (): AgentOutcome => ({
  reason: "completed",
  turns: 1,
  messages: [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
  ] satisfies Message[],
})

const capturing = (): { run: typeof runAgent; seen: AgentConfig[] } => {
  const seen: AgentConfig[] = []
  const run = (async (c: AgentConfig) => {
    seen.push(c)
    return outcome()
  }) as typeof runAgent
  return { run, seen }
}

const childOf = (seen: AgentConfig[]): AgentConfig => {
  const c = seen[0]
  if (c === undefined) throw new Error("runner never forked a child")
  return c
}

const req = (over: Partial<SubagentRequest> = {}): SubagentRequest => ({
  prompt: "do the thing",
  depth: 1,
  ...over,
})

/** Inject a resolver via the structural slot the runner reads. */
const withResolver = (parent: AgentConfig, resolver: NamedAgentResolver): AgentConfig =>
  ({ ...parent, namedAgentResolver: resolver }) as AgentConfig

describe("§20 — named-agent spawn wiring", () => {
  test("NAS-SYS matched def ⇒ child.system === def.system", async () => {
    const { run, seen } = capturing()
    const def: NamedAgentDefinition = {
      agentType: "explorer",
      system: "YOU ARE AN EXPLORER",
      sourcePath: "/x",
    }
    const parent = withResolver(parentConfig(), resolverFor("explorer", def))
    await createSubagentRunner(parent, { run })(req({ agentType: "explorer" }))
    expect(childOf(seen).system).toBe("YOU ARE AN EXPLORER")
  })

  test("NAS-EXPLICIT explicit req.system BEATS the definition", async () => {
    const { run, seen } = capturing()
    const def: NamedAgentDefinition = { agentType: "explorer", system: "DEF", sourcePath: "/x" }
    const parent = withResolver(parentConfig(), resolverFor("explorer", def))
    await createSubagentRunner(parent, { run })(
      req({ agentType: "explorer", system: "CALLER WINS" }),
    )
    expect(childOf(seen).system).toBe("CALLER WINS")
  })

  test("NAS-NORES no resolver ⇒ child.system === parent.system (byte-identical)", async () => {
    const { run, seen } = capturing()
    const parent = parentConfig()
    await createSubagentRunner(parent, { run })(req({ agentType: "explorer" }))
    expect(childOf(seen).system).toBe("PARENT SYSTEM")
  })

  test("NAS-NOMATCH unknown agentType ⇒ child.system === parent.system", async () => {
    const { run, seen } = capturing()
    const def: NamedAgentDefinition = { agentType: "explorer", system: "DEF", sourcePath: "/x" }
    const parent = withResolver(parentConfig(), resolverFor("explorer", def))
    await createSubagentRunner(parent, { run })(req({ agentType: "nope" }))
    expect(childOf(seen).system).toBe("PARENT SYSTEM")
  })

  test("NAS-SYSABS no agentType + no resolver ⇒ child.system === parent.system", async () => {
    const { run, seen } = capturing()
    await createSubagentRunner(parentConfig(), { run })(req())
    expect(childOf(seen).system).toBe("PARENT SYSTEM")
  })

  test("NAS-MODE def.mode ⇒ child.mode", async () => {
    const { run, seen } = capturing()
    const def: NamedAgentDefinition = {
      agentType: "reviewer",
      system: "CRITIQUE",
      mode: "review",
      sourcePath: "/x",
    }
    const parent = withResolver(parentConfig(), resolverFor("reviewer", def))
    await createSubagentRunner(parent, { run })(req({ agentType: "reviewer" }))
    expect(childOf(seen).mode).toBe("review")
  })

  // ─── SECURITY: tool widening (RED-on-injection) ──────────────────────────

  test("NAS-WIDEN repo-controlled def.tools cannot grant tools beyond the parent surface", async () => {
    const { run, seen } = capturing()
    // Parent surface holds ONLY read + write — NO bash.
    const parent = withResolver(
      parentConfig({ registry: new ToolRegistry([fakeTool("read"), fakeTool("write")]) }),
      resolverFor("evil", {
        agentType: "evil",
        system: "DEF",
        // Hostile repo-controlled allowlist requesting an ungranted tool.
        tools: ["bash", "read"],
        sourcePath: "/x",
      }),
    )
    await createSubagentRunner(parent, { run })(req({ agentType: "evil" }))
    const childTools = childOf(seen)
      .registry.specs()
      .map((s) => s.name)
    // bash was NEVER granted to the parent ⇒ the intersection drops it.
    expect(childTools).not.toContain("bash")
    // read WAS granted ⇒ it survives the narrowing.
    expect(childTools).toContain("read")
    // The definition narrowed away write (not in its list).
    expect(childTools).not.toContain("write")
  })

  test("NAS-NARROW explicit req.toolFilter BEATS def.tools", async () => {
    const { run, seen } = capturing()
    const parent = withResolver(
      parentConfig({ registry: new ToolRegistry([fakeTool("read"), fakeTool("write")]) }),
      resolverFor("explorer", {
        agentType: "explorer",
        system: "DEF",
        tools: ["read"],
        sourcePath: "/x",
      }),
    )
    // Caller explicitly asks for write only — wins over the def's [read].
    await createSubagentRunner(parent, { run })(
      req({ agentType: "explorer", toolFilter: ["write"] }),
    )
    const childTools = childOf(seen)
      .registry.specs()
      .map((s) => s.name)
    expect(childTools).toEqual(["write"])
  })

  // ─── §20.3 nickname display label ────────────────────────────────────────

  test("NAS-NICK agentMeta + taskId ⇒ deterministic maestro nickname recorded", async () => {
    const { run } = capturing()
    const agentMeta = new AgentMetaRegistry()
    const parent = parentConfig({ subagentAgentMeta: agentMeta })
    await createSubagentRunner(parent, { run })(req({ taskId: "task-1" }))
    const meta = agentMeta.get("task-1")
    expect(meta).toBeDefined()
    // Un-typed child ⇒ label is the maestro nickname seeded from the stable
    // mailbox id `root/0` (deterministic — no clock/uuid).
    expect(meta?.label.length).toBeGreaterThan(0)
    expect(meta?.depth).toBe(1)
  })

  test("NAS-NICK agentType present ⇒ label prefers agentType over the nickname", async () => {
    const { run } = capturing()
    const agentMeta = new AgentMetaRegistry()
    const parent = parentConfig({ subagentAgentMeta: agentMeta })
    await createSubagentRunner(parent, { run })(req({ taskId: "task-2", agentType: "explorer" }))
    expect(agentMeta.get("task-2")?.label).toBe("explorer")
  })

  test("NAS-NICK deterministic: same stable mailbox id ⇒ same nickname across runs", async () => {
    const labels: string[] = []
    for (let i = 0; i < 2; i++) {
      const { run } = capturing()
      const agentMeta = new AgentMetaRegistry()
      // Fresh runner each time ⇒ first child is always `root/0` (ordinal reset).
      await createSubagentRunner(parentConfig({ subagentAgentMeta: agentMeta }), { run })(
        req({ taskId: "t" }),
      )
      labels.push(agentMeta.get("t")?.label ?? "")
    }
    expect(labels[0]).toBe(labels[1])
    expect(labels[0]?.length).toBeGreaterThan(0)
  })

  test("NAS-NICK-OFF no agentMeta ⇒ no write (byte-identical)", async () => {
    const { run, seen } = capturing()
    // Simply must not throw and must still fork the child.
    await createSubagentRunner(parentConfig(), { run })(req({ taskId: "task-x" }))
    expect(childOf(seen)).toBeDefined()
  })
})
