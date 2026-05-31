/**
 * Hellgate: B1 — opt-in tool namespacing for spawned subagents.
 *
 * Proves:
 *   - DEFAULT (no strategy) ⇒ child registry exposes RAW tool names,
 *     byte-identical to pre-B1 behavior.
 *   - ON (strategy injected) ⇒ child registry exposes SCOPED names AND
 *     `registry.get(scopedName)` resolves back to the SAME real tool (round
 *     trip through dispatch is `registry.get(call.name)`).
 *   - Two concurrent sibling children get DISTINCT scoped names for the same
 *     raw tool ⇒ collision avoided.
 *   - The injected strategy is the only source of the scoped name (closed
 *     port): a custom strategy is honored verbatim.
 */
import { describe, expect, it } from "bun:test"
import { z } from "zod"
import {
  createSubagentRunner,
  prefixToolNamespace,
  type SubagentRunnerOptions,
  type ToolNamespaceStrategy,
} from "@/agent/subagent-runner"
import type { AgentConfig, AgentOutcome } from "@/agent/types"
import type { SubagentRequest } from "@/subagent/types"
import { ToolRegistry } from "@/tool"
import type { Tool, ToolEvent } from "@/tool"

/** A real Tool-shaped stub (inputSchema + execute), matching the runtime
 *  contract so `registry.specs()` (which serializes the zod schema) works. */
const fakeTool = (name: string): Tool => ({
  name,
  description: `desc:${name}`,
  inputSchema: z.object({}),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute(): AsyncIterable<ToolEvent> {
    yield { type: "result", result: { ok: true, output: `ran:${name}` } }
  },
})

const stubConfig = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    // biome-ignore lint/suspicious/noExplicitAny: inert port stub; loop never runs
    llm: {} as any,
    registry: new ToolRegistry([fakeTool("exec_command"), fakeTool("write")]),
    // biome-ignore lint/suspicious/noExplicitAny: inert port stub
    stream: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: inert port stub
    permission: {} as any,
    messages: [],
    system: "sys",
    cwd: "/tmp",
    signal: new AbortController().signal,
    maxTurns: 4,
    ...over,
  }) as AgentConfig

const stubReq = (over: Partial<SubagentRequest> = {}): SubagentRequest => ({
  prompt: "do it",
  depth: 0,
  ...over,
})

const stubOutcome = (): AgentOutcome => ({ reason: "completed", messages: [], turns: 1 })

/** Capture the child AgentConfig the runner hands to `runAgent`. */
const capture = (opts: Partial<SubagentRunnerOptions> = {}) => {
  const configs: AgentConfig[] = []
  const run: NonNullable<SubagentRunnerOptions["run"]> = async (cfg) => {
    configs.push(cfg)
    return stubOutcome()
  }
  return { configs, opts: { run, ...opts } as SubagentRunnerOptions }
}

describe("B1 tool namespace — default OFF (raw names)", () => {
  it("child registry exposes raw tool names byte-identical to parent filter", async () => {
    const { configs, opts } = capture()
    const runner = createSubagentRunner(stubConfig(), opts)
    await runner(stubReq())
    const names = configs[0]?.registry
      .specs()
      .map((s) => s.name)
      .sort()
    expect(names).toEqual(["exec_command", "write"])
  })
})

describe("B1 tool namespace — ON (scoped + round-trip)", () => {
  it("child registry exposes scoped names that resolve back to the real tool", async () => {
    const { configs, opts } = capture({ toolNamespace: prefixToolNamespace })
    const runner = createSubagentRunner(stubConfig(), opts)
    await runner(stubReq())
    const reg = configs[0]?.registry
    const names = reg
      ?.specs()
      .map((s) => s.name)
      .sort()
    // root session ⇒ first child mailbox label is `root/0` ⇒ sanitized `root_0`
    expect(names).toEqual(["root_0__exec_command", "root_0__write"])
    // round-trip: dispatch resolves the scoped name back to the real tool
    // (dispatch does `registry.get(call.name)` — the scoped name the model
    // emits resolves directly to the underlying tool, body intact).
    const resolved = reg?.get("root_0__exec_command")
    expect(resolved).toBeDefined()
    // execute body is the ORIGINAL tool's (output carries the raw name)
    expect(resolved?.description).toBe("desc:exec_command")
    let out = ""
    for await (const ev of resolved?.execute({}, {} as never) ?? []) {
      if (ev.type === "result") out = ev.result.output ?? ""
    }
    expect(out).toBe("ran:exec_command")
  })

  it("two concurrent sibling children get DISTINCT scoped names (no collision)", async () => {
    const { configs, opts } = capture({ toolNamespace: prefixToolNamespace })
    const runner = createSubagentRunner(stubConfig(), opts)
    // siblings spawned from the same runner mint root/0, root/1, …
    await Promise.all([runner(stubReq()), runner(stubReq())])
    const s0 = new Set(configs[0]?.registry.specs().map((x) => x.name))
    const s1 = new Set(configs[1]?.registry.specs().map((x) => x.name))
    // disjoint surfaces ⇒ a shared consumer cannot collide them
    for (const n of s0) expect(s1.has(n)).toBe(false)
    expect(s0.has("root_0__exec_command")).toBe(true)
    expect(s1.has("root_1__exec_command")).toBe(true)
  })

  it("honors a custom injected strategy verbatim (closed port)", async () => {
    const custom: ToolNamespaceStrategy = {
      scope: (token, raw) => `NS_${token}_${raw}`,
    }
    const { configs, opts } = capture({ toolNamespace: custom })
    const runner = createSubagentRunner(stubConfig(), opts)
    await runner(stubReq())
    const names = configs[0]?.registry
      .specs()
      .map((s) => s.name)
      .sort()
    // token `root/0` is passed verbatim to the strategy (the strategy owns
    // any sanitization). Custom strategy here keeps the slash.
    expect(names).toEqual(["NS_root/0_exec_command", "NS_root/0_write"])
  })
})
