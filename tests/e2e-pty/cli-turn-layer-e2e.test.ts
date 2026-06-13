/**
 * CLI e2e (PTY) — TURN-LAYER over a real pseudo-terminal + deterministic replay
 * (jun-11 P3). Submits a real prompt, driving the agent loop with a hand-authored
 * `QUANTA_LLM_REPLAY` cassette (no API key / no network), and asserts the streamed
 * output renders correctly. Proves #11 end-to-end: an LLM `thinking_delta` is now
 * shown (DIM) instead of being dropped (pay-without-display).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { drivePtyCli, PTY_AVAILABLE, type PtyCli } from "./pty-harness"

// Must wait for the readline prompt (rendered AFTER setRawMode) not the
// welcome banner ("Ctrl+C quit", before setRawMode). Sending "\r" while the
// PTY is still in cooked mode causes the kernel to convert it to "\n", which
// raw-line-reader drops — the readline never submits (~30% flake otherwise).
const BOOT = "ask before every edit"
const T = 30_000

// One-turn cassette: reasoning summary (thinking) → answer (text) → end. The
// factory's replay hook pins the request hash to "replay", so `id:"replay"` matches.
const CASSETTE = `${JSON.stringify({
  id: "replay",
  events: [
    { type: "thinking_delta", text: "REASONING_TRACE weighing the options" },
    { type: "text_delta", delta: "ANSWER the result is 42" },
    { type: "usage", inputTokens: 100, outputTokens: 20, model: "replay" },
    { type: "message_stop", stop_reason: "end_turn" },
  ],
})}\n`

// Simple single-turn cassette: text answer → usage → stop.
const CASSETTE_SIMPLE = `${JSON.stringify({
  id: "replay",
  events: [
    { type: "text_delta", delta: "SIMPLE_ANSWER the result is 7" },
    { type: "usage", inputTokens: 100, outputTokens: 20, model: "replay" },
    { type: "message_stop", stop_reason: "end_turn" },
  ],
})}\n`

// Multi-entry cassette for #13. Two entries: one per session. With
// QUANTA_MEMORY=off there is no store → persistSession is skipped → zero
// background LLM calls between sessions, so exactly 2 entries suffice.
const mkReplayEntry = (): string =>
  JSON.stringify({
    id: "replay",
    events: [
      { type: "text_delta", delta: "MULTI_DONE" },
      { type: "usage", inputTokens: 50, outputTokens: 5, model: "replay" },
      { type: "message_stop", stop_reason: "end_turn" },
    ],
  })

const CASSETTE_MULTI = [mkReplayEntry(), mkReplayEntry()].join("\n") + "\n"

describe.skipIf(!PTY_AVAILABLE)("CLI turn-layer e2e (PTY + replay)", () => {
  let dir: string
  let cli: PtyCli | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "e2e-pty-turn-"))
  })
  afterEach(() => {
    cli?.kill()
    cli = undefined
    rmSync(dir, { recursive: true, force: true })
  })

  test(
    "#11 a replayed thinking_delta is rendered (was dropped before)",
    async () => {
      const cassette = join(dir, "cassette.jsonl")
      writeFileSync(cassette, CASSETTE)
      const c = drivePtyCli({
        cwd: dir,
        env: {
          QUANTA_SESSIONS_DIR: join(dir, "sessions"),
          QUANTA_LLM_REPLAY: cassette,
          QUANTA_MEMORY: "off",
          QUANTA_MEMORY_AUTO: "0",
        },
      })
      cli = c
      await c.waitFor(BOOT, 15_000)
      c.send("hello\r") // submit a turn ⇒ the replay drives the agent loop
      // Reasoning trace renders (the #11 fix). Before, thinking_delta was consumed
      // only for TTFT/tokens and never shown.
      await c.waitFor("REASONING_TRACE", 12_000)
      // …and the answer text streams too.
      await c.waitFor("ANSWER the result is 42", 12_000)
      const scr = c.screen()
      // Thinking must precede the answer in the output stream.
      expect(scr.indexOf("REASONING_TRACE")).toBeLessThan(scr.indexOf("ANSWER the result is 42"))
      // Thinking block was rendered DIM (\x1b[2m…\x1b[0m) — visible in raw output.
      expect(c.output()).toMatch(/\x1b\[2m[^\x1b]*REASONING_TRACE/)
    },
    T,
  )

  test(
    "#5/#6 mid-turn typing is captured + echoed in the visible lane DURING a turn",
    async () => {
      // A sustained turn (per-event delay) so there's a window to type during it.
      const cassette = join(dir, "slow.jsonl")
      writeFileSync(
        cassette,
        `${JSON.stringify({
          id: "replay",
          events: [
            { type: "thinking_delta", text: "REASONING start" },
            { type: "text_delta", delta: "one " },
            { type: "text_delta", delta: "two " },
            { type: "text_delta", delta: "three " },
            { type: "text_delta", delta: "DONE_ANSWER" },
            { type: "usage", inputTokens: 1, outputTokens: 1, model: "replay" },
            { type: "message_stop", stop_reason: "end_turn" },
          ],
        })}\n`,
      )
      const c = drivePtyCli({
        cwd: dir,
        env: {
          QUANTA_SESSIONS_DIR: join(dir, "sessions"),
          QUANTA_LLM_REPLAY: cassette,
          QUANTA_LLM_REPLAY_DELAY_MS: "700", // ~5s turn
          QUANTA_MIDTURN_CAPTURE: "1",
          QUANTA_MIDTURN_VISIBLE: "1",
          QUANTA_MEMORY: "off",
          QUANTA_MEMORY_AUTO: "0",
        },
      })
      cli = c
      await c.waitFor(BOOT, 15_000)
      c.send("hello\r") // submit ⇒ sustained turn begins
      await c.waitFor("REASONING start", 12_000) // turn is mid-stream now
      c.send("QUEUEDFOLLOWUP") // type DURING the turn
      // The visible input lane (`» ` prompt, distinct from the between-turns `› `)
      // echoes the mid-turn keystrokes — proving capture (#5) is reading stdin
      // during the turn AND the lane (#6) is rendering it (default-OFF before).
      await c.waitFor("QUEUEDFOLLOWUP", 12_000)
      expect(c.screen()).toContain("»") // the mid-turn lane rendered (not the normal prompt)
      // The turn still completes normally underneath the lane.
      await c.waitFor("DONE_ANSWER", 12_000)
    },
    45_000,
  )

  test(
    "#12 done + compact usage render after a turn",
    async () => {
      const cassette = join(dir, "simple.jsonl")
      writeFileSync(cassette, CASSETTE_SIMPLE)
      const c = drivePtyCli({
        cwd: dir,
        env: {
          QUANTA_SESSIONS_DIR: join(dir, "sessions"),
          QUANTA_LLM_REPLAY: cassette,
          QUANTA_MEMORY: "off",
          QUANTA_MEMORY_AUTO: "0",
        },
      })
      cli = c
      await c.waitFor(BOOT, 15_000)
      c.send("hello\r")
      await c.waitFor("SIMPLE_ANSWER", 12_000)
      // done line: "— done (completed, 1 turns) —"
      await c.waitFor("— done (completed,", 12_000)
      // usage line: "— usage in 100, out 20 (replay) —"
      await c.waitFor("— usage in 100, out 20 (replay) —", 12_000)
    },
    T,
  )

  test(
    "#13 two consecutive prompts each complete (multi-session sequencing)",
    async () => {
      // Each user prompt creates a new session; the shared LLM store consumes
      // entries in order. Extra entries absorb background calls between sessions
      // (e.g. compaction summarizer). Proves the REPL handles sequential prompts
      // without hanging or losing the second session's reply.
      const cassette = join(dir, "multi.jsonl")
      writeFileSync(cassette, CASSETTE_MULTI)
      const c = drivePtyCli({
        cwd: dir,
        env: {
          QUANTA_SESSIONS_DIR: join(dir, "sessions"),
          QUANTA_LLM_REPLAY: cassette,
          QUANTA_MEMORY: "off",
          QUANTA_MEMORY_AUTO: "0",
        },
      })
      cli = c
      await c.waitFor(BOOT, 15_000)
      c.send("hello\r") // prompt 1 — starts first session
      await c.waitFor("MULTI_DONE", 12_000) // LLM replied
      // Wait for "done" AND the second readline prompt in the same waitFor.
      // After turn 1 ends, runOneTurn's finally calls cancel.dispose() which
      // resets setRawMode(false); the second readLine re-sets it to true BEFORE
      // calling redraw(). Waiting for both patterns guarantees raw mode is active
      // before we send "world\r", so \r isn't cooked into \n by the PTY.
      await c.waitFor(/— done \(completed,[\s\S]*ask before every edit/, 12_000)
      c.send("world\r") // prompt 2 — starts second session
      // Wait for "done" to appear a SECOND time in the accumulated buffer.
      await c.waitFor(
        /— done \(completed,.*\n.*— done \(completed,/s,
        12_000,
      )
    },
    T,
  )

  test(
    "#14 error line renders when LLM cassette is exhausted",
    async () => {
      // A cassette with no entries → every LLM call is a miss → ReplayMissError
      // → agent loop emits { type:"error" } → stdout renders "error: ...".
      const cassette = join(dir, "empty.jsonl")
      writeFileSync(cassette, "")
      const c = drivePtyCli({
        cwd: dir,
        env: {
          QUANTA_SESSIONS_DIR: join(dir, "sessions"),
          QUANTA_LLM_REPLAY: cassette,
          QUANTA_MEMORY: "off",
          QUANTA_MEMORY_AUTO: "0",
        },
      })
      cli = c
      await c.waitFor(BOOT, 15_000)
      c.send("hello\r")
      await c.waitFor("error:", 12_000)
    },
    T,
  )
})
