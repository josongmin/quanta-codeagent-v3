/**
 * HELLGATE — the stale-read (TOCTOU) guard through the REAL CLI.
 *
 * ADR-0474 makes the guard a DEFAULT-ON safety control, and the unit suites
 * proved every piece of it. It was still INERT in the shipped CLI, and no test
 * could see that, because every existing test either constructs `ReadFileState`
 * itself or drives `assembleAgentConfig` — and the interactive CLI calls
 * NEITHER. It binds its runtime through `context-binding/base.ts`, which wires
 * optional ports via `wireOptionalAgentPorts` alone, and that function did not
 * mint the state. Measured end-to-end before the fix: a file was read, clobbered
 * by `bash`, then edited — and the edit landed, with the edit tool observing
 * `ctx.readFileState === undefined`.
 *
 * So this file asserts the guard from OUTSIDE, at the only altitude that can
 * tell "wired" from "wired-looking": a real CLI process in a real PTY, with the
 * LLM replayed from a cassette.
 *
 *   G1  EXTERNAL clobber between the read and the edit ⇒ the edit is DENIED and
 *       the file keeps the clobbered bytes.
 *   G2  PAIRED CONTROL — the agent's OWN chained edits (read → edit → edit, no
 *       re-read) BOTH apply. Without this, G1 could be satisfied by a guard
 *       that denies everything, which is a worse product than no guard.
 *
 * G2 is also the end-to-end lock on the content-digest baseline refresh: with
 * that refresh removed, G2 fails with only the FIRST edit applied — the agent
 * vetoed by its own write.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { drivePtyCli, PTY_AVAILABLE, type PtyCli } from "./pty-harness"

const T = 90_000
const U = { type: "usage", inputTokens: 1, outputTokens: 1, model: "replay" }
const turn = (events: readonly unknown[]): string => JSON.stringify({ id: "replay", events })

/** Trailing no-op turns so a cassette running dry can never be mistaken for the
 *  hang a real defect would produce. */
const spares = (n: number): readonly string[] =>
  Array.from({ length: n }, () =>
    turn([
      { type: "text_delta", delta: "GUARD_DONE" },
      U,
      { type: "message_stop", stop_reason: "end_turn" },
    ]),
  )

const toolTurn = (id: string, name: string, input: unknown): string =>
  turn([
    { type: "tool_use_start", id, name },
    { type: "tool_use_end", id, input },
    U,
    { type: "message_stop", stop_reason: "tool_use" },
  ])

const startCli = (dir: string, cassette: string): PtyCli =>
  drivePtyCli({
    cwd: dir,
    env: {
      QUANTA_SESSIONS_DIR: join(dir, "sessions"),
      QUANTA_LLM_REPLAY: cassette,
      QUANTA_MEMORY: "off",
      QUANTA_MEMORY_AUTO: "0",
      // Default-ON single-shot suggestion call would eat a cassette entry and
      // desync the replay (same reason the other PTY suites pin it).
      QUANTA_ENABLE_PROMPT_SUGGESTION: "0",
    },
  })

describe.skipIf(!PTY_AVAILABLE)("stale-read guard e2e (real CLI + PTY + replay)", () => {
  let dir = ""
  let cli: PtyCli | undefined

  const setup = (turns: readonly string[]): { readonly file: string } => {
    dir = mkdtempSync(join(tmpdir(), "e2e-pty-stale-"))
    const file = join(dir, "x.ts")
    writeFileSync(file, "alpha\nbeta\ngamma\n")
    const cassette = join(dir, "replay.jsonl")
    writeFileSync(cassette, `${[...turns, ...spares(5)].join("\n")}\n`)
    cli = startCli(dir, cassette)
    return { file }
  }

  const teardown = (): void => {
    cli?.kill()
    cli = undefined
    if (dir.length > 0) rmSync(dir, { recursive: true, force: true })
  }

  test(
    "G1 an EXTERNAL clobber between read and edit is denied",
    async () => {
      const { file } = setup([
        toolTurn("r", "read", { path: "x.ts" }),
        toolTurn("b", "bash", {
          command: `printf 'CLOBBERED\\nbeta\\ngamma\\n' > ${join("x.ts")}`,
        }),
        toolTurn("e", "edit", { path: "x.ts", old_string: "beta", new_string: "BETA" }),
      ])
      const c = cli as PtyCli
      try {
        await c.waitFor("ask before every edit", 40_000)
        c.send("go\r")
        await c.waitFor("Allow bash?", 40_000)
        c.send("a\r")
        await c.waitFor("Allow edit?", 40_000)
        c.send("a\r")
        await c.waitFor("GUARD_DONE", 60_000)
        expect(c.screen()).toContain("was modified on disk after you last read it")
        // The edit did NOT land: `beta` is still lowercase.
        expect(readFileSync(file, "utf8")).toBe("CLOBBERED\nbeta\ngamma\n")
      } finally {
        teardown()
      }
    },
    T,
  )

  test(
    "G2 PAIRED CONTROL — the agent's own chained edits both apply",
    async () => {
      const { file } = setup([
        toolTurn("r", "read", { path: "x.ts" }),
        toolTurn("e1", "edit", { path: "x.ts", old_string: "alpha", new_string: "ALPHA" }),
        toolTurn("e2", "edit", { path: "x.ts", old_string: "beta", new_string: "BETA" }),
      ])
      const c = cli as PtyCli
      try {
        await c.waitFor("ask before every edit", 40_000)
        c.send("go\r")
        await c.waitFor("Allow edit?", 40_000)
        c.send("a\r")
        await c.waitFor("GUARD_DONE", 60_000)
        expect(c.screen()).not.toContain("was modified on disk after you last read it")
        expect(readFileSync(file, "utf8")).toBe("ALPHA\nBETA\ngamma\n")
      } finally {
        teardown()
      }
    },
    T,
  )
})
