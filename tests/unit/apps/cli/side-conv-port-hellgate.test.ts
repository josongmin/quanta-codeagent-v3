import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { RuntimeSideConversationResult } from "@/sdk/runtime"
import { type SideCmdSlashState, sideCmd } from "../../../../src/apps/cli/side-cmd"
import type { SlashContext } from "../../../../src/apps/cli/slash-commands"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..")
const SLASH_SURFACE_PATH = join(REPO_ROOT, "src/apps/cli/repl/slash-surface.ts")
const SIDE_CMD_PATH = join(REPO_ROOT, "src/apps/cli/side-cmd.ts")

interface Capture {
  out: string[]
  err: string[]
}

const makeCtx = (over: Partial<SlashContext> = {}): { ctx: SlashContext; cap: Capture } => {
  const cap: Capture = { out: [], err: [] }
  return {
    cap,
    ctx: {
      out: (s) => cap.out.push(s),
      err: (s) => cap.err.push(s),
      cwd: "/tmp",
      ...over,
    },
  }
}

interface StarterSpy {
  calls: number
  lastArgs?: Parameters<SideCmdSlashState["start"]>[0]
}

const okResult = (
  over: Partial<RuntimeSideConversationResult> = {},
): RuntimeSideConversationResult => ({
  outcome: { messages: [] } as never,
  answerText: "answer",
  inputTokens: 0,
  outputTokens: 0,
  toolsAvailable: 0,
  ...over,
})

const makeRecordingStart = (
  spy: StarterSpy,
  result: RuntimeSideConversationResult = okResult(),
): SideCmdSlashState["start"] => {
  return async (req) => {
    spy.calls++
    spy.lastArgs = req
    return result
  }
}

const makeState = (
  over: Partial<SideCmdSlashState> & { start: SideCmdSlashState["start"] },
): SideCmdSlashState => ({
  isWired: () => true,
  signal: new AbortController().signal,
  ...over,
})

describe("runtime side starter source fences", () => {
  test("slash-surface.ts does not reference SessionDeps or assembleConfig", async () => {
    const src = await readFile(SLASH_SURFACE_PATH, "utf8")
    expect(src.includes("SessionDeps")).toBe(false)
    expect(src.includes("assembleConfig")).toBe(false)
  })

  test("side-cmd.ts avoids runner side-conversation imports", async () => {
    const src = await readFile(SIDE_CMD_PATH, "utf8")
    expect(src).not.toContain('from "@/runner/side-conversation-port"')
    expect(src).not.toContain('from "@/runner/orchestrate/side-chat"')
    expect(src).not.toContain("SideConversationPort")
  })
})

describe("runtime side starter behavior", () => {
  test("absence or unwired state keeps the historical exit-0 contract", async () => {
    const base = makeCtx()
    expect(await sideCmd.run(["q"], base.ctx)).toBe(0)
    expect(base.cap.out.join("")).toContain("not wired")

    const unwired = makeCtx({
      side: {
        start: async () => okResult(),
        isWired: () => false,
        signal: new AbortController().signal,
      },
    })
    expect(await sideCmd.run(["q"], unwired.ctx)).toBe(0)
    expect(unwired.cap.out.join("")).toContain("not wired")
  })

  test("happy path forwards question, inherit, tools, and defaultMaxTurns", async () => {
    const spy: StarterSpy = { calls: 0 }
    const { ctx } = makeCtx({
      side: makeState({
        start: makeRecordingStart(spy),
        defaultMaxTurns: 5,
      }),
    })
    const rc = await sideCmd.run(["--inherit=last-turn", "--tools=read,grep", "where?"], ctx)
    expect(rc).toBe(0)
    expect(spy.calls).toBe(1)
    expect(spy.lastArgs?.question).toBe("where?")
    expect(spy.lastArgs?.inherit).toBe("last-turn")
    expect(spy.lastArgs?.tools).toEqual(["read", "grep"])
    expect(spy.lastArgs?.maxTurns).toBe(5)
  })

  test("starter throw stays catch-and-render, no uncaught rejection", async () => {
    const { ctx, cap } = makeCtx({
      side: makeState({
        start: async () => {
          throw new Error("boom-side")
        },
      }),
    })
    const rc = await sideCmd.run(["q"], ctx)
    expect(rc).toBe(1)
    expect(cap.err.join("")).toContain("boom-side")
    expect(cap.out.join("")).toContain("- /side - q")
  })
})
