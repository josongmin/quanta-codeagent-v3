/**
 * CLI e2e (PTY) — INPUT-LAYER features over a real pseudo-terminal (jun-11 P1).
 *
 * Drives the interactive REPL's raw-mode keypress path (which the piped
 * subprocess harness cannot reach) and asserts on the rendered frame, then exits
 * before any turn — so NO LLM call is made (deterministic, key-free). Proves the
 * jun-11 input features actually work end-to-end: word editing (#12), shift+tab
 * mode cycle (#14), @-mention dropdown (#1).
 *
 * Gated on `PTY_AVAILABLE` (visible skip on a Bun build without `Bun.Terminal`).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { drivePtyCli, PTY_AVAILABLE, type PtyCli } from "./pty-harness"

const BOOT = "Ctrl+C quit" // welcome-banner footer ⇒ REPL is at the prompt
const T = 30_000

describe.skipIf(!PTY_AVAILABLE)("CLI input-layer e2e (PTY)", () => {
  let sessionsDir: string
  let cwd: string
  let cli: PtyCli | undefined

  beforeEach(() => {
    sessionsDir = mkdtempSync(join(tmpdir(), "e2e-pty-sessions-")) // empty ⇒ no resume picker
    cwd = mkdtempSync(join(tmpdir(), "e2e-pty-cwd-"))
  })
  afterEach(() => {
    cli?.kill()
    cli = undefined
    rmSync(sessionsDir, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  })

  const boot = async (): Promise<PtyCli> => {
    const c = drivePtyCli({ cwd, env: { QUANTA_SESSIONS_DIR: sessionsDir } })
    cli = c
    await c.waitFor(BOOT, T)
    return c
  }

  test(
    "boots to an interactive prompt (banner footer renders over the PTY)",
    async () => {
      const c = await boot()
      expect(c.screen()).toContain("/help")
    },
    T,
  )

  test(
    "#12 ctrl+w deletes the word before the cursor",
    async () => {
      const c = await boot()
      c.send("foo bar")
      await c.waitFor("foo bar", T)
      c.send("\x17") // ctrl+w → delete "bar"
      c.send("ZZ") // marker: if ctrl+w worked the line is now "foo ZZ", never "barZZ"
      await c.waitFor("foo ZZ", T)
      expect(c.screen()).not.toContain("barZZ")
    },
    T,
  )

  test(
    "#12 ctrl+u kills from the cursor to line start",
    async () => {
      const c = await boot()
      c.send("delete all of this")
      await c.waitFor("delete all of this", T)
      c.send("\x15") // ctrl+u → clear the line
      c.send("KEPT")
      await c.waitFor("KEPT", T)
      // The pre-kill text must not survive concatenated to the marker.
      expect(c.screen()).not.toContain("thisKEPT")
    },
    T,
  )

  test(
    "#14 shift+tab cycles the permission mode (acceptEdits pill renders)",
    async () => {
      const c = await boot()
      c.send("\x1b[Z") // shift+tab / backtab (CSI Z)
      await c.waitFor(/ACCEPT[- ]?EDITS/i, T)
    },
    T,
  )

  test(
    "#1 typing @ opens the file-mention dropdown with a cwd file",
    async () => {
      writeFileSync(join(cwd, "uniquefixture.txt"), "x")
      const c = await boot()
      c.send("@uniquefix")
      await c.waitFor("uniquefixture", T)
    },
    T,
  )
})
