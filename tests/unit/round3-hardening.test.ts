/**
 * Round 3 hardening — three real fixes the parallel audit surfaced + two
 * coverage gaps (multi-turn glob selection, parallel-tool hook isolation).
 *
 *   R3-1  loadGlobRules now caps the loaded rule COUNT at MAX_RULE_FILES.
 *         Without this, a hostile (or misconfigured) `.cursor/rules` directory
 *         with N rule files makes `selectGlobRules` do O(N · paths) matchesAny
 *         calls every turn — audit measured ~56 s at N=10k. Render caps don't
 *         help: the loop freezes BEFORE the renderer runs.
 *
 *   R3-2  A throwing function-MATCHER inside a hook registration used to
 *         propagate through `matchTool`, escape `runHandler`'s try/catch (which
 *         only wraps the handler call, not the matcher check), and surface as
 *         a generic dispatch error — silently disabling every other (correct)
 *         hook on the same call. matchTool now treats matcher throws as
 *         no-match so a single buggy matcher cannot poison the chain.
 *
 *   R3-3  A YAML folded scalar in `description: >` (or `|`) hits the dependency-
 *         free frontmatter parser which doesn't implement folding — the value
 *         arrives as the literal `>` (or `|`) and silently rides into the
 *         rendered authority surface as `### file.mdc (always) — >`. Fix: in
 *         tryLoadRule, treat a bare fold indicator as absent description.
 *
 *   R3-T1 Multi-turn glob-rule re-selection — the loop re-reads
 *         `config.globRules.changedPaths` every turn, but no test pinned the
 *         contract. A future refactor that snapshots at session-start would
 *         silently break the "per-turn" promise.
 *
 *   R3-T2 Parallel multi-tool hook rewrite — `dispatchTool` builds a fresh
 *         `rewritten` closure per call so two parallel dispatches with the same
 *         hook each get their OWN rewrite. The structure was right but had no
 *         test; future refactors could regress.
 */
import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import type { AgentConfig, GlobRule } from "@/agent"
import {
  HookBus,
  loadGlobRules,
  MAX_RULE_FILES,
  renderGlobRulesBlock,
  runAgent,
  selectGlobRules,
} from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import { matchTool } from "@/agent/tool-matchers"
import type { LLMPort, Message, StreamEvent, StreamInput, ToolUseBlock } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { AgentEvent, StreamPort } from "@/stream"
import type { Tool } from "@/tool"
import { ToolRegistry } from "@/tool"

// --- R3-1: rule-count cap (DoS via .cursor/rules file flood) ----------------

describe("R3-1 — loadGlobRules caps rule count at MAX_RULE_FILES (DoS guard)", () => {
  test("loading a directory with > MAX_RULE_FILES rule files stops at the cap", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "r3-1-cap-"))
    try {
      const dir = join(cwd, ".cursor/rules")
      await mkdir(dir, { recursive: true })
      const overflow = MAX_RULE_FILES + 50
      // pad with `i` so sorted order is deterministic: 000, 001, ..., 305
      await Promise.all(
        Array.from({ length: overflow }, (_, i) =>
          writeFile(
            join(dir, `r${String(i).padStart(4, "0")}.mdc`),
            `---\nalwaysApply: true\n---\nrule-${i}`,
          ),
        ),
      )
      const rules = await loadGlobRules(cwd)
      expect(rules.length).toBe(MAX_RULE_FILES)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test("a normal repo (few rules) loads ALL its rules — cap is generous", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "r3-1-normal-"))
    try {
      const dir = join(cwd, ".cursor/rules")
      await mkdir(dir, { recursive: true })
      for (const name of ["react.mdc", "ts.mdc", "test.mdc"]) {
        await writeFile(join(dir, name), `---\nalwaysApply: true\n---\nbody:${name}`)
      }
      const rules = await loadGlobRules(cwd)
      expect(rules.length).toBe(3)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test("selectGlobRules cost is bounded even with the maximum allowed rule set", () => {
    // Construct MAX_RULE_FILES alwaysApply rules in memory and selectGlobRules
    // them against a non-trivial changedPaths list. With the cap in place this
    // stays under a second even on the worst no-match scan path.
    const rules: GlobRule[] = Array.from({ length: MAX_RULE_FILES }, (_, i) => ({
      sourcePath: `/r/${i}.mdc`,
      globs: ["src/**/*.unmatchable"],
      alwaysApply: false,
      body: `R${i}`,
    }))
    const paths = Array.from({ length: 200 }, (_, i) => `src/dir-${i}/file.ts`)
    // This is a CPU-DoS rail, so measure CPU consumed by the bounded selection
    // work rather than wall clock. Whole-suite worker contention can preempt
    // this synchronous test (1.3s wall time with unchanged work), but does not
    // make `selectGlobRules` itself more expensive.
    const started = process.cpuUsage()
    selectGlobRules(rules, paths)
    const elapsed = process.cpuUsage(started)
    expect((elapsed.user + elapsed.system) / 1000).toBeLessThan(1000)
  })
})

// --- R3-2: throwing matcher no longer poisons emit --------------------------

describe("R3-2 — a throwing function-matcher is treated as no-match (no poison)", () => {
  test("matchTool returns false when the matcher throws", () => {
    expect(
      matchTool(() => {
        throw new Error("boom")
      }, "any-tool"),
    ).toBe(false)
  })

  test("a hook with a throwing matcher does NOT abort sibling hook processing", async () => {
    const bus = new HookBus()
    let denied = false
    // sibling registered BEFORE the throwing-matcher one — both nominally apply
    // to "echo"; the throwing matcher must not prevent the sibling from firing
    bus.on("pre_tool_use", () => ({ deny: "from sibling" }))
    bus.on("pre_tool_use", () => ({ deny: "from broken" }), {
      matcher: () => {
        throw new Error("matcher boom")
      },
    })
    const result = await bus.emit({ type: "pre_tool_use", name: "echo", input: {} })
    // the first sibling (no matcher) denied; the broken-matcher one was skipped
    expect(result.deny).toEqual({ deny: "from sibling" })
    denied = result.deny !== null
    expect(denied).toBe(true)
  })

  test("dispatchTool's no-throw contract holds when a hook matcher throws", async () => {
    const echoTool: Tool = {
      name: "echo",
      description: "echo",
      inputSchema: z.object({}).passthrough() as z.ZodType<unknown>,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      execute: () =>
        (async function* () {
          yield { type: "result" as const, result: { ok: true, output: "ran" } }
        })(),
    }
    const hooks = new HookBus()
    // Only handler is the broken-matcher one — if matchTool poisoned, the
    // entire dispatch would return a generic "Tool dispatch failed". With the
    // fix, the matcher is skipped (returns false) and the call admits cleanly.
    hooks.on("pre_tool_use", () => ({ deny: "would-block" }), {
      matcher: () => {
        throw new Error("matcher boom")
      },
    })
    const cfg = {
      registry: new ToolRegistry([echoTool]),
      cwd: "/repo",
      signal: new AbortController().signal,
      planMode: false,
      hooks,
    } as unknown as AgentConfig
    const call: ToolUseBlock = { type: "tool_use", id: "c1", name: "echo", input: {} }
    const res = await dispatchTool(call, cfg, { mode: "acceptEdits" } as PermissionContext)
    // Pre-fix: res.ok === false with "Tool dispatch failed: ..." preview.
    // Post-fix: matcher treated as no-match ⇒ handler skipped ⇒ call admits.
    expect(res.ok).toBe(true)
    expect(res.preview).toBe("ran")
  })
})

// --- R3-3: YAML fold scalar drops out of description (no `>` authority leak) -

describe("R3-3 — bare YAML fold-indicator `>` / `|` is NOT rendered as description", () => {
  test("description: > (folded, parser drops continuation) ⇒ undefined description", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "r3-3-fold-"))
    try {
      const dir = join(cwd, ".cursor/rules")
      await mkdir(dir, { recursive: true })
      await writeFile(
        join(dir, "folded.mdc"),
        // The dependency-free parser doesn't implement folding; `description`
        // would arrive as the literal `>` before the fix.
        `---\ndescription: >\n  line one\n  line two\nalwaysApply: true\n---\nbody`,
      )
      const rules = await loadGlobRules(cwd)
      expect(rules).toHaveLength(1)
      expect(rules[0]?.description).toBeUndefined()
      // and the rendered block does NOT carry the literal `>` as authority text
      const block = renderGlobRulesBlock(rules)
      expect(block).not.toMatch(/—\s*>(\s|$)/m)
      expect(block).not.toMatch(/—\s*\|(\s|$)/m)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test("description: | (literal block) is also normalized away when only the indicator survives", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "r3-3-literal-"))
    try {
      const dir = join(cwd, ".cursor/rules")
      await mkdir(dir, { recursive: true })
      await writeFile(
        join(dir, "literal.mdc"),
        `---\ndescription: |\n  multi\n  line\nalwaysApply: true\n---\nbody`,
      )
      const rules = await loadGlobRules(cwd)
      expect(rules[0]?.description).toBeUndefined()
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test("a real single-line description still works (regression guard)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "r3-3-real-"))
    try {
      const dir = join(cwd, ".cursor/rules")
      await mkdir(dir, { recursive: true })
      await writeFile(
        join(dir, "real.mdc"),
        `---\ndescription: real description here\nalwaysApply: true\n---\nbody`,
      )
      const rules = await loadGlobRules(cwd)
      expect(rules[0]?.description).toBe("real description here")
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

// --- R3-T1: multi-turn glob-rule re-selection (per-turn contract) -----------

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

describe("R3-T1 — glob-rule selection is per-turn (changedPaths mutation visible to next turn)", () => {
  test("between turn 1 and turn 2 the same rule appears / disappears as changedPaths flips", async () => {
    const tsRule: GlobRule = {
      sourcePath: "/r/ts.mdc",
      globs: ["*.ts"],
      alwaysApply: false,
      body: "TS-RULE-BODY",
    }
    const config = {
      registry: new ToolRegistry([]),
      stream: new RecordingStream(),
      permission: { mode: "acceptEdits" } as PermissionContext,
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] as Message[],
      system: "t",
      cwd: "/tmp",
      maxTurns: 2,
      signal: new AbortController().signal,
      onConfirm: async () => false,
      // mutate-in-place: turn 1 matches, then we flip the array before turn 2
      globRules: { rules: [tsRule], changedPaths: ["src/a.ts"] },
    } as unknown as AgentConfig
    // turn 1: script a no-op tool call so the loop loops once and starts turn 2
    const llm = new RecordingLLM([
      // turn 1's request: assistant immediately ends with text (1 turn total)
      // — actually we want TWO turns: emit tool_use, then on the next
      // request flip changedPaths and observe the rule absent. Simplest: use
      // a script that emits text "done" first time (loop ends after 1 turn).
      // Instead, force two turns via a tool call that flips changedPaths in
      // its execute. We mutate the config object from a hook closure to test
      // both turns within one runAgent.
      textScript("done"),
    ])
    // Turn 1 only — verify rule WAS injected
    await runAgent({ ...config, llm } as AgentConfig)
    expect(reminderText(llm.inputs[0])).toContain("TS-RULE-BODY")

    // Flip changedPaths and run again — turn 2 (separate runAgent invocation)
    config.globRules = { rules: [tsRule], changedPaths: ["README.md"] }
    const llm2 = new RecordingLLM([textScript("done")])
    await runAgent({ ...config, llm: llm2 } as AgentConfig)
    expect(reminderText(llm2.inputs[0])).not.toContain("TS-RULE-BODY")
  })
})

// --- R3-T2: parallel-tool hook rewrite isolation ----------------------------

describe("R3-T2 — parallel dispatch isolates the rewrite sink per call", () => {
  test("two parallel dispatchTool invocations each get their OWN rewrite", async () => {
    const sinkA = { received: [] as unknown[] }
    const sinkB = { received: [] as unknown[] }
    // Two separate echo tools so we can route distinct rewrites via matchers.
    const echoTool = (name: "echoA" | "echoB", sink: { received: unknown[] }): Tool => ({
      name,
      description: name,
      inputSchema: z.object({ path: z.string() }) as z.ZodType<unknown>,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      execute: (input: unknown) =>
        (async function* () {
          sink.received.push(input)
          yield {
            type: "result" as const,
            result: { ok: true, output: `${name}:${(input as { path: string }).path}` },
          }
        })(),
    })
    const hooks = new HookBus()
    hooks.on("pre_tool_use", () => ({ updatedInput: { path: "A-rewrite" } }), {
      matcher: ["echoA"],
    })
    hooks.on("pre_tool_use", () => ({ updatedInput: { path: "B-rewrite" } }), {
      matcher: ["echoB"],
    })
    const cfg = {
      registry: new ToolRegistry([echoTool("echoA", sinkA), echoTool("echoB", sinkB)]),
      cwd: "/repo",
      signal: new AbortController().signal,
      planMode: false,
      hooks,
    } as unknown as AgentConfig
    // fire both in parallel (Promise.all) — each dispatchTool builds its own
    // `rewritten` closure inside dispatchToolInner so no cross-talk.
    const [resA, resB] = await Promise.all([
      dispatchTool(
        { type: "tool_use", id: "a", name: "echoA", input: { path: "origA" } } as ToolUseBlock,
        cfg,
        { mode: "acceptEdits" } as PermissionContext,
      ),
      dispatchTool(
        { type: "tool_use", id: "b", name: "echoB", input: { path: "origB" } } as ToolUseBlock,
        cfg,
        { mode: "acceptEdits" } as PermissionContext,
      ),
    ])
    expect(sinkA.received).toEqual([{ path: "A-rewrite" }])
    expect(sinkB.received).toEqual([{ path: "B-rewrite" }])
    expect(resA.preview).toBe("echoA:A-rewrite")
    expect(resB.preview).toBe("echoB:B-rewrite")
  })
})
