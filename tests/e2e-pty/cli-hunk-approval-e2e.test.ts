/**
 * CLI e2e (PTY) — T05 per-hunk diff accept/reject, end-to-end over the REAL
 * REPL → stdin → mid-turn channel → gate → `@/runner/hunk-apply` wiring.
 *
 * A deterministic `QUANTA_LLM_REPLAY` cassette emits a `write` TOOL_USE that
 * rewrites an existing 7-line file with TWO separated changes (line2 + line6 ⇒
 * two hunks). The operator opens the `[h]unk-select` picker and accepts ONLY
 * hunk 1, so:
 *   UC1 — line2's change lands on disk; line6 stays at its ORIGINAL value
 *         (FRESH-READBACK from the temp file, not a screen scrape).
 *   UC3 — control: with QUANTA_HUNK_APPROVAL unset, NO `[h]` verb is offered
 *         (byte-identical pre-T05 prompt).
 *
 * These exercise the SAME `buildCliOnConfirm` path the unit hellgates pin, but
 * over the live raw-mode terminal so the verb/picker/executor really connect.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { drivePtyCli, PTY_AVAILABLE, type PtyCli } from "./pty-harness"

const BOOT = "ask before every edit"
const T = 60_000

const ORIGINAL = ["line1", "line2", "line3", "line4", "line5", "line6", "line7"].join("\n")
const PROPOSED = ["line1", "CHANGED2", "line3", "line4", "line5", "CHANGED6", "line7"].join("\n")

/** One assistant turn: a `write` that proposes BOTH changes, then (after the
 *  partial apply denies the whole-call with a steer) a final text turn so the
 *  loop has an entry to consume for the steer-injected follow-up round. */
const WRITE_CASSETTE =
  [
    {
      id: "replay",
      events: [
        { type: "tool_use_start", id: "call_w1", name: "write" },
        { type: "tool_use_end", id: "call_w1", input: { path: "f.txt", content: PROPOSED } },
        { type: "usage", inputTokens: 10, outputTokens: 5, model: "replay" },
        { type: "message_stop", stop_reason: "tool_use" },
      ],
    },
    {
      id: "replay",
      events: [
        { type: "text_delta", delta: "HUNK_FLOW_DONE" },
        { type: "usage", inputTokens: 10, outputTokens: 5, model: "replay" },
        { type: "message_stop", stop_reason: "end_turn" },
      ],
    },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n") + "\n"

describe.skipIf(!PTY_AVAILABLE)("CLI per-hunk approval e2e (PTY + replay)", () => {
  let dir: string
  let cli: PtyCli | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "e2e-pty-hunk-"))
  })
  afterEach(() => {
    cli?.kill()
    cli = undefined
    rmSync(dir, { recursive: true, force: true })
  })

  test(
    "UC1 accepting only hunk 1 lands line2's change; line6 stays original (fresh-readback)",
    async () => {
      const target = join(dir, "f.txt")
      writeFileSync(target, ORIGINAL)
      const cassette = join(dir, "write.jsonl")
      writeFileSync(cassette, WRITE_CASSETTE)
      const c = drivePtyCli({
        cwd: dir,
        env: {
          QUANTA_SESSIONS_DIR: join(dir, "sessions"),
          QUANTA_LLM_REPLAY: cassette,
          QUANTA_MEMORY: "off",
          QUANTA_MEMORY_AUTO: "0",
          QUANTA_ENABLE_PROMPT_SUGGESTION: "0",
          QUANTA_HUNK_APPROVAL: "1",
        },
      })
      cli = c
      await c.waitFor(BOOT, 25_000)
      c.send("please write\r")
      await c.waitFor("Allow write?", 25_000)
      // The per-hunk verb is offered because the diff has ≥2 hunks + knob ON.
      await c.waitFor("[h]unk-select", 20_000)
      c.send("h\r")
      // The picker lists the hunks and asks which to accept.
      await c.waitFor("Accept which hunks?", 20_000)
      c.send("1\r")
      await c.waitFor("HUNK_FLOW_DONE", 25_000)

      // FRESH-READBACK from disk — the authority, not the screen.
      const onDisk = readFileSync(target, "utf8")
      expect(onDisk).toContain("CHANGED2") // hunk 1 accepted → landed
      expect(onDisk).not.toContain("CHANGED6") // hunk 2 rejected → NOT landed
      expect(onDisk).toContain("line6") // original line6 retained
      expect(onDisk).toBe(
        ["line1", "CHANGED2", "line3", "line4", "line5", "line6", "line7"].join("\n"),
      )
    },
    T,
  )

  test(
    "UC3 control: with QUANTA_HUNK_APPROVAL unset, no [h] verb is offered (byte-identical)",
    async () => {
      const target = join(dir, "f.txt")
      writeFileSync(target, ORIGINAL)
      const cassette = join(dir, "write.jsonl")
      writeFileSync(cassette, WRITE_CASSETTE)
      const c = drivePtyCli({
        cwd: dir,
        env: {
          QUANTA_SESSIONS_DIR: join(dir, "sessions"),
          QUANTA_LLM_REPLAY: cassette,
          QUANTA_MEMORY: "off",
          QUANTA_MEMORY_AUTO: "0",
          QUANTA_ENABLE_PROMPT_SUGGESTION: "0",
          // QUANTA_HUNK_APPROVAL deliberately ABSENT.
        },
      })
      cli = c
      await c.waitFor(BOOT, 25_000)
      c.send("please write\r")
      await c.waitFor("Allow write?", 25_000)
      // No per-hunk verb in the prompt. Deny so the turn ends deterministically.
      expect(c.screen()).not.toContain("hunk-select")
      c.send("N\r")
      await c.waitFor("— done", 20_000)
      // Whole-call denied → file untouched.
      expect(readFileSync(target, "utf8")).toBe(ORIGINAL)
    },
    T,
  )
})
