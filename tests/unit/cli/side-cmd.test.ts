/**
 * `/side` slash-command contract — unit tests.
 *
 *  - argv parsing (positional, --inherit, --tools, --help, unknown flag).
 *  - default-OFF wiring: no `ctx.side` ⇒ "not wired" + exit 0.
 *  - help branch.
 *  - empty-prompt rejection.
 *  - successful side-chat path ⇒ answer + footer rendered to stdout.
 *  - error path ⇒ exit 1 + message on stderr.
 *  - --inherit=last-turn forwards inheritance mode.
 *  - --tools=<csv> overrides the default allowlist.
 */
import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import type { Message } from "@/llm"
import type { OrchestrateDeps } from "@/runner"
import { defaultTools, ToolRegistry } from "@/tool"
import {
  parseSideCmdArgs,
  type SideChatSessionState,
  sideCmd,
} from "../../../src/apps/cli/side-cmd"
import type { SlashContext } from "../../../src/apps/cli/slash-commands"

/** Capture stdout / stderr for a slash-command run. */
const makeCtx = (
  over: Partial<SlashContext> = {},
): {
  ctx: SlashContext
  stdout: string[]
  stderr: string[]
} => {
  const stdout: string[] = []
  const stderr: string[] = []
  const ctx: SlashContext = {
    out: (s: string) => {
      stdout.push(s)
    },
    err: (s: string) => {
      stderr.push(s)
    },
    cwd: "/tmp",
    ...over,
  }
  return { ctx, stdout, stderr }
}

const stubDeps = (signal: AbortSignal): OrchestrateDeps =>
  ({
    llm: { stream: async function* () {} } as never,
    registry: new ToolRegistry(defaultTools),
    stream: { emit: () => undefined } as never,
    permission: { mode: "default" } as never,
    system: "test-system",
    cwd: "/tmp",
    maxTurns: 99,
    signal,
    onConfirm: async () => false,
    store: undefined,
    sessionId: "test-session",
    embedder: undefined,
    memoryConfig: undefined,
    planMode: false,
    metrics: undefined,
    run: undefined,
    subagentConfig: undefined,
    skillsConfig: undefined,
    compactionBreakerConfig: undefined,
    verifyGuardConfig: undefined,
    summarizerLlm: undefined,
    onShellEvent: undefined,
    workMetricsSink: undefined,
  }) satisfies OrchestrateDeps

/** Build a side-chat session state whose LLM stream yields a fixed answer. */
const makeSessionState = (
  signal: AbortSignal,
  answer: string,
  capture: { messagesSeen?: Message[]; toolsSeenCount?: number } = {},
): SideChatSessionState => {
  return {
    deps: stubDeps(signal),
    assembleConfig: (messages: Message[], deps: OrchestrateDeps): AgentConfig => {
      capture.messagesSeen = messages
      capture.toolsSeenCount = deps.registry.specs().length
      return {
        llm: {
          async *stream() {
            yield { type: "text_delta", delta: answer }
            yield { type: "message_stop", stop_reason: "end_turn" }
          },
        } as never,
        registry: deps.registry,
        stream: deps.stream,
        permission: deps.permission,
        messages,
        system: deps.system,
        cwd: deps.cwd,
        maxTurns: deps.maxTurns,
        signal: deps.signal,
        onConfirm: deps.onConfirm,
      }
    },
    messages: [],
    signal,
  }
}

describe("parseSideCmdArgs", () => {
  test("positional tokens join into the prompt", () => {
    const a = parseSideCmdArgs(["what's", "the", "test", "command?"])
    expect(a.prompt).toBe("what's the test command?")
    expect(a.help).toBe(false)
    expect(a.inherit).toBeUndefined()
    expect(a.tools).toBeUndefined()
  })

  test("--help sets help flag", () => {
    expect(parseSideCmdArgs(["--help"]).help).toBe(true)
    expect(parseSideCmdArgs(["-h"]).help).toBe(true)
  })

  test("--inherit=<mode> parses + validates the mode", () => {
    expect(parseSideCmdArgs(["--inherit=none", "q"]).inherit).toBe("none")
    expect(parseSideCmdArgs(["--inherit=system", "q"]).inherit).toBe("system")
    expect(parseSideCmdArgs(["--inherit=last-turn", "q"]).inherit).toBe("last-turn")
    expect(() => parseSideCmdArgs(["--inherit=bogus", "q"])).toThrow(/invalid --inherit/)
  })

  test("--tools=<csv> parses to a non-empty list", () => {
    const a = parseSideCmdArgs(["--tools=read,grep,glob", "q"])
    expect(a.tools).toEqual(["read", "grep", "glob"])
  })

  test("--tools= (empty) throws", () => {
    expect(() => parseSideCmdArgs(["--tools=", "q"])).toThrow(/must list at least one tool name/)
  })

  test("unknown flag throws", () => {
    expect(() => parseSideCmdArgs(["--bogus", "q"])).toThrow(/unknown flag/)
  })

  test("flags can appear before OR after positional tokens", () => {
    const a = parseSideCmdArgs(["the", "--inherit=none", "question"])
    expect(a.prompt).toBe("the question")
    expect(a.inherit).toBe("none")
  })
})

describe("/side slash command", () => {
  test("not wired ⇒ prints 'not wired' and exits 0", async () => {
    const { ctx, stdout } = makeCtx()
    const rc = await sideCmd.run(["hello"], ctx)
    expect(rc).toBe(0)
    expect(stdout.join("")).toContain("not wired")
  })

  test("--help renders help text and exits 0", async () => {
    const { ctx, stdout } = makeCtx()
    const rc = await sideCmd.run(["--help"], ctx)
    expect(rc).toBe(0)
    const help = stdout.join("")
    expect(help).toContain("/side <question>")
    expect(help).toContain("inheritance:")
    expect(help).toContain("max turns:")
    expect(help).toContain("tools:")
  })

  test("empty prompt ⇒ exit 1 + hint", async () => {
    const { ctx, stderr } = makeCtx()
    const rc = await sideCmd.run([], ctx)
    expect(rc).toBe(1)
    expect(stderr.join("")).toContain("expected a question")
  })

  test("happy path: renders header + answer + footer", async () => {
    const abort = new AbortController()
    const capture: { messagesSeen?: Message[]; toolsSeenCount?: number } = {}
    const { ctx, stdout } = makeCtx({
      side: makeSessionState(abort.signal, "bun test", capture),
    })
    const rc = await sideCmd.run(["what's", "the", "test", "command?"], ctx)
    expect(rc).toBe(0)
    const out = stdout.join("")
    // Header echo of the prompt.
    expect(out).toContain("/side")
    expect(out).toContain("what's the test command?")
    // Answer body painted.
    expect(out).toContain("bun test")
    // Footer with separation note.
    expect(out).toContain("separate from main session")
  })

  test("--inherit=last-turn forwards inheritance to the assembler", async () => {
    const abort = new AbortController()
    const capture: { messagesSeen?: Message[] } = {}
    const state = makeSessionState(abort.signal, "ok", capture)
    // Inject a 2-message main history via the wrapped state.
    const stateWithHistory: SideChatSessionState = {
      ...state,
      messages: [
        { role: "user", content: [{ type: "text", text: "main-u" }] },
        { role: "assistant", content: [{ type: "text", text: "main-a" }] },
      ],
    }
    const { ctx } = makeCtx({ side: stateWithHistory })
    const rc = await sideCmd.run(["--inherit=last-turn", "follow-up?"], ctx)
    expect(rc).toBe(0)
    // Assembler should have seen the inherited pair + the side prompt.
    const seen = capture.messagesSeen ?? []
    expect(seen.length).toBe(3)
    expect((seen[0]?.content[0] as { type: "text"; text: string }).text).toBe("main-u")
    expect((seen[2]?.content[0] as { type: "text"; text: string }).text).toBe("follow-up?")
  })

  test("--tools=<csv> overrides the default allowlist", async () => {
    const abort = new AbortController()
    const capture: { toolsSeenCount?: number } = {}
    const { ctx } = makeCtx({
      side: makeSessionState(abort.signal, "ok", capture),
    })
    const rc = await sideCmd.run(["--tools=read", "q"], ctx)
    expect(rc).toBe(0)
    // Only `read` was allowed — registry should hold exactly 1 tool.
    expect(capture.toolsSeenCount).toBe(1)
  })

  test("--tools= forbidden tools are dropped (deny-default backstop)", async () => {
    const abort = new AbortController()
    const capture: { toolsSeenCount?: number } = {}
    const { ctx } = makeCtx({
      side: makeSessionState(abort.signal, "ok", capture),
    })
    const rc = await sideCmd.run(["--tools=read,write,bash", "q"], ctx)
    expect(rc).toBe(0)
    // `read` only — `write` and `bash` are forbidden and dropped.
    expect(capture.toolsSeenCount).toBe(1)
  })

  test("--inherit=bogus ⇒ exit 1 + message on stderr", async () => {
    const { ctx, stderr } = makeCtx()
    const rc = await sideCmd.run(["--inherit=bogus", "q"], ctx)
    expect(rc).toBe(1)
    expect(stderr.join("")).toContain("invalid --inherit")
  })

  test("sideCmd is registered in the BUILTINS table (re-export sanity)", async () => {
    const mod = await import("../../../src/apps/cli/slash-commands")
    const names = mod.BUILTINS.map((c) => c.name)
    expect(names).toContain("/side")
  })
})
