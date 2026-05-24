import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  deriveTurns,
  type HistorySessionState,
  type HistoryToolEvent,
  historyCmd,
  parseHistoryArgs,
  resolveCap,
} from "../../src/apps/cli/history-cmd"
import { runSlashCommand, type SlashContext } from "../../src/apps/cli/slash-commands"
import type { Message } from "../../src/llm"

interface Captured {
  out: string
  err: string
  ctx: SlashContext
}

const buildCtx = (history?: HistorySessionState): Captured => {
  const c: Captured = {
    out: "",
    err: "",
    ctx: {
      out: (s) => {
        c.out += s
      },
      err: (s) => {
        c.err += s
      },
      cwd: "/tmp",
      ...(history !== undefined ? { history } : {}),
    },
  }
  return c
}

const userMsg = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
})

const assistantTool = (id: string, name: string): Message => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name, input: {} }],
})

const toolResult = (id: string, isError = false): Message => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content: "ok", is_error: isError }],
})

let originalDefaultN: string | undefined

beforeEach(() => {
  originalDefaultN = process.env.QUANTA_HISTORY_DEFAULT_N
  delete process.env.QUANTA_HISTORY_DEFAULT_N
})

afterEach(() => {
  if (originalDefaultN === undefined) delete process.env.QUANTA_HISTORY_DEFAULT_N
  else process.env.QUANTA_HISTORY_DEFAULT_N = originalDefaultN
})

/* ------------------------------------------------------------------ */
/* default-OFF + argv parsing                                          */
/* ------------------------------------------------------------------ */

describe("/history default-OFF", () => {
  test("ctx.history absent ⇒ 'not wired' + exit 0", async () => {
    const c = buildCtx()
    const code = await runSlashCommand("/history", c.ctx)
    expect(code).toBe(0)
    expect(c.out).toContain("not wired")
    expect(c.err).toBe("")
  })
})

describe("parseHistoryArgs", () => {
  test("no args ⇒ turns subcommand", () => {
    expect(parseHistoryArgs([])).toEqual({ sub: "turns" })
  })

  test("`tools` ⇒ tools subcommand", () => {
    expect(parseHistoryArgs(["tools"])).toEqual({ sub: "tools" })
  })

  test("`turn 3` ⇒ turn detail with arg=3", () => {
    expect(parseHistoryArgs(["turn", "3"])).toEqual({ sub: "turn", turnArg: 3 })
  })

  test("`--last 20` ⇒ turns subcommand with last=20", () => {
    expect(parseHistoryArgs(["--last", "20"])).toEqual({ sub: "turns", last: 20 })
  })

  test("`--last=15 tools` ⇒ tools with last=15", () => {
    expect(parseHistoryArgs(["--last=15", "tools"])).toEqual({ sub: "tools", last: 15 })
  })

  test("unknown subcommand ⇒ throw", () => {
    expect(() => parseHistoryArgs(["whatever"])).toThrow("unknown subcommand")
  })

  test("turn without arg ⇒ throw", () => {
    expect(() => parseHistoryArgs(["turn"])).toThrow("requires a turn number")
  })

  test("turn with non-integer ⇒ throw", () => {
    expect(() => parseHistoryArgs(["turn", "1.5"])).toThrow("positive integer")
  })

  test("--last 0 ⇒ throw (positive required)", () => {
    expect(() => parseHistoryArgs(["--last", "0"])).toThrow("positive integer")
  })

  test("unknown flag ⇒ throw", () => {
    expect(() => parseHistoryArgs(["--bogus"])).toThrow("unknown flag")
  })
})

describe("resolveCap", () => {
  test("CLI takes precedence over ENV + default", () => {
    expect(resolveCap(5, "20")).toBe(5)
  })

  test("ENV takes precedence over default when CLI absent", () => {
    expect(resolveCap(undefined, "25")).toBe(25)
  })

  test("default 10 when neither set", () => {
    expect(resolveCap(undefined, undefined)).toBe(10)
  })

  test("invalid ENV ⇒ fallback to default", () => {
    expect(resolveCap(undefined, "abc")).toBe(10)
    expect(resolveCap(undefined, "0")).toBe(10)
    expect(resolveCap(undefined, "-5")).toBe(10)
  })

  test("CLI invalid ⇒ skip to ENV", () => {
    expect(resolveCap(0, "25")).toBe(25)
  })
})

/* ------------------------------------------------------------------ */
/* deriveTurns                                                         */
/* ------------------------------------------------------------------ */

describe("deriveTurns", () => {
  test("empty message array ⇒ no turns", () => {
    expect(deriveTurns([])).toEqual([])
  })

  test("user message with no text ⇒ no turn opened", () => {
    const msgs: Message[] = [toolResult("xx", false)]
    expect(deriveTurns(msgs)).toEqual([])
  })

  test("pairs tool_use with tool_result (ok)", () => {
    const msgs: Message[] = [
      userMsg("do a thing"),
      assistantTool("t1", "Read"),
      toolResult("t1", false),
    ]
    const turns = deriveTurns(msgs)
    expect(turns.length).toBe(1)
    expect(turns[0]?.tools.length).toBe(1)
    expect(turns[0]?.tools[0]).toEqual({ id: "t1", name: "Read", ok: true })
  })

  test("pairs tool_use with tool_result (error)", () => {
    const msgs: Message[] = [
      userMsg("do a thing"),
      assistantTool("t1", "Bash"),
      toolResult("t1", true),
    ]
    const turns = deriveTurns(msgs)
    expect(turns[0]?.tools[0]).toEqual({ id: "t1", name: "Bash", ok: false })
  })

  test("unresolved tool_use ⇒ ok stays undefined (in-flight)", () => {
    const msgs: Message[] = [userMsg("do a thing"), assistantTool("t1", "Read")]
    const turns = deriveTurns(msgs)
    expect(turns[0]?.tools[0]?.ok).toBeUndefined()
  })

  test("multiple turns are numbered 1..N", () => {
    const msgs: Message[] = [
      userMsg("first"),
      assistantTool("t1", "Read"),
      toolResult("t1", false),
      userMsg("second"),
      assistantTool("t2", "Grep"),
      toolResult("t2", false),
    ]
    const turns = deriveTurns(msgs)
    expect(turns.length).toBe(2)
    expect(turns[0]?.index).toBe(1)
    expect(turns[1]?.index).toBe(2)
  })
})

/* ------------------------------------------------------------------ */
/* `/history` rendering                                                */
/* ------------------------------------------------------------------ */

describe("/history (turns subcommand)", () => {
  test("empty session ⇒ '(no turns yet)'", async () => {
    const history: HistorySessionState = { messages: () => [] }
    const c = buildCtx(history)
    expect(await runSlashCommand("/history", c.ctx)).toBe(0)
    expect(c.out).toContain("no turns yet")
  })

  test("renders turn count + summary line", async () => {
    const msgs: Message[] = [
      userMsg("refactor parseConfig"),
      assistantTool("t1", "Read"),
      toolResult("t1", false),
      assistantTool("t2", "Bash"),
      toolResult("t2", true),
    ]
    const history: HistorySessionState = { messages: () => msgs }
    const c = buildCtx(history)
    expect(await runSlashCommand("/history", c.ctx)).toBe(0)
    expect(c.out).toContain("Recent turns")
    expect(c.out).toContain("1 of 1 shown")
    expect(c.out).toContain("Turn 1")
    expect(c.out).toContain("refactor parseConfig")
    expect(c.out).toContain("2 tools")
    // ✓✗ for one OK + one FAIL.
    expect(c.out).toMatch(/✓.*✗/)
  })

  test("--last caps the rendered slice and reports total", async () => {
    const msgs: Message[] = []
    for (let i = 1; i <= 5; i++) {
      msgs.push(userMsg(`prompt ${i}`))
      msgs.push(assistantTool(`t${i}`, "Read"))
      msgs.push(toolResult(`t${i}`, false))
    }
    const history: HistorySessionState = { messages: () => msgs }
    const c = buildCtx(history)
    expect(await runSlashCommand("/history --last 2", c.ctx)).toBe(0)
    expect(c.out).toContain("2 of 5 shown")
    expect(c.out).toContain("Turn 4")
    expect(c.out).toContain("Turn 5")
    expect(c.out).not.toContain("Turn 1 ")
  })

  test("QUANTA_HISTORY_DEFAULT_N is honored when no --last", async () => {
    process.env.QUANTA_HISTORY_DEFAULT_N = "1"
    const msgs: Message[] = []
    for (let i = 1; i <= 3; i++) {
      msgs.push(userMsg(`prompt ${i}`))
    }
    const history: HistorySessionState = { messages: () => msgs }
    const c = buildCtx(history)
    expect(await runSlashCommand("/history", c.ctx)).toBe(0)
    expect(c.out).toContain("1 of 3 shown")
    expect(c.out).toContain("Turn 3")
  })

  test("relative-time uses now() seam", async () => {
    const NOW = 1_700_000_000_000
    const msgs: Message[] = [userMsg("did stuff")]
    const history: HistorySessionState = {
      messages: () => msgs,
      now: () => NOW,
      turnStartedAt: () => [NOW - 5 * 60_000],
    }
    const c = buildCtx(history)
    await runSlashCommand("/history", c.ctx)
    expect(c.out).toContain("5m ago")
  })
})

/* ------------------------------------------------------------------ */
/* `/history tools`                                                    */
/* ------------------------------------------------------------------ */

describe("/history tools", () => {
  test("empty session ⇒ '(no tool calls yet)'", async () => {
    const history: HistorySessionState = { messages: () => [] }
    const c = buildCtx(history)
    expect(await runSlashCommand("/history tools", c.ctx)).toBe(0)
    expect(c.out).toContain("no tool calls yet")
  })

  test("renders status glyphs for each tool", async () => {
    const msgs: Message[] = [
      userMsg("go"),
      assistantTool("a", "Read"),
      toolResult("a", false),
      assistantTool("b", "Bash"),
      toolResult("b", true),
    ]
    const history: HistorySessionState = { messages: () => msgs }
    const c = buildCtx(history)
    expect(await runSlashCommand("/history tools", c.ctx)).toBe(0)
    expect(c.out).toContain("Recent tool calls")
    expect(c.out).toContain("✓")
    expect(c.out).toContain("✗")
    expect(c.out).toContain("Read")
    expect(c.out).toContain("Bash")
    expect(c.out).toContain("(failed)")
    expect(c.out).toContain("--:--:--") // no events provided
  })

  test("retry glyph fires when OK follows FAIL of same tool", async () => {
    const msgs: Message[] = [
      userMsg("test then retest"),
      assistantTool("a", "Bash"),
      toolResult("a", true), // fail
      assistantTool("b", "Bash"),
      toolResult("b", false), // ok
    ]
    const history: HistorySessionState = { messages: () => msgs }
    const c = buildCtx(history)
    await runSlashCommand("/history tools", c.ctx)
    expect(c.out).toContain("↻")
    expect(c.out).toContain("(retry, ✓)")
  })

  test("envelope events supply HH:MM:SS wall-clock", async () => {
    const events: HistoryToolEvent[] = [
      { ts: "2026-05-24T14:23:01Z", tool: "Read", kind: "invoke" },
      { ts: "2026-05-24T14:23:02Z", tool: "Read", kind: "result", ok: true },
    ]
    const msgs: Message[] = [userMsg("go"), assistantTool("a", "Read"), toolResult("a", false)]
    const history: HistorySessionState = {
      messages: () => msgs,
      events: async () => events,
    }
    const c = buildCtx(history)
    await runSlashCommand("/history tools", c.ctx)
    // Format is HH:MM:SS (local time) — assert digit shape, not exact value
    // (CI runs in different TZ; UTC 14:23:01 → unknown local time).
    expect(c.out).toMatch(/\d\d:\d\d:\d\d/)
    expect(c.out).not.toContain("--:--:--")
  })
})

/* ------------------------------------------------------------------ */
/* `/history turn <N>`                                                 */
/* ------------------------------------------------------------------ */

describe("/history turn <N>", () => {
  test("missing turn ⇒ exit 1 + helpful error", async () => {
    const history: HistorySessionState = { messages: () => [] }
    const c = buildCtx(history)
    expect(await runSlashCommand("/history turn 7", c.ctx)).toBe(1)
    expect(c.err).toContain("turn 7 not found")
  })

  test("existing turn ⇒ exit 0 + prompt + per-tool detail", async () => {
    const msgs: Message[] = [
      userMsg("refactor parseConfig"),
      assistantTool("t1", "Read"),
      toolResult("t1", false),
      assistantTool("t2", "Edit"),
      toolResult("t2", true),
    ]
    const history: HistorySessionState = { messages: () => msgs }
    const c = buildCtx(history)
    expect(await runSlashCommand("/history turn 1", c.ctx)).toBe(0)
    expect(c.out).toContain("Turn 1")
    expect(c.out).toContain("refactor parseConfig")
    expect(c.out).toContain(" 1. ✓ Read")
    expect(c.out).toContain(" 2. ✗ Edit")
  })
})

/* ------------------------------------------------------------------ */
/* registry surface                                                    */
/* ------------------------------------------------------------------ */

describe("/history registry hooks", () => {
  test("historyCmd exposes the documented metadata", () => {
    expect(historyCmd.name).toBe("/history")
    expect(historyCmd.category).toBe("history")
    expect(historyCmd.describe).toContain("turns")
  })
})
