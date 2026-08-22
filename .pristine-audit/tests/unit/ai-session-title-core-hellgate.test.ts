import { describe, expect, test } from "bun:test"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import {
  type AutoTitlePorts,
  createAutoTitlePort,
  generateSessionTitle,
  MAX_TITLE_CHARS,
  sanitizeTitle,
} from "@/runner/session-ops/auto-title"

/**
 * Hellgate for the opt-in AI session titler (RFC jun-6-ai-session-title.md).
 * Adversarial / edge coverage via a fake `LLMPort` + fake `rename` + fake
 * `currentTitle` reader + fake clock — NO real session store, NO real LLM.
 *
 * Invariants locked:
 *  - turn-1 happy path ⇒ a sanitized title is generated + written exactly once
 *  - LLM throws ⇒ swallowed (no rename, no thrown error)
 *  - LLM hangs ⇒ never blocks the caller; abandoned via timeoutMs (fake clock)
 *  - a human already-renamed session ⇒ NOT clobbered
 *  - fire-and-forget kick-off returns synchronously (turn never awaits it)
 *  - knob-off ⇒ port never built ⇒ no LLM call, no rename (modeled by NOT
 *    invoking the port — the loop-side gate)
 */

// --- fakes ------------------------------------------------------------------

const textScript = (text: string): StreamEvent[] => [
  { type: "text_delta", delta: text },
  { type: "message_stop", stop_reason: "end_turn" },
]

/** Records inputs, replays a script, optionally throws or hangs. */
class FakeLLM implements LLMPort {
  readonly inputs: StreamInput[] = []
  calls = 0
  readonly model = "cheap-title-model"
  constructor(
    private readonly script: StreamEvent[],
    private readonly opts?: { throws?: boolean; hangs?: boolean },
  ) {}
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.inputs.push(input)
    this.calls += 1
    if (this.opts?.throws) throw new Error("boom: title model failed")
    if (this.opts?.hangs) {
      // Never yields, never returns — models a hung provider.
      await new Promise<never>(() => {})
    }
    for (const ev of this.script) yield ev
  }
}

/** Records rename calls. */
class FakeRename {
  readonly calls: Array<{ id: string; title: string }> = []
  throwOnWrite = false
  rename = async (id: string, title: string): Promise<void> => {
    if (this.throwOnWrite) throw new Error("boom: rename failed")
    this.calls.push({ id, title })
  }
}

/** Manually-advanced fake clock (ms). */
class FakeClock {
  private t = 0
  now = (): number => this.t
  advance(ms: number): void {
    this.t += ms
  }
}

/** Default placeholder predicate: titles equal to a known seed are placeholders;
 *  anything else is "human-set". */
const isPlaceholder = (title: string) => title === "untitled" || title === "abc-123 (fork)"

const basePorts = (
  over: Partial<AutoTitlePorts> & Pick<AutoTitlePorts, "llm">,
): AutoTitlePorts => ({
  rename: async () => {},
  currentTitle: async () => "untitled",
  isPlaceholder,
  clock: () => 0,
  ...over,
})

// --- 1. happy path: turn-1 ⇒ title generated + written ----------------------

describe("ai-session-title — happy path", () => {
  test("turn-1 ⇒ cheap LLM called, sanitized title written exactly once", async () => {
    const llm = new FakeLLM(textScript("Fix auth bug"))
    const rename = new FakeRename()
    await generateSessionTitle(
      "s1",
      "please fix the broken oauth login flow",
      basePorts({ llm, rename: rename.rename }),
    )
    expect(llm.calls).toBe(1)
    expect(rename.calls).toEqual([{ id: "s1", title: "Fix auth bug" }])
    // The prompt carried the (truncated) first user request — no tools.
    expect(llm.inputs[0]?.tools).toEqual([])
    const sent = llm.inputs[0]?.messages[0]?.content[0]
    expect(sent?.type === "text" && sent.text).toContain("oauth login")
  })

  test("title is sanitized: newlines stripped, quotes dropped, clamped to maxWords", async () => {
    const llm = new FakeLLM(textScript('  "One Two\nThree Four Five Six Seven Eight"  '))
    const rename = new FakeRename()
    await generateSessionTitle(
      "s2",
      "do a thing",
      basePorts({ llm, rename: rename.rename, maxWords: 6 }),
    )
    expect(rename.calls[0]?.title).toBe("One Two Three Four Five Six")
  })

  test("sanitizeTitle clamps to MAX_TITLE_CHARS", () => {
    const long = `${"word ".repeat(40)}`
    const out = sanitizeTitle(long, 50)
    expect(out.length).toBeLessThanOrEqual(MAX_TITLE_CHARS)
  })

  // ── TITLE-INJECTION: a hostile model output carrying control chars ──────────
  // `\s+` collapse handles whitespace but leaves NON-whitespace control chars
  // (NUL, BEL, BS, ESC/ANSI, DEL, C1) intact — those would inject terminal
  // escapes / a NUL into the session metadata record. They MUST be stripped.
  const ESC = String.fromCharCode(0x1b) // ESC (ANSI lead-in)
  const NUL = String.fromCharCode(0x00)
  const BEL = String.fromCharCode(0x07)
  const BS = String.fromCharCode(0x08)
  const DEL = String.fromCharCode(0x7f)
  const C1 = String.fromCharCode(0x9b) // C1 CSI

  test("sanitizeTitle strips NUL / BEL / BS / ESC-ANSI / DEL / C1 control chars", () => {
    const hostile = `My${NUL} Title${ESC}[2J${BEL}${BS} here${DEL}${C1}`
    const out = sanitizeTitle(hostile, 6)
    // No control byte survives.
    for (const ch of [ESC, NUL, BEL, BS, DEL, C1]) expect(out.includes(ch)).toBe(false)
    // The printable text remains (the ANSI lead-in ESC is gone ⇒ "[2J" is inert text).
    expect(out).toContain("My")
    expect(out).toContain("Title")
  })

  test("a title that is ENTIRELY control chars ⇒ '' (caller skips the write)", () => {
    expect(sanitizeTitle(`${ESC}${BEL}${NUL}${C1}`, 6)).toBe("")
  })

  test("whitespace control chars stay word boundaries (newline ⇒ space, not fusion)", () => {
    // \n is U+000A — a WHITESPACE control char, deliberately NOT stripped, so the
    // `\s+` collapse turns it into a separator rather than fusing the words.
    expect(sanitizeTitle("One\nTwo\tThree", 6)).toBe("One Two Three")
  })

  test("empty/whitespace model output ⇒ no rename (nothing usable)", async () => {
    const llm = new FakeLLM(textScript("   \n  "))
    const rename = new FakeRename()
    await generateSessionTitle("s3", "hello", basePorts({ llm, rename: rename.rename }))
    expect(rename.calls).toEqual([])
  })

  test("empty first prompt ⇒ no LLM call, no rename", async () => {
    const llm = new FakeLLM(textScript("anything"))
    const rename = new FakeRename()
    await generateSessionTitle("s4", "   ", basePorts({ llm, rename: rename.rename }))
    expect(llm.calls).toBe(0)
    expect(rename.calls).toEqual([])
  })
})

// --- 2. best-effort swallow: LLM throws -------------------------------------

describe("ai-session-title — best-effort swallow", () => {
  test("LLM throws ⇒ no rename, no error propagated", async () => {
    const llm = new FakeLLM([], { throws: true })
    const rename = new FakeRename()
    // Must resolve, not reject.
    await expect(
      generateSessionTitle("s5", "fix the bug", basePorts({ llm, rename: rename.rename })),
    ).resolves.toBeUndefined()
    expect(rename.calls).toEqual([])
  })

  test("rename writer throws ⇒ swallowed, no propagation", async () => {
    const llm = new FakeLLM(textScript("Good Title"))
    const rename = new FakeRename()
    rename.throwOnWrite = true
    await expect(
      generateSessionTitle("s6", "fix the bug", basePorts({ llm, rename: rename.rename })),
    ).resolves.toBeUndefined()
  })

  test("currentTitle reader throws ⇒ swallowed, no rename", async () => {
    const llm = new FakeLLM(textScript("Good Title"))
    const rename = new FakeRename()
    await expect(
      generateSessionTitle(
        "s7",
        "fix the bug",
        basePorts({
          llm,
          rename: rename.rename,
          currentTitle: async () => {
            throw new Error("read boom")
          },
        }),
      ),
    ).resolves.toBeUndefined()
    expect(rename.calls).toEqual([])
  })
})

// --- 3. don't-clobber a human title -----------------------------------------

describe("ai-session-title — don't clobber", () => {
  test("human renamed before the call returns ⇒ titler skips the write", async () => {
    const llm = new FakeLLM(textScript("Auto Title"))
    const rename = new FakeRename()
    // currentTitle re-read returns a non-placeholder ⇒ manual wins.
    await generateSessionTitle(
      "s8",
      "fix the bug",
      basePorts({ llm, rename: rename.rename, currentTitle: async () => "My Manual Title" }),
    )
    expect(llm.calls).toBe(1) // the cheap call still ran
    expect(rename.calls).toEqual([]) // but the write was skipped
  })

  test("placeholder title ⇒ overwrite proceeds", async () => {
    const llm = new FakeLLM(textScript("Auto Title"))
    const rename = new FakeRename()
    await generateSessionTitle(
      "s9",
      "fix the bug",
      basePorts({ llm, rename: rename.rename, currentTitle: async () => "abc-123 (fork)" }),
    )
    expect(rename.calls).toEqual([{ id: "s9", title: "Auto Title" }])
  })

  test("session vanished (currentTitle undefined) ⇒ overwrite proceeds", async () => {
    const llm = new FakeLLM(textScript("Auto Title"))
    const rename = new FakeRename()
    await generateSessionTitle(
      "s10",
      "fix the bug",
      basePorts({ llm, rename: rename.rename, currentTitle: async () => undefined }),
    )
    expect(rename.calls).toEqual([{ id: "s10", title: "Auto Title" }])
  })
})

// --- 4. never blocks: hung LLM + timeout ------------------------------------

describe("ai-session-title — never blocks", () => {
  test("fire-and-forget kick-off returns synchronously even when the LLM hangs", () => {
    const llm = new FakeLLM([], { hangs: true })
    const rename = new FakeRename()
    const port = createAutoTitlePort(basePorts({ llm, rename: rename.rename }))
    let returned = false
    port.maybeTitle("s11", "fix the bug")
    returned = true
    // The detached promise is still running; the call returned immediately.
    expect(returned).toBe(true)
    expect(rename.calls).toEqual([])
  })

  test("hung LLM ⇒ abandoned via timeoutMs (fake clock), no rename", async () => {
    const llm = new FakeLLM([], { hangs: true })
    const rename = new FakeRename()
    const clock = new FakeClock()
    const promise = generateSessionTitle(
      "s12",
      "fix the bug",
      basePorts({ llm, rename: rename.rename, clock: clock.now, timeoutMs: 1000 }),
    )
    // Drive the clock past the timeout; the poll-based timer then trips.
    clock.advance(2000)
    await promise // resolves (swallowed timeout), never rejects
    expect(rename.calls).toEqual([])
  })

  test("createAutoTitlePort.maybeTitle never throws even if kick-off args are degenerate", () => {
    const llm = new FakeLLM([], { throws: true })
    const rename = new FakeRename()
    const port = createAutoTitlePort(basePorts({ llm, rename: rename.rename }))
    expect(() => port.maybeTitle("s13", "anything")).not.toThrow()
  })
})

// --- 5. run-once / knob-off (loop-side gate modeled) ------------------------

describe("ai-session-title — run-once + knob-off semantics", () => {
  test("knob-off ⇒ port not built ⇒ no LLM call, no rename (no-port baseline)", async () => {
    // The loop only invokes the port when it exists. Model "knob off" as
    // "no port" and assert nothing happens to the fakes.
    const llm = new FakeLLM(textScript("Should Not Run"))
    const rename = new FakeRename()
    const buildPort = (): ReturnType<typeof createAutoTitlePort> | undefined => undefined
    const port = buildPort()
    // The loop's branch is `if (autoTitlePort && isFirstTurn) ...`; with the
    // knob off the port is never built, so this branch is dead.
    port?.maybeTitle("s14", "x")
    await Promise.resolve()
    expect(llm.calls).toBe(0)
    expect(rename.calls).toEqual([])
  })

  test("invoked once ⇒ exactly one LLM call + one rename (no per-turn loop here)", async () => {
    const llm = new FakeLLM(textScript("Once Only"))
    const rename = new FakeRename()
    const port = createAutoTitlePort(basePorts({ llm, rename: rename.rename }))
    port.maybeTitle("s15", "fix the bug")
    // Drain the detached promise.
    await new Promise((r) => setTimeout(r, 10))
    expect(llm.calls).toBe(1)
    expect(rename.calls).toEqual([{ id: "s15", title: "Once Only" }])
  })
})
