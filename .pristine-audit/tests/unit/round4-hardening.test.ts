/**
 * Round 4 hardening — strongest verification techniques applied last:
 *
 *   R4-1  DIFFERENTIAL FUZZ: prove the new DP matcher is semantically equivalent
 *         to the OLD regex matcher it replaced, on a randomized corpus of
 *         non-pathological glob/path pairs. The DP rewrite was motivated by a
 *         ReDoS in the old regex, but semantic equivalence must hold on every
 *         non-attack input. This locks the contract.
 *
 *   R4-2  CROSS-FEATURE: glob rules + hooks updatedInput in the same turn.
 *         Verifies they compose correctly through runAgent (no inter-feature
 *         interference) — a rewrite hook does not affect rule selection; rules
 *         injected this turn do not affect dispatch.
 *
 * No round-4 audit was launched (rate-limited); the techniques above are higher
 * signal than another speculative-edge sweep: differential fuzz catches what an
 * audit might miss (silent semantic drift), and cross-feature integration is
 * the natural composition test that bookends the four-round cycle.
 */
import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { AgentConfig, GlobRule } from "@/agent"
import { HookBus, runAgent } from "@/agent"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import type { PermissionContext } from "@/permission"
import { matchesAnyGlob } from "@/skill"
import type { AgentEvent, StreamPort } from "@/stream"
import type { Tool } from "@/tool"
import { ToolRegistry } from "@/tool"

// --- R4-1: differential fuzz ------------------------------------------------

/** A local reconstruction of the OLD `globToRegExp` semantics — the exact
 *  regex spelling the now-deleted matcher used. This is the oracle the new DP
 *  matcher must agree with on every non-pathological input. Inlined here
 *  rather than imported because the source no longer exists. */
const oldGlobMatch = (path: string, glob: string): boolean => {
  if (glob.length === 0) return false
  const norm = path.replace(/\\/g, "/").replace(/^(\.\/)+/, "")
  const hasSlash = glob.includes("/")
  let re = ""
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? ""
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++
        if (glob[i + 1] === "/") i++
        re += ".*"
      } else {
        re += "[^/]*"
      }
      continue
    }
    if (c === "?") {
      re += "[^/]"
      continue
    }
    // biome-ignore lint/suspicious/noTemplateCurlyInString: regex metachars to escape
    if (".+^${}()|[]\\".includes(c)) {
      re += `\\${c}`
      continue
    }
    re += c
  }
  const anchored = hasSlash ? `^${re}$` : `(^|/)${re}$`
  return new RegExp(anchored).test(norm)
}

/** Deterministic LCG so the corpus is reproducible (no `Math.random`). */
const mkRand = (seed: number) => {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

const genGlob = (r: () => number): string => {
  const len = 1 + Math.floor(r() * 20)
  const out: string[] = []
  let doubleStarCount = 0
  for (let i = 0; i < len; i++) {
    const roll = r()
    if (roll < 0.55) out.push("abcd"[Math.floor(r() * 4)] ?? "a")
    else if (roll < 0.7) out.push("/")
    else if (roll < 0.82) out.push("*")
    else if (roll < 0.92 && doubleStarCount < 2) {
      // bound `**` count to avoid the OLD regex catastrophic backtracking
      // (the DP matcher handles many `**` fine; the oracle is the bottleneck)
      out.push("**/")
      doubleStarCount++
    } else out.push("?")
  }
  return out.join("")
}

const genPath = (r: () => number): string => {
  const len = 1 + Math.floor(r() * 30)
  const out: string[] = []
  for (let i = 0; i < len; i++) {
    const roll = r()
    if (roll < 0.7) out.push("abcd"[Math.floor(r() * 4)] ?? "a")
    else out.push("/")
  }
  // avoid `^/` (absolute) — both old and new strip leading `./` only after the
  // R2 fix; for the fuzz we test relative paths (the absolute-path regression
  // is locked separately in round2-hardening.test.ts).
  return out.join("").replace(/^\/+/, "")
}

describe("R4-1 — differential fuzz: new DP matcher ≡ old regex on a 500-pair corpus", () => {
  test("every (glob, path) decision matches the old regex oracle", () => {
    const r = mkRand(0x9e3779b9) // arbitrary stable seed
    const N = 500
    const disagreements: { glob: string; path: string; oracle: boolean; dp: boolean }[] = []
    for (let i = 0; i < N; i++) {
      const glob = genGlob(r)
      const path = genPath(r)
      let oracle: boolean
      try {
        oracle = oldGlobMatch(path, glob)
      } catch {
        // pathological regex compilation — skip this pair (the DP matcher's
        // job is precisely to be safe where the oracle hangs/throws)
        continue
      }
      const dp = matchesAnyGlob(path, [glob])
      if (oracle !== dp) disagreements.push({ glob, path, oracle, dp })
    }
    if (disagreements.length > 0) {
    }
    expect(disagreements).toEqual([])
  })

  test("oracle and DP agree on the canonical regression cases (sanity pin)", () => {
    const cases: { glob: string; path: string }[] = [
      { glob: "*.ts", path: "a.ts" },
      { glob: "*.ts", path: "x/a.ts" },
      { glob: "*.ts", path: "a.tsx" },
      { glob: "src/**", path: "src/a/b.ts" },
      { glob: "**/*.tf", path: "infra/main.tf" },
      { glob: "src/**/*.ts", path: "src/a/b.ts" },
      { glob: "a?b", path: "axb" },
      { glob: "a?b", path: "a/b" },
      { glob: "a.b", path: "axb" }, // literal `.`, must not be regex
      { glob: "src/", path: "src/foo" }, // trailing-slash semantics pinned to OLD behavior
    ]
    for (const { glob, path } of cases) {
      expect(matchesAnyGlob(path, [glob])).toBe(oldGlobMatch(path, glob))
    }
  })
})

// --- R4-2: cross-feature integration ----------------------------------------

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
const reminderText = (input: StreamInput | undefined): string =>
  (input?.messages ?? [])
    .filter((m) => m.role === "user")
    .flatMap((m) => m.content.map((b) => (b.type === "text" ? b.text : "")))
    .join("\n")

describe("R4-2 — cross-feature: glob rules + hooks updatedInput compose cleanly", () => {
  test("a turn with a matching glob rule AND an active rewrite hook applies BOTH", async () => {
    const sink = { received: [] as unknown[] }
    const echoTool: Tool = {
      name: "echo",
      description: "echo",
      inputSchema: z.object({ path: z.string() }) as z.ZodType<unknown>,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      execute: (input: unknown) =>
        (async function* () {
          sink.received.push(input)
          yield {
            type: "result" as const,
            result: { ok: true, output: `ran:${(input as { path: string }).path}` },
          }
        })(),
    }
    const hooks = new HookBus()
    hooks.on("pre_tool_use", () => ({ updatedInput: { path: "rewritten" } }))
    const tsRule: GlobRule = {
      sourcePath: "/r/ts.mdc",
      globs: ["*.ts"],
      alwaysApply: false,
      body: "GLOB-RULE-XF-BODY",
    }
    const llm = new RecordingLLM([
      toolUseScript("t1", "echo", { path: "orig" }),
      textScript("done"),
    ])
    const out = await runAgent({
      registry: new ToolRegistry([echoTool]),
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
      globRules: { rules: [tsRule], changedPaths: ["src/a.ts"] },
    } as AgentConfig)
    // glob rule landed in the FIRST request
    expect(reminderText(llm.inputs[0])).toContain("GLOB-RULE-XF-BODY")
    // hook rewrite reached the tool
    expect(sink.received).toEqual([{ path: "rewritten" }])
    // transcript reflects rewrite
    expect(JSON.stringify(out.messages)).toContain("ran:rewritten")
  })

  test("a denying hook on a turn that ALSO has a matching glob rule still blocks (deny wins, rule still injected)", async () => {
    const sink = { received: [] as unknown[] }
    const echoTool: Tool = {
      name: "echo",
      description: "echo",
      inputSchema: z.object({}).passthrough() as z.ZodType<unknown>,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      execute: () =>
        (async function* () {
          sink.received.push("ran")
          yield { type: "result" as const, result: { ok: true, output: "ran" } }
        })(),
    }
    const hooks = new HookBus()
    hooks.on("pre_tool_use", () => ({ deny: "cross-feature deny" }))
    const llm = new RecordingLLM([toolUseScript("t1", "echo", {}), textScript("done")])
    const out = await runAgent({
      registry: new ToolRegistry([echoTool]),
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
      globRules: {
        rules: [
          {
            sourcePath: "/r/always.mdc",
            globs: [],
            alwaysApply: true,
            body: "ALWAYS-XF-BODY",
          },
        ],
        changedPaths: [],
      },
    } as AgentConfig)
    // rule landed (independent of hook outcome)
    expect(reminderText(llm.inputs[0])).toContain("ALWAYS-XF-BODY")
    // tool did NOT run (deny wins)
    expect(sink.received).toEqual([])
    // transcript carries the deny
    expect(JSON.stringify(out.messages)).toContain("Hook denied: cross-feature deny")
  })
})
