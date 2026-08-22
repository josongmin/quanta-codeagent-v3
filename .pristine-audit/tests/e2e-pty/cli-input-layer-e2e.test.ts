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
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
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

  const bootWith = async (extraEnv: Record<string, string>): Promise<PtyCli> => {
    const c = drivePtyCli({ cwd, env: { QUANTA_SESSIONS_DIR: sessionsDir, ...extraEnv } })
    cli = c
    await c.waitFor(BOOT, T)
    return c
  }
  const boot = async (): Promise<PtyCli> => bootWith({})

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

  // #13 (Agent-B, additive) — `/mode` is the non-keyboard counterpart to the
  // shift+tab cycle: it mutates the SAME mode-cycle store, so the status-bar
  // pill must render exactly as shift+tab does (proving the slash ⇒ shared-store
  // ⇒ pill wiring end-to-end where the user lives).
  test(
    "#13 /mode acceptEdits renders the ACCEPT-EDITS pill (same store as shift+tab)",
    async () => {
      const c = await boot()
      c.send("/mode acceptEdits\r") // submit the slash command
      await c.waitFor(/ACCEPT[- ]?EDITS/i, T)
    },
    T,
  )

  // (#13 PAIRED back-to-default is proven behaviorally in mode-slash-hellgate
  // (permissionMode flips both directions) + the live gate e2e — NOT re-asserted
  // here: `screen()` is the append-only PTY buffer, so an earlier ACCEPT-EDITS
  // pill paint always remains in scrollback and a "pill cleared" check is unsound.)

  // #21 (Agent-B, additive) — `/init` is CLI-surface DEFAULT-ON (opt-OUT via
  // QUANTA_INIT_SLASH=0). Prove it is REGISTERED at the real surface (visible in
  // /help) when the knob is unset — the R3 bug was that the seed ran too late so
  // it was never reachable. Registration ≠ execution (no WRITE here).
  test(
    "#21 /init is registered at the surface by default (/help lists it)",
    async () => {
      const c = await boot() // QUANTA_INIT_SLASH unset ⇒ default-ON
      c.send("/help\r")
      await c.waitFor(/\/init\b/, T)
    },
    T,
  )

  // #21 (Agent-B, additive) — PAIRED opt-OUT: QUANTA_INIT_SLASH=0 removes /init
  // from the registry, so /help must NOT list it — while still listing a sibling
  // config command (/effort) to prove /help actually rendered.
  test(
    "#21 QUANTA_INIT_SLASH=0 removes /init from the surface (PAIRED)",
    async () => {
      const c = await bootWith({ QUANTA_INIT_SLASH: "0" })
      c.send("/help\r")
      await c.waitFor(/\/effort\b/, T) // help rendered (sibling present)
      expect(c.screen()).not.toMatch(/\/init\b/)
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

  test(
    "#1 @-dropdown scrolls past the visible window to reach later files",
    async () => {
      // 12 files all match `@zfile` ⇒ more than the 8-row window. Scrolling
      // down must surface a "+N above" marker AND a high-index file, proving
      // the sliding window + full-list nav (not capped at 8). Regression guard
      // for entries 9+ being permanently unreachable.
      for (let i = 0; i < 12; i += 1) {
        writeFileSync(join(cwd, `zfile${String(i).padStart(2, "0")}.txt`), "x")
      }
      const c = await boot()
      c.send("@zfile")
      await c.waitFor("zfile00", T) // dropdown open, top of list
      await c.waitFor("more", T) // overflow indicator: not all fit in the window
      for (let i = 0; i < 9; i += 1) c.send("\x1b[B") // ↓ ×9 — scroll into the tail
      await c.waitFor("above", T) // window scrolled (top items now off-screen)
      await c.waitFor("zfile11", T) // the last file is reachable
    },
    T,
  )

  test(
    "#12 ctrl+a (home) inserts at the line START",
    async () => {
      const c = await boot()
      c.send("world")
      await c.waitFor("world", T)
      c.send("\x01") // ctrl+a → cursor home
      c.send("hello ") // inserts at start ⇒ "hello world"
      await c.waitFor("hello world", T)
      expect(c.screen()).not.toContain("worldhello")
    },
    T,
  )

  test(
    "#12 ctrl+a then ctrl+k clears the line (kill to end)",
    async () => {
      const c = await boot()
      c.send("junkjunk")
      await c.waitFor("junkjunk", T)
      c.send("\x01") // ctrl+a → home
      c.send("\x0b") // ctrl+k → kill to end ⇒ empty
      c.send("CLEAN")
      await c.waitFor("CLEAN", T)
      expect(c.screen()).not.toContain("junkjunkCLEAN")
      expect(c.screen()).not.toContain("CLEANjunkjunk")
    },
    T,
  )

  test(
    "#12 alt+b moves the cursor a word LEFT",
    async () => {
      const c = await boot()
      c.send("one two")
      await c.waitFor("one two", T)
      c.send("\x1bb") // alt+b → cursor to start of "two"
      c.send("X") // ⇒ "one Xtwo"
      await c.waitFor("Xtwo", T)
      expect(c.screen()).not.toContain("twoX")
    },
    T,
  )

  test(
    "slash palette opens on / and surfaces commands",
    async () => {
      const c = await boot()
      c.send("/")
      await c.waitFor(/\/help|\/status/, T)
    },
    T,
  )

  test(
    "#2 ctrl+x ctrl+e folds the $EDITOR result back into the buffer",
    async () => {
      const editor = join(cwd, "fake-editor.sh")
      writeFileSync(editor, '#!/bin/sh\nprintf "EDITED_BY_SCRIPT" > "$1"\n')
      chmodSync(editor, 0o755)
      const c = drivePtyCli({ cwd, env: { QUANTA_SESSIONS_DIR: sessionsDir, EDITOR: editor } })
      cli = c
      await c.waitFor(BOOT, T)
      c.send("\x18\x05") // ctrl+x ctrl+e → run $EDITOR, fold result back
      await c.waitFor("EDITED_BY_SCRIPT", T)
    },
    T,
  )

  test(
    "Ctrl+C quits the REPL (process exits)",
    async () => {
      const c = await boot()
      c.send("\x03") // ctrl+c
      const code = await Promise.race([
        c.exited,
        new Promise<number>((_, rej) =>
          setTimeout(() => rej(new Error("no exit after ctrl+c")), T),
        ),
      ])
      expect(typeof code).toBe("number")
    },
    T,
  )

  // #10 — bracketed-paste (default-ON via QUANTA_BRACKETED_PASTE seed). A
  // multi-line paste wrapped in the DECSET 2004 markers must NOT submit at its
  // first embedded newline: the reader accumulates the whole blob and collapses
  // the echo to `[Pasted Content N chars]`. Before the fix the inner `\r` was
  // Enter and the line submitted (the REPL would echo "line1" as a turn).
  test(
    "#10 a bracketed multi-line paste accumulates (no early submit) and shows the paste placeholder",
    async () => {
      const c = await boot()
      // ESC[200~ <multi\rline> ESC[201~ — \r is how a terminal delivers a pasted
      // newline. With the feature on this is held in the buffer, not submitted.
      c.send("\x1b[200~PASTEONE\rPASTETWO\x1b[201~")
      await c.waitFor(/Pasted Content \d+ chars/, T)
      // The raw second line never appeared as its own submitted turn line, and the
      // composer still holds the (collapsed) draft — a sentinel typed after the
      // paste lands in the SAME line, proving no submit happened.
      c.send("Z")
      await c.waitFor("Z", T)
    },
    T,
  )
})
