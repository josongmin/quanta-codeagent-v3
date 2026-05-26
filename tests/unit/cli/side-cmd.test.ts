/**
 * `/side` slash-command contract — unit tests.
 *
 * After the Runtime SDK cutover the slash command consumes a runtime-owned
 * side starter instead of capturing `(SessionDeps, assembleConfig, messages,
 * signal)` itself. These tests inject a fake starter directly so they can pin
 * the surface contract without standing up the runner/runtime.
 *
 *  - argv parsing (positional, --inherit, --tools, --help, unknown flag).
 *  - default-OFF wiring: no `ctx.side` ⇒ "not wired" + exit 0.
 *  - help branch.
 *  - empty-prompt rejection.
 *  - successful side-chat path ⇒ answer + footer rendered to stdout.
 *  - error path ⇒ exit 1 + message on stderr.
 *  - --inherit=last-turn forwards the inheritance mode to `start`.
 *  - --tools=<csv> forwards the override list to `start`.
 */
import { describe, expect, test } from "bun:test"
import type { RuntimeSideConversationResult } from "@/sdk/runtime"
import { parseSideCmdArgs, type SideCmdSlashState, sideCmd } from "../../../src/apps/cli/side-cmd"
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

interface PortCapture {
  calls: number
  lastArgs?: Parameters<SideCmdSlashState["start"]>[0]
}

/** Build a fake runtime-side starter that returns a fixed
 *  {@link RuntimeSideConversationResult}. The capture mirrors `start()`'s args so callers
 *  can assert exactly what the slash command passed in. */
const makeFakeStart = (
  result: RuntimeSideConversationResult,
  capture: PortCapture,
): SideCmdSlashState["start"] => {
  return async (req) => {
    capture.calls++
    capture.lastArgs = req
    return result
  }
}

const okResult = (
  over: Partial<RuntimeSideConversationResult> = {},
): RuntimeSideConversationResult => ({
  outcome: { messages: [] } as never,
  answerText: "ok",
  inputTokens: 0,
  outputTokens: 0,
  toolsAvailable: 0,
  ...over,
})

const makeState = (
  start: SideCmdSlashState["start"],
  signal: AbortSignal = new AbortController().signal,
): SideCmdSlashState => ({
  start,
  isWired: () => true,
  signal,
})

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

  test("happy path: renders header + answer + footer; port.start called once with the question", async () => {
    const capture: PortCapture = { calls: 0 }
    const start = makeFakeStart(okResult({ answerText: "bun test", toolsAvailable: 3 }), capture)
    const { ctx, stdout } = makeCtx({ side: makeState(start) })
    const rc = await sideCmd.run(["what's", "the", "test", "command?"], ctx)
    expect(rc).toBe(0)
    const out = stdout.join("")
    expect(out).toContain("/side")
    expect(out).toContain("what's the test command?")
    expect(out).toContain("bun test")
    expect(out).toContain("separate from main session")
    expect(capture.calls).toBe(1)
    expect(capture.lastArgs?.question).toBe("what's the test command?")
  })

  test("--inherit=last-turn forwards mode to runtime side starter", async () => {
    const capture: PortCapture = { calls: 0 }
    const start = makeFakeStart(okResult(), capture)
    const { ctx } = makeCtx({ side: makeState(start) })
    const rc = await sideCmd.run(["--inherit=last-turn", "follow-up?"], ctx)
    expect(rc).toBe(0)
    expect(capture.lastArgs?.inherit).toBe("last-turn")
  })

  test("--tools=<csv> forwards the override list to port.start", async () => {
    const capture: PortCapture = { calls: 0 }
    const start = makeFakeStart(okResult({ toolsAvailable: 1 }), capture)
    const { ctx } = makeCtx({ side: makeState(start) })
    const rc = await sideCmd.run(["--tools=read,grep", "q"], ctx)
    expect(rc).toBe(0)
    expect(capture.lastArgs?.tools).toEqual(["read", "grep"])
  })

  test("--tools= (forbidden names) STILL forwards verbatim — port's adapter applies the deny filter", async () => {
    // After ADR-0304 the slash command no longer knows about
    // SIDE_CHAT_FORBIDDEN; the runner (called via port.start) still drops
    // forbidden names physically from the registry. The slash just
    // forwards the user's list verbatim.
    const capture: PortCapture = { calls: 0 }
    const start = makeFakeStart(okResult(), capture)
    const { ctx } = makeCtx({ side: makeState(start) })
    const rc = await sideCmd.run(["--tools=read,write,bash", "q"], ctx)
    expect(rc).toBe(0)
    expect(capture.lastArgs?.tools).toEqual(["read", "write", "bash"])
  })

  test("--inherit=bogus ⇒ exit 1 + message on stderr; port.start NEVER called", async () => {
    const capture: PortCapture = { calls: 0 }
    const start = makeFakeStart(okResult(), capture)
    const { ctx, stderr } = makeCtx({ side: makeState(start) })
    const rc = await sideCmd.run(["--inherit=bogus", "q"], ctx)
    expect(rc).toBe(1)
    expect(stderr.join("")).toContain("invalid --inherit")
    expect(capture.calls).toBe(0)
  })

  test("port.start throws ⇒ exit 1 + message painted to stderr", async () => {
    const failingStart: SideCmdSlashState["start"] = async () => {
      throw new Error("BOOM-side")
    }
    const { ctx, stdout, stderr } = makeCtx({ side: makeState(failingStart) })
    const rc = await sideCmd.run(["q"], ctx)
    expect(rc).toBe(1)
    expect(stderr.join("")).toContain("/side: BOOM-side")
    // Header still painted before the throw — proves dispatch crossed
    // into the real branch.
    expect(stdout.join("")).toContain("- /side - q")
  })

  test("sideCmd is registered in the BUILTINS table (re-export sanity)", async () => {
    const mod = await import("../../../src/apps/cli/slash-commands")
    const names = mod.BUILTINS.map((c) => c.name)
    expect(names).toContain("/side")
  })

  test("footer renders the side-chat's actual token tally (not 0/0) when port returns usage", async () => {
    const capture: PortCapture = { calls: 0 }
    const start = makeFakeStart(
      okResult({
        answerText: "answer",
        inputTokens: 11,
        outputTokens: 22,
        toolsAvailable: 1,
      }),
      capture,
    )
    const { ctx, stdout } = makeCtx({ side: makeState(start) })
    const rc = await sideCmd.run(["q"], ctx)
    expect(rc).toBe(0)
    const out = stdout.join("")
    expect(out).toContain("33 tok")
    expect(out).not.toContain("0 tok")
  })

  test("defaultMaxTurns from state ⇒ forwarded as `maxTurns` on port.start (when no --flag given)", async () => {
    const capture: PortCapture = { calls: 0 }
    const start = makeFakeStart(okResult(), capture)
    const state: SideCmdSlashState = {
      start,
      isWired: () => true,
      signal: new AbortController().signal,
      defaultMaxTurns: 4,
    }
    const { ctx } = makeCtx({ side: state })
    const rc = await sideCmd.run(["q"], ctx)
    expect(rc).toBe(0)
    expect(capture.lastArgs?.maxTurns).toBe(4)
  })

  test("missing answerText ⇒ falls back to the '(no answer …)' line", async () => {
    const capture: PortCapture = { calls: 0 }
    const start = makeFakeStart(okResult({ answerText: "" }), capture)
    const { ctx, stdout } = makeCtx({ side: makeState(start) })
    const rc = await sideCmd.run(["q"], ctx)
    expect(rc).toBe(0)
    expect(stdout.join("")).toContain("(no answer")
  })
})
