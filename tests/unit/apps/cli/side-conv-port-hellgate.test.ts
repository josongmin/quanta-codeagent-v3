/**
 * ADR-0304 — `SideConversationPort` hellgate.
 *
 * Pins the seam between the CLI slash surface and the side-chat runner.
 * Two classes of invariant:
 *
 *  1. SOURCE-GREP fences (slice discipline)
 *     - `src/apps/cli/repl/slash-surface.ts` may NOT mention `assembleConfig`
 *       or `SessionDeps` (neither imports nor type/value references).
 *     - `src/apps/cli/side-cmd.ts` may NOT import `OrchestrateDeps` or
 *       `RunOnceInput` (those belong with the port adapter).
 *     A regression that re-introduces the leak fails these tests
 *     deterministically — no integration plumbing needed.
 *
 *  2. PORT-SHAPE behavior
 *     - `--help` short-circuits before `port.start`.
 *     - Invalid `--inherit` short-circuits before `port.start` with exit 1.
 *     - Empty prompt short-circuits before `port.start` with exit 1.
 *     - Absent state (`ctx.side === undefined`) ⇒ "not wired" exit 0;
 *       port (none) never called.
 *     - Happy path: port receives the question + live transcript snapshot
 *       from `getHistory()`.
 *     - `--inherit=<mode>` forwards verbatim.
 *     - `--tools=<csv>` forwards verbatim.
 *     - `defaultMaxTurns` on the state ⇒ forwarded as `maxTurns` when no
 *       per-call override is supplied.
 *     - `port.start` throw ⇒ caught into stderr + exit 1 (REPL keeps
 *       running — no uncaught rejection).
 *     - `getHistory()` is consulted PER call (live), not captured.
 *     - The slash surface's `signal` is forwarded into `port.start`.
 *     - Header IS painted before `port.start` (positive control — a
 *       regression that short-circuits after parsing would still pass the
 *       "not wired" tests, but would fail this one because the header
 *       precedes start()).
 */

import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { Message } from "@/llm"
import type { SideChatResult, SideConversationPort, SideConversationStartArgs } from "@/runner"
import { type SideCmdSlashState, sideCmd } from "../../../../src/apps/cli/side-cmd"
import type { SlashContext } from "../../../../src/apps/cli/slash-commands"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..")
const SLASH_SURFACE_PATH = join(REPO_ROOT, "src/apps/cli/repl/slash-surface.ts")
const SIDE_CMD_PATH = join(REPO_ROOT, "src/apps/cli/side-cmd.ts")

interface Cap {
  out: string[]
  err: string[]
}

const makeCtxWith = (over: Partial<SlashContext> = {}): { ctx: SlashContext; cap: Cap } => {
  const cap: Cap = { out: [], err: [] }
  const ctx: SlashContext = {
    out: (s) => cap.out.push(s),
    err: (s) => cap.err.push(s),
    cwd: "/tmp",
    ...over,
  }
  return { ctx, cap }
}

interface PortSpy {
  calls: number
  lastArgs?: SideConversationStartArgs
}

const okResult = (over: Partial<SideChatResult> = {}): SideChatResult => ({
  outcome: { messages: [] } as never,
  answerText: "answer",
  inputTokens: 0,
  outputTokens: 0,
  toolsAvailable: 0,
  ...over,
})

const makeRecordingPort = (
  spy: PortSpy,
  result: SideChatResult = okResult(),
): SideConversationPort => ({
  start: async (req) => {
    spy.calls++
    spy.lastArgs = req
    return result
  },
})

const makeThrowingPort = (msg: string): SideConversationPort => ({
  start: async () => {
    throw new Error(msg)
  },
})

const makeState = (
  over: Partial<SideCmdSlashState> & { port: SideConversationPort },
): SideCmdSlashState => ({
  getHistory: () => [],
  signal: new AbortController().signal,
  ...over,
})

// ─── 1. Source-grep fences ─────────────────────────────────────────────────

describe("ADR-0304 source fences", () => {
  test("slash-surface.ts source does NOT reference `assembleConfig`", async () => {
    const src = await readFile(SLASH_SURFACE_PATH, "utf8")
    expect(src.includes("assembleConfig")).toBe(false)
  })

  test("slash-surface.ts source does NOT reference `SessionDeps`", async () => {
    const src = await readFile(SLASH_SURFACE_PATH, "utf8")
    expect(src.includes("SessionDeps")).toBe(false)
  })

  test("side-cmd.ts source does NOT import `OrchestrateDeps`", async () => {
    const src = await readFile(SIDE_CMD_PATH, "utf8")
    // We tolerate occurrences inside *comments* only (a JSDoc may mention
    // it historically). The assertion-grade rule: there is no `import …
    // OrchestrateDeps` line. We test by scanning import statements.
    const importLines = src
      .split("\n")
      .filter((l) => /^\s*import\b/.test(l) || /^\s+(?:type\s+)?OrchestrateDeps\b/.test(l))
    const hasImport = importLines.some((l) => l.includes("OrchestrateDeps"))
    expect(hasImport).toBe(false)
  })

  test("side-cmd.ts source does NOT import `RunOnceInput`", async () => {
    const src = await readFile(SIDE_CMD_PATH, "utf8")
    const importLines = src
      .split("\n")
      .filter((l) => /^\s*import\b/.test(l) || /^\s+(?:type\s+)?RunOnceInput\b/.test(l))
    const hasImport = importLines.some((l) => l.includes("RunOnceInput"))
    expect(hasImport).toBe(false)
  })
})

// ─── 2. Port-shape behavior ────────────────────────────────────────────────

describe("ADR-0304 /side port behavior", () => {
  test("--help ⇒ exit 0, port.start NEVER called", async () => {
    const spy: PortSpy = { calls: 0 }
    const port = makeRecordingPort(spy)
    const { ctx, cap } = makeCtxWith({ side: makeState({ port }) })
    const rc = await sideCmd.run(["--help"], ctx)
    expect(rc).toBe(0)
    expect(cap.out.join("")).toContain("isolated agent loop")
    expect(spy.calls).toBe(0)
  })

  test("--inherit=garbage ⇒ exit 1, port.start NEVER called", async () => {
    const spy: PortSpy = { calls: 0 }
    const port = makeRecordingPort(spy)
    const { ctx, cap } = makeCtxWith({ side: makeState({ port }) })
    const rc = await sideCmd.run(["--inherit=garbage", "q"], ctx)
    expect(rc).toBe(1)
    expect(cap.err.join("")).toContain("invalid --inherit")
    expect(spy.calls).toBe(0)
  })

  test("empty prompt ⇒ exit 1, port.start NEVER called", async () => {
    const spy: PortSpy = { calls: 0 }
    const port = makeRecordingPort(spy)
    const { ctx, cap } = makeCtxWith({ side: makeState({ port }) })
    const rc = await sideCmd.run([], ctx)
    expect(rc).toBe(1)
    expect(cap.err.join("")).toContain("expected a question")
    expect(spy.calls).toBe(0)
  })

  test("ABSENT state ⇒ 'not wired' + exit 0; would-be port never consulted", async () => {
    const { ctx, cap } = makeCtxWith()
    const rc = await sideCmd.run(["q"], ctx)
    expect(rc).toBe(0)
    expect(cap.out.join("")).toContain("not wired")
  })

  test("happy path ⇒ port.start receives the question verbatim", async () => {
    const spy: PortSpy = { calls: 0 }
    const port = makeRecordingPort(spy)
    const { ctx } = makeCtxWith({ side: makeState({ port }) })
    const rc = await sideCmd.run(["how", "do", "i", "test?"], ctx)
    expect(rc).toBe(0)
    expect(spy.calls).toBe(1)
    expect(spy.lastArgs?.question).toBe("how do i test?")
  })

  test("--inherit=last-turn ⇒ port receives the LIVE transcript snapshot via getHistory()", async () => {
    const spy: PortSpy = { calls: 0 }
    const port = makeRecordingPort(spy)
    // Mutable transcript — proves the slash reads getHistory() at call
    // time (not at state-construction time).
    const history: Message[] = []
    history.push({ role: "user", content: [{ type: "text", text: "live-u" }] })
    history.push({ role: "assistant", content: [{ type: "text", text: "live-a" }] })
    const state = makeState({ port, getHistory: () => history })
    const { ctx } = makeCtxWith({ side: state })
    const rc = await sideCmd.run(["--inherit=last-turn", "fu?"], ctx)
    expect(rc).toBe(0)
    expect(spy.lastArgs?.inherit).toBe("last-turn")
    expect(spy.lastArgs?.messages.length).toBe(2)
  })

  test("--tools=foo,bar ⇒ port.start receives tools: ['foo', 'bar']", async () => {
    const spy: PortSpy = { calls: 0 }
    const port = makeRecordingPort(spy)
    const { ctx } = makeCtxWith({ side: makeState({ port }) })
    const rc = await sideCmd.run(["--tools=foo,bar", "q"], ctx)
    expect(rc).toBe(0)
    expect(spy.lastArgs?.tools).toEqual(["foo", "bar"])
  })

  test("defaultMaxTurns on state ⇒ forwarded as maxTurns to port.start", async () => {
    const spy: PortSpy = { calls: 0 }
    const port = makeRecordingPort(spy)
    const { ctx } = makeCtxWith({
      side: makeState({ port, defaultMaxTurns: 5 }),
    })
    const rc = await sideCmd.run(["q"], ctx)
    expect(rc).toBe(0)
    expect(spy.lastArgs?.maxTurns).toBe(5)
  })

  test("no defaultMaxTurns and no --flag ⇒ port.start receives no maxTurns (adapter decides)", async () => {
    const spy: PortSpy = { calls: 0 }
    const port = makeRecordingPort(spy)
    const { ctx } = makeCtxWith({ side: makeState({ port }) })
    const rc = await sideCmd.run(["q"], ctx)
    expect(rc).toBe(0)
    expect(spy.lastArgs?.maxTurns).toBeUndefined()
  })

  test("signal from state ⇒ forwarded into port.start (same reference)", async () => {
    const spy: PortSpy = { calls: 0 }
    const port = makeRecordingPort(spy)
    const abort = new AbortController()
    const { ctx } = makeCtxWith({
      side: makeState({ port, signal: abort.signal }),
    })
    const rc = await sideCmd.run(["q"], ctx)
    expect(rc).toBe(0)
    expect(spy.lastArgs?.signal).toBe(abort.signal)
  })

  test("port.start throws ⇒ exit 1, message on stderr, REPL stays alive (no rejection escapes)", async () => {
    const port = makeThrowingPort("BOOM-port")
    const { ctx, cap } = makeCtxWith({ side: makeState({ port }) })
    const rc = await sideCmd.run(["q"], ctx)
    expect(rc).toBe(1)
    expect(cap.err.join("")).toContain("/side: BOOM-port")
  })

  test("header IS painted before port.start (positive control — proves dispatch crosses gate)", async () => {
    const port = makeThrowingPort("post-header-throw")
    const { ctx, cap } = makeCtxWith({ side: makeState({ port }) })
    const rc = await sideCmd.run(["hello"], ctx)
    expect(rc).toBe(1)
    // Header painted BEFORE the throw — a regression that returned
    // early on `state !== undefined` would not paint the header.
    expect(cap.out.join("")).toContain("- /side - hello")
  })

  test("getHistory() consulted once per invocation (snapshot semantics, not captured)", async () => {
    const spy: PortSpy = { calls: 0 }
    const port = makeRecordingPort(spy)
    let historyCalls = 0
    const state = makeState({
      port,
      getHistory: () => {
        historyCalls++
        return []
      },
    })
    const { ctx } = makeCtxWith({ side: state })
    await sideCmd.run(["q1"], ctx)
    await sideCmd.run(["q2"], ctx)
    expect(historyCalls).toBe(2)
    expect(spy.calls).toBe(2)
  })

  test("--tools=<csv> overrides state.defaultTools verbatim (forwarding semantics, not merging)", async () => {
    const spy: PortSpy = { calls: 0 }
    const port = makeRecordingPort(spy)
    const state: SideCmdSlashState = makeState({
      port,
      defaultTools: ["read", "grep"],
    })
    const { ctx } = makeCtxWith({ side: state })
    const rc = await sideCmd.run(["--tools=glob", "q"], ctx)
    expect(rc).toBe(0)
    // Slash forwards the user list verbatim; the adapter (not the slash)
    // is what consults `defaultTools` when the per-call value is absent.
    expect(spy.lastArgs?.tools).toEqual(["glob"])
  })

  test("answer rendered to stdout on happy path", async () => {
    const spy: PortSpy = { calls: 0 }
    const port = makeRecordingPort(spy, okResult({ answerText: "the answer", toolsAvailable: 2 }))
    const { ctx, cap } = makeCtxWith({ side: makeState({ port }) })
    const rc = await sideCmd.run(["q"], ctx)
    expect(rc).toBe(0)
    expect(cap.out.join("")).toContain("the answer")
  })
})
