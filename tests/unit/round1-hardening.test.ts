/**
 * Round 1 hardening — pins the four findings the self-audit surfaced:
 *
 *   R1-1  matchFull is O(T·L) memory + recursion-depth — enforce MAX_GLOB_LEN /
 *         MAX_PATH_LEN so a malicious oversized glob/path is a no-match, not a
 *         memory/stack DoS.
 *   R1-2  renderGlobRulesBlock must cap TOTAL bytes at MAX_RENDER_BYTES so N
 *         alwaysApply rules cannot blow the prompt budget; truncation MUST be
 *         visible (marker), not silent.
 *   R1-3  Rewrite applies on every admit path, not just the default mode-policy
 *         one. This pin uses the rules-DSL `allow` branch as the alternate path.
 *   R1-4  A hook rewrite can change the tool INPUT only — never the tool NAME.
 *
 * These are NOT happy-path tests; each one is a deliberate stress against a
 * surface the audit flagged as previously unpinned.
 */
import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { AgentConfig, GlobRule } from "@/agent"
import { HookBus, MAX_RENDER_BYTES, renderGlobRulesBlock, runAgent } from "@/agent"
import { runAdmissibilityGate } from "@/agent/admissibility-gate"
import type { LLMPort, Message, StreamEvent, StreamInput, ToolUseBlock } from "@/llm"
import type { PermissionContext } from "@/permission"
import { MAX_GLOB_LEN, MAX_PATH_LEN, matchesAnyGlob } from "@/skill"
import type { AgentEvent, StreamPort } from "@/stream"
import type { Tool } from "@/tool"
import { ToolRegistry } from "@/tool"

// --- R1-1: matcher input bounds ---------------------------------------------

describe("R1-1 — matchesAnyGlob enforces hard caps on glob/path length", () => {
  test("a glob longer than MAX_GLOB_LEN is a no-match (not a DoS)", () => {
    const huge = "a".repeat(MAX_GLOB_LEN + 1)
    const started = Date.now()
    expect(matchesAnyGlob("a.ts", [huge])).toBe(false)
    expect(Date.now() - started).toBeLessThan(500)
  })

  test("a path longer than MAX_PATH_LEN is a no-match against every pattern", () => {
    const huge = `${"x/".repeat(MAX_PATH_LEN)}a.ts`
    const started = Date.now()
    expect(matchesAnyGlob(huge, ["*.ts", "**", "src/**"])).toBe(false)
    expect(Date.now() - started).toBeLessThan(500)
  })

  test("an empty / whitespace-only glob is a no-match (no accidental match-all)", () => {
    expect(matchesAnyGlob("a.ts", [""])).toBe(false)
    expect(matchesAnyGlob("a.ts", ["   "])).toBe(false)
    // a legit pattern in the same array still matches
    expect(matchesAnyGlob("a.ts", ["", "*.ts"])).toBe(true)
  })

  test("over-cap glob does NOT short-circuit other legitimate patterns in the same call", () => {
    const huge = "a".repeat(MAX_GLOB_LEN + 1)
    // huge is skipped; *.ts still matches
    expect(matchesAnyGlob("a.ts", [huge, "*.ts"])).toBe(true)
  })
})

// --- R1-2: render byte cap --------------------------------------------------

describe("R1-2 — renderGlobRulesBlock caps total bytes at MAX_RENDER_BYTES", () => {
  /** Build N rules, each with a ~2KB body, all alwaysApply. */
  const fatRules = (n: number, bodyBytes: number): GlobRule[] =>
    Array.from({ length: n }, (_, i) => ({
      sourcePath: `/r/${i}.mdc`,
      globs: [],
      alwaysApply: true,
      body: `R${i}:${"x".repeat(bodyBytes)}`,
    }))

  test("rendering stays within MAX_RENDER_BYTES even when total bodies exceed the cap", () => {
    // 100 rules × ~2KB = 200KB raw, well over the 64KB cap
    const block = renderGlobRulesBlock(fatRules(100, 2048))
    expect(block).toBeDefined()
    // generous slack for the header/truncation marker, but firmly bounded
    expect((block ?? "").length).toBeLessThan(MAX_RENDER_BYTES + 4096)
  })

  test("truncation is VISIBLE (marker present + count > 0), never silent", () => {
    const block = renderGlobRulesBlock(fatRules(100, 2048))
    expect(block).toContain("[truncated:")
    const m = (block ?? "").match(/\[truncated: (\d+) more rule\(s\)/)
    expect(m).not.toBeNull()
    expect(Number(m?.[1] ?? 0)).toBeGreaterThan(0)
  })

  test("a small set well under the cap renders WITHOUT a truncation marker", () => {
    const block = renderGlobRulesBlock(fatRules(2, 256))
    expect(block).not.toContain("[truncated:")
  })

  test("the cap applies even when bodies are individually within per-rule MAX_RULE_BYTES", () => {
    // each body is small (< MAX_RULE_BYTES) but cumulative bursts the cap
    const block = renderGlobRulesBlock(fatRules(50, 4096))
    expect(block).toContain("[truncated:")
  })
})

// --- R1-3: rewrite applies on an alternate admit path (rules DSL allow) -----

describe("R1-3 — pre_tool_use updatedInput applies on the rules-DSL `allow` admit path", () => {
  test("a rules-DSL `allow` match routes through runPreToolUseHook AND surfaces the rewrite via opts.onInputMutation", async () => {
    const echoTool: Tool = {
      name: "echo",
      description: "echo",
      inputSchema: z.object({ path: z.string() }) as z.ZodType<unknown>,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      execute: () =>
        (async function* () {
          yield { type: "result" as const, result: { ok: true, output: "ran" } }
        })(),
    }
    const hooks = new HookBus()
    hooks.on("pre_tool_use", () => ({ updatedInput: { path: "rewritten" } }))
    // Minimal RulesStore fake — the gate only consults `.match` here.
    const rulesStore = {
      match: () => ({
        kind: "matched" as const,
        rule: { action: "allow", prefix: "echo", layer: "project" as const },
      }),
    } as unknown as NonNullable<
      NonNullable<Parameters<typeof runAdmissibilityGate>[5]>["rulesStore"]
    >
    const config = {
      registry: new ToolRegistry([echoTool]),
      cwd: "/repo",
      signal: new AbortController().signal,
      planMode: false,
      hooks,
    } as unknown as Parameters<typeof runAdmissibilityGate>[1]
    const call: ToolUseBlock = { type: "tool_use", id: "c1", name: "echo", input: { path: "orig" } }
    let captured: unknown
    const result = await runAdmissibilityGate(
      call,
      config,
      { mode: "default" } as PermissionContext,
      { tool: "echo", input: { path: "orig" }, isReadOnly: true },
      undefined,
      {
        rulesStore,
        onInputMutation: (next) => {
          captured = next
        },
      },
    )
    // gate admitted (null), and the rule-allow branch fired the hook which captured the rewrite
    expect(result).toBeNull()
    expect(captured).toEqual({ path: "rewritten" })
  })
})

// --- R1-4: rewrite cannot change the tool name + name pin -------------------

class RecordingLLM implements LLMPort {
  readonly inputs: StreamInput[] = []
  private readonly scripts: StreamEvent[][]
  constructor(scripts: StreamEvent[][]) {
    this.scripts = scripts
  }
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.inputs.push(input)
    const next = this.scripts.shift() ?? []
    for (const ev of next) yield ev
  }
}
class RecordingStream implements StreamPort {
  emit(_e: AgentEvent): void {}
}
const textScript = (text: string): StreamEvent[] => [
  { type: "text_delta", delta: text },
  { type: "message_stop", stop_reason: "end_turn" },
]
const toolUseScript = (id: string, name: string, input: unknown): StreamEvent[] => [
  { type: "tool_use_start", id, name },
  { type: "tool_use_end", id, input },
  { type: "message_stop", stop_reason: "tool_use" },
]

describe("R1-4 — a hook rewrite can change the INPUT, never the tool NAME", () => {
  test("a hook returning { updatedInput: { __name: 'evil', ... } } is treated as data, not a redirect", async () => {
    const echoSink = { received: [] as unknown[] }
    const evilSink = { received: [] as unknown[] }
    const echoTool: Tool = {
      name: "echo",
      description: "echo",
      inputSchema: z.object({}).passthrough() as z.ZodType<unknown>,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      execute: (input: unknown) =>
        (async function* () {
          echoSink.received.push(input)
          yield { type: "result" as const, result: { ok: true, output: "echo-ran" } }
        })(),
    }
    const evilTool: Tool = {
      name: "evil",
      description: "evil",
      inputSchema: z.object({}).passthrough() as z.ZodType<unknown>,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      execute: () =>
        (async function* () {
          evilSink.received.push("RAN")
          yield { type: "result" as const, result: { ok: true, output: "evil-ran" } }
        })(),
    }
    const hooks = new HookBus()
    // a malicious rewrite tries to "redirect" via fields that LOOK like name
    hooks.on("pre_tool_use", () => ({
      updatedInput: { __name: "evil", name: "evil", tool: "evil", x: 1 },
    }))
    const llm = new RecordingLLM([toolUseScript("t1", "echo", {}), textScript("done")])
    const out = await runAgent({
      registry: new ToolRegistry([echoTool, evilTool]),
      stream: new RecordingStream(),
      permission: { mode: "acceptEdits" } as PermissionContext,
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] as Message[],
      system: "t",
      cwd: "/tmp",
      maxTurns: 3,
      signal: new AbortController().signal,
      onConfirm: async () => false,
      llm,
      hooks,
    } as AgentConfig)
    expect(out.reason).toBe("completed")
    // the rewrite affected INPUT only — `echo` is what ran, never `evil`
    expect(echoSink.received).toEqual([{ __name: "evil", name: "evil", tool: "evil", x: 1 }])
    expect(evilSink.received).toEqual([])
  })
})
