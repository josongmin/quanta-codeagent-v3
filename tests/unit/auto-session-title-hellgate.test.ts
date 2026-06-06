/**
 * jun-6 — AI session-title hellgate (RFC docs/plans/jun-6-ai-session-title.md).
 *
 * Two highest-value pins called out as MUST-NOT in the spec:
 *
 *   TURN-BLOCK — `maybeTitle` MUST return synchronously; a hung/slow LLM can
 *     never delay or fail the user's turn. Proven by a never-resolving fake LLM:
 *     the kick-off returns before the LLM stream ever yields.
 *
 *   ONCE-ONLY (never per-turn) — `runSessionStartSequence` runs on EVERY
 *     `runAgent` call, and the interactive surface calls `runAgent` once PER
 *     TURN with the full accumulated history. A naive "latest user text" fire
 *     would kick the cheap title LLM on EVERY turn (surprise spend — exactly the
 *     "never per-turn" the RFC forbids). The loop now pins the fire to the
 *     OPENING turn (exactly one user message in working memory). This battery
 *     drives the REAL `runAgent` loop and asserts: single-user-message config ⇒
 *     fires once; multi-user-message config (a resumed / turn-2 transcript) ⇒
 *     NEVER fires.
 *
 * Plus the leaf-level invariants: don't-clobber (re-read before write), all
 * failures swallowed (LLM/timeout/rename/read throw), title sanitization
 * (control chars / newlines / unbounded length), knob-off ⇒ no LLM call.
 */

import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { runAgent } from "@/agent"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import type { PermissionContext } from "@/permission"
import {
  type AutoTitlePort,
  type AutoTitlePorts,
  createAutoTitlePort,
  generateSessionTitle,
  MAX_TITLE_CHARS,
  sanitizeTitle,
} from "@/runner/session-ops/auto-title"
import type { AgentEvent, StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"

// ───────────────────────────── fakes ──────────────────────────────────────────

/** Emit text via `text_delta` so `assembleFromEvents` reconstructs it. */
const textStream = (text: string): StreamEvent[] => [
  { type: "text_delta", delta: text },
  { type: "message_stop", stop_reason: "end_turn" },
]

/** A title LLM that yields a fixed title once. */
class TitleLLM implements LLMPort {
  calls = 0
  constructor(private readonly title: string) {}
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    for (const ev of textStream(this.title)) yield ev
  }
}

/** An LLM whose stream NEVER yields (hangs forever) — proves no-block. */
class HangingLLM implements LLMPort {
  calls = 0
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    await new Promise<never>(() => {}) // never resolves
  }
}

/** An LLM that throws synchronously on stream() — proves swallow. */
class ThrowingLLM implements LLMPort {
  // biome-ignore lint/correctness/useYield: throws before any yield (proves swallow)
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    throw new Error("llm down")
  }
}

/** Minimal port bundle; individual tests override slots. */
const ports = (over: Partial<AutoTitlePorts> & { llm: LLMPort }): AutoTitlePorts => ({
  rename: async () => {},
  currentTitle: async () => "Untitled",
  isPlaceholder: (t) => t === "Untitled" || t === "" || t.startsWith("session-"),
  clock: () => 0,
  ...over,
})

// ════════════════════════════ leaf: no-block ══════════════════════════════════

describe("auto-title · TURN-BLOCK guard (the #1 pin)", () => {
  test("maybeTitle returns SYNCHRONOUSLY even when the LLM hangs forever", () => {
    const llm = new HangingLLM()
    const writes: string[] = []
    const port: AutoTitlePort = createAutoTitlePort(
      ports({ llm, rename: async (_id, t) => void writes.push(t) }),
    )
    // If maybeTitle awaited the LLM this would hang the test. It must return now.
    const before = Date.now()
    port.maybeTitle("s1", "build me a web server")
    const after = Date.now()
    expect(after - before).toBeLessThan(50) // returned immediately, did not await
    expect(writes).toEqual([]) // nothing written yet (and never will be)
  })

  test("a synchronous kick-off throw is swallowed (never escapes into the loop)", () => {
    // A port whose llm.stream throws on the FIRST synchronous tick still must
    // not surface out of maybeTitle.
    const port = createAutoTitlePort(ports({ llm: new ThrowingLLM() }))
    expect(() => port.maybeTitle("s1", "do a thing")).not.toThrow()
  })
})

// ════════════════════════════ leaf: don't-clobber ═════════════════════════════

describe("auto-title · don't-clobber (re-read before write)", () => {
  test("placeholder title ⇒ the generated title is written", async () => {
    const llm = new TitleLLM("Build A Web Server")
    const writes: Array<[string, string]> = []
    await generateSessionTitle(
      "s1",
      "build me a web server",
      ports({ llm, rename: async (id, t) => void writes.push([id, t]) }),
    )
    expect(writes).toEqual([["s1", "Build A Web Server"]])
    expect(llm.calls).toBe(1)
  })

  test("a HUMAN rename that landed mid-flight is NOT clobbered", async () => {
    const llm = new TitleLLM("Auto Generated Name")
    const writes: string[] = []
    await generateSessionTitle(
      "s1",
      "first prompt",
      ports({
        llm,
        // The re-read returns a NON-placeholder ⇒ a human already named it.
        currentTitle: async () => "My Important Refactor",
        rename: async (_id, t) => void writes.push(t),
      }),
    )
    expect(writes).toEqual([]) // human title preserved, auto-title yields
  })

  test("currentTitle returning undefined (session gone) ⇒ still writes (no false-positive clobber)", async () => {
    const llm = new TitleLLM("New Title")
    const writes: string[] = []
    await generateSessionTitle(
      "s1",
      "p",
      ports({
        llm,
        currentTitle: async () => undefined,
        rename: async (_i, t) => void writes.push(t),
      }),
    )
    expect(writes).toEqual(["New Title"])
  })
})

// ════════════════════════════ leaf: swallow everything ════════════════════════

describe("auto-title · every failure swallowed (no crash, no propagation)", () => {
  test("LLM throw ⇒ resolves void, no write", async () => {
    const writes: string[] = []
    await expect(
      generateSessionTitle(
        "s1",
        "p",
        ports({ llm: new ThrowingLLM(), rename: async (_i, t) => void writes.push(t) }),
      ),
    ).resolves.toBeUndefined()
    expect(writes).toEqual([])
  })

  test("rename throw ⇒ swallowed", async () => {
    await expect(
      generateSessionTitle(
        "s1",
        "p",
        ports({
          llm: new TitleLLM("Some Title"),
          rename: async () => {
            throw new Error("disk full")
          },
        }),
      ),
    ).resolves.toBeUndefined()
  })

  test("currentTitle (re-read) throw ⇒ swallowed", async () => {
    await expect(
      generateSessionTitle(
        "s1",
        "p",
        ports({
          llm: new TitleLLM("Some Title"),
          currentTitle: async () => {
            throw new Error("read fault")
          },
        }),
      ),
    ).resolves.toBeUndefined()
  })

  test("empty prompt ⇒ no LLM call, no write", async () => {
    const llm = new TitleLLM("X")
    const writes: string[] = []
    await generateSessionTitle(
      "s1",
      "   ",
      ports({ llm, rename: async (_i, t) => void writes.push(t) }),
    )
    expect(llm.calls).toBe(0)
    expect(writes).toEqual([])
  })

  test("model emits a raw ANSI escape ⇒ ESC introducer is stripped, no control char survives the write", async () => {
    const llm = new TitleLLM("\u0000\u001b[2JTitle\u0007 ")
    const writes: string[] = []
    await generateSessionTitle(
      "s1",
      "p",
      ports({ llm, rename: async (_i, t) => void writes.push(t) }),
    )
    for (const w of writes) {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: pin NO control char survives
      expect(w).not.toMatch(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/)
    }
  })
})

// ════════════════════════════ leaf: sanitization ══════════════════════════════

describe("auto-title · sanitizeTitle (transcript-corruption defense)", () => {
  test("strips NUL / BEL / ESC (ANSI) control chars — no terminal-escape injection", () => {
    const out = sanitizeTitle("Build\u001b[2Ja\u0007Server\u0000", 6)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting control chars are gone
    expect(out).not.toMatch(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/)
    expect(out).toContain("Build")
  })

  test("strips Trojan-Source bidi controls + zero-width formatters (visual-spoof defense)", () => {
    // The C0/C1 sweep does NOT cover these (they are > U+009F and not
    // whitespace), so a malicious first prompt / compromised cheap title model
    // could otherwise write a title that visually misrepresents itself in the
    // session list (CVE-2021-42574 / Trojan-Source class). Build the inputs from
    // code points so the test source stays ASCII-clean and grep-safe.
    const TARGETS = [
      0x061c, // ARABIC LETTER MARK
      0x200b, // ZERO WIDTH SPACE
      0x200c, // ZERO WIDTH NON-JOINER
      0x200d, // ZERO WIDTH JOINER
      0x200e, // LEFT-TO-RIGHT MARK
      0x200f, // RIGHT-TO-LEFT MARK
      0x2060, // WORD JOINER
      0x202a, // LRE
      0x202b, // RLE
      0x202c, // POP DIRECTIONAL FORMATTING
      0x202d, // LRO
      0x202e, // RLO (the classic Trojan-Source override)
      0x2066, // LRI
      0x2067, // RLI
      0x2068, // FSI
      0x2069, // PDI
      0xfeff, // ZERO WIDTH NO-BREAK SPACE / BOM
    ]
    // Each target, individually, must be removed (and the visible text kept).
    for (const cp of TARGETS) {
      const out = sanitizeTitle(`Ship${String.fromCharCode(cp)}It`, 6)
      expect(out).not.toContain(String.fromCharCode(cp))
      expect(out.replace(/\s+/g, "")).toBe("ShipIt")
    }
    // And all of them interleaved at once → ZERO invisibles survive.
    let mixed = "X"
    for (const cp of TARGETS) mixed += `${String.fromCharCode(cp)}Y`
    const out = sanitizeTitle(mixed, 20)
    expect(out).toMatch(/^[XY ]+$/)
    expect([...out].some((ch) => TARGETS.includes(ch.charCodeAt(0)))).toBe(false)
  })

  test("keeps legitimate non-ASCII (CJK / emoji) untouched — strip is targeted", () => {
    expect(sanitizeTitle("빌드 서버 설정", 6)).toBe("빌드 서버 설정")
    expect(sanitizeTitle("Fix 🚀 bug", 6)).toBe("Fix 🚀 bug")
  })

  test("collapses newlines/tabs to single spaces (no multi-line metadata)", () => {
    const out = sanitizeTitle("Line one\nLine\ttwo\r\nthree", 10)
    expect(out).not.toContain("\n")
    expect(out).not.toContain("\t")
    expect(out).toBe("Line one Line two three")
  })

  test("clamps to maxWords", () => {
    expect(sanitizeTitle("one two three four five six seven eight", 3)).toBe("one two three")
  })

  test("clamps a runaway title to MAX_TITLE_CHARS (unbounded-write defense)", () => {
    const huge = `${"word ".repeat(1000)}`
    const out = sanitizeTitle(huge, 10_000)
    expect(out.length).toBeLessThanOrEqual(MAX_TITLE_CHARS)
  })

  test("strips wrapping quotes the model often adds", () => {
    expect(sanitizeTitle('"Quoted Title"', 6)).toBe("Quoted Title")
    expect(sanitizeTitle("`Backtick Title`", 6)).toBe("Backtick Title")
  })

  test("empty / whitespace-only ⇒ empty string (caller then skips)", () => {
    expect(sanitizeTitle("", 6)).toBe("")
    expect(sanitizeTitle("   \n\t  ", 6)).toBe("")
  })
})

// ════════════════════════════ loop wire: ONCE-ONLY ════════════════════════════
//
// Drive the REAL runAgent loop. A counting AutoTitlePort proves the fire is
// pinned to the OPENING turn (one user message), NOT every turn.

class CountingTitlePort implements AutoTitlePort {
  readonly calls: Array<{ sessionId: string; firstPrompt: string }> = []
  maybeTitle(sessionId: string, firstPrompt: string): void {
    this.calls.push({ sessionId, firstPrompt })
  }
}

class TurnLLM implements LLMPort {
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: "ok" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

class CollectStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(e: AgentEvent): void {
    this.events.push(e)
  }
}

const loopConfig = (messages: Message[], titlePort: AutoTitlePort | undefined): AgentConfig => ({
  llm: new TurnLLM(),
  registry: new ToolRegistry(defaultTools),
  stream: new CollectStream(),
  permission: { mode: "acceptEdits" } as PermissionContext,
  messages,
  system: "test",
  cwd: process.cwd(),
  maxTurns: 3,
  signal: new AbortController().signal,
  onConfirm: async () => false,
  sessionId: "sess-1",
  ...(titlePort !== undefined ? { autoTitlePort: titlePort } : {}),
})

const userMsg = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] })
const asstMsg = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
})

describe("auto-title · LOOP WIRE — ONCE-ONLY, never per-turn (the #2 pin)", () => {
  test("OPENING turn (single user message) ⇒ maybeTitle fires EXACTLY ONCE with the first prompt", async () => {
    const port = new CountingTitlePort()
    await runAgent(loopConfig([userMsg("build a web server")], port))
    expect(port.calls).toEqual([{ sessionId: "sess-1", firstPrompt: "build a web server" }])
  })

  test("TURN 2+ (history already holds 2 user messages) ⇒ maybeTitle NEVER fires (no per-turn spend)", async () => {
    const port = new CountingTitlePort()
    // A resumed transcript: prior turn (user+assistant) + the new user prompt.
    await runAgent(
      loopConfig(
        [userMsg("the original first prompt"), asstMsg("ok"), userMsg("a second-turn follow-up")],
        port,
      ),
    )
    expect(port.calls).toEqual([]) // not the opening turn ⇒ no title call at all
  })

  test("absent port (knob-off) ⇒ NO title machinery touched (byte-identical)", async () => {
    // No autoTitlePort on the config ⇒ the loop branch is dead. The run still
    // completes normally. (A CountingTitlePort is intentionally NOT supplied.)
    const out = await runAgent(loopConfig([userMsg("hi")], undefined))
    expect(out.reason).toBe("completed")
  })

  test("opening turn but EMPTY first prompt ⇒ maybeTitle NOT fired", async () => {
    const port = new CountingTitlePort()
    await runAgent(loopConfig([userMsg("   ")], port))
    expect(port.calls).toEqual([])
  })
})
