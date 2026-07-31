/**
 * CLI e2e (PTY) — APPROVAL surface, where the user actually lives (jun-11).
 *
 * Drives a REAL pseudo-terminal + a deterministic `QUANTA_LLM_REPLAY` cassette
 * (no API key / no network) whose turn emits a TOOL_USE, so the agent loop hits
 * the live mid-turn confirm prompt. Proves end-to-end:
 *
 *   #19 — a stale `edit` (old_string absent) surfaces the applicability
 *         PRE-FLIGHT warning IN the confirm prompt before the operator answers.
 *   #20 — a `bash` confirm offers the `[p] always \`<program>\` cmds` verb, and
 *         answering `p` mints a session prefix grant a SIBLING `<program>`
 *         command (same turn, same session) then rides WITHOUT re-prompting —
 *         the turn runs to completion on a SINGLE keystroke.
 *
 * These exercise the SAME `buildCliOnConfirm` path the unit hellgates pin, but
 * over the real REPL → stdin → mid-turn channel → controller wiring.
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
const T = 60_000

/** One assistant turn that calls `edit` with an old_string NOT in the file. */
const EDIT_STALE_CASSETTE = `${JSON.stringify({
  id: "replay",
  events: [
    { type: "tool_use_start", id: "call_edit_1", name: "edit" },
    {
      type: "tool_use_end",
      id: "call_edit_1",
      input: { path: "x.ts", old_string: "ANCHOR_NOT_PRESENT", new_string: "z" },
    },
    { type: "usage", inputTokens: 10, outputTokens: 5, model: "replay" },
    { type: "message_stop", stop_reason: "tool_use" },
  ],
})}\n`

/** Three assistant rounds in ONE session: bash `echo` twice (sibling commands),
 *  then a final text turn. Round 2's `echo` must ride the prefix grant minted on
 *  round 1, so the operator answers exactly ONCE. */
const BASH_PREFIX_CASSETTE = `${[
  {
    id: "replay",
    events: [
      { type: "tool_use_start", id: "call_b1", name: "bash" },
      { type: "tool_use_end", id: "call_b1", input: { command: "echo PREFIX_ONE" } },
      { type: "usage", inputTokens: 10, outputTokens: 5, model: "replay" },
      { type: "message_stop", stop_reason: "tool_use" },
    ],
  },
  {
    id: "replay",
    events: [
      { type: "tool_use_start", id: "call_b2", name: "bash" },
      { type: "tool_use_end", id: "call_b2", input: { command: "echo PREFIX_TWO" } },
      { type: "usage", inputTokens: 10, outputTokens: 5, model: "replay" },
      { type: "message_stop", stop_reason: "tool_use" },
    ],
  },
  {
    id: "replay",
    events: [
      { type: "text_delta", delta: "ALL_DONE_PREFIX" },
      { type: "usage", inputTokens: 10, outputTokens: 5, model: "replay" },
      { type: "message_stop", stop_reason: "end_turn" },
    ],
  },
]
  .map((e) => JSON.stringify(e))
  .join("\n")}\n`

const countOccurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1

describe.skipIf(!PTY_AVAILABLE)("CLI approval preflight + prefix-grant e2e (PTY + replay)", () => {
  let dir: string
  let cli: PtyCli | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "e2e-pty-approval-"))
  })
  afterEach(() => {
    cli?.kill()
    cli = undefined
    rmSync(dir, { recursive: true, force: true })
  })

  test(
    "#19 a stale edit surfaces the pre-flight warning in the confirm prompt",
    async () => {
      writeFileSync(join(dir, "x.ts"), "alpha\nbeta\ngamma\n")
      const cassette = join(dir, "edit.jsonl")
      writeFileSync(cassette, EDIT_STALE_CASSETTE)
      const c = drivePtyCli({
        cwd: dir,
        env: {
          QUANTA_SESSIONS_DIR: join(dir, "sessions"),
          QUANTA_LLM_REPLAY: cassette,
          QUANTA_MEMORY: "off",
          QUANTA_MEMORY_AUTO: "0",
          // The prompt-suggestion call (default-ON) fires an extra single-shot
          // LLM round that would consume a cassette entry and desync the replay.
          QUANTA_ENABLE_PROMPT_SUGGESTION: "0",
        },
      })
      cli = c
      await c.waitFor(BOOT, 25_000)
      c.send("please edit\r")
      // The confirm prompt for the edit appears…
      await c.waitFor("Allow edit?", 25_000)
      // …carrying the #19 pre-flight applicability warning (the old_string is
      // not in the file, so the edit would not apply).
      await c.waitFor("pre-flight", 20_000)
      expect(c.screen().toLowerCase()).toContain("not found")
      // Deny it — the turn ends without applying anything.
      c.send("N\r")
      await c.waitFor("— done", 20_000)
    },
    T,
  )

  test(
    "#20 the [p] prefix verb mints a grant a sibling echo rides (one keystroke)",
    async () => {
      const cassette = join(dir, "bash.jsonl")
      writeFileSync(cassette, BASH_PREFIX_CASSETTE)
      const c = drivePtyCli({
        cwd: dir,
        env: {
          QUANTA_SESSIONS_DIR: join(dir, "sessions"),
          QUANTA_LLM_REPLAY: cassette,
          QUANTA_MEMORY: "off",
          QUANTA_MEMORY_AUTO: "0",
          QUANTA_ENABLE_PROMPT_SUGGESTION: "0", // keep the replay in lock-step
        },
      })
      cli = c
      await c.waitFor(BOOT, 25_000)
      c.send("run echo\r")
      // The bash confirm offers the prefix verb naming the program token.
      await c.waitFor("Allow bash?", 25_000)
      await c.waitFor("[p] always `echo` cmds", 20_000)
      // Answer ONCE with the prefix verb → grants `bash|echo` for the session.
      c.send("p\r")
      // The SECOND echo (round 2) rides the grant WITHOUT a second prompt; if it
      // had re-prompted, the turn would hang here (we never answer again) and
      // ALL_DONE would never render. Reaching it proves the grant carried.
      await c.waitFor("ALL_DONE_PREFIX", 25_000)
      // Belt-and-suspenders: exactly ONE bash confirm was shown all turn (count
      // on the FULL raw buffer — `screen()` is a scrolling window that may have
      // dropped the early prompt by the time ALL_DONE renders).
      expect(countOccurrences(c.output(), "Allow bash?")).toBe(1)
    },
    T,
  )

  test(
    "#20 durable: QUANTA_TRUST_SCOPE wires the [P] (ALL sessions) verb; 'P' rides the sibling",
    async () => {
      const cassette = join(dir, "bash.jsonl")
      writeFileSync(cassette, BASH_PREFIX_CASSETTE)
      const c = drivePtyCli({
        cwd: dir,
        env: {
          QUANTA_SESSIONS_DIR: join(dir, "sessions"),
          QUANTA_LLM_REPLAY: cassette,
          QUANTA_MEMORY: "off",
          QUANTA_MEMORY_AUTO: "0",
          QUANTA_ENABLE_PROMPT_SUGGESTION: "0",
          // Opt into the persistent trust-scope registry. The durable grant
          // (scope:"project", projectKey = cwd) writes to the PROJECT overlay
          // under the temp cwd — not the user's global ~/.quanta (which is only
          // read, harmlessly, at hydrate).
          QUANTA_TRUST_SCOPE: "1",
        },
      })
      cli = c
      await c.waitFor(BOOT, 25_000)
      c.send("run echo\r")
      await c.waitFor("Allow bash?", 25_000)
      // The DURABLE verb is offered only because the registry is wired.
      await c.waitFor("ALL sessions", 20_000)
      c.send("P\r") // durable grant + allow this session
      await c.waitFor("ALL_DONE_PREFIX", 25_000) // sibling echo rode the grant
      expect(countOccurrences(c.output(), "Allow bash?")).toBe(1)
    },
    T,
  )
})
