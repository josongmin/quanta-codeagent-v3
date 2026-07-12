/**
 * CLI e2e (PTY) — the "Pursuing goal" (Codex `/goal` parity) feature over a real
 * pseudo-terminal. Boots the ACTUAL CLI from source, so it exercises the whole
 * live stack: boot → surface-compose mints the objective store → dispatch wires
 * `ctx.goal` → the `/goal` slash command → the surface objective store. This is
 * the real end-to-end proof that the feature is WIRED (not "not wired") in the
 * built app — no LLM is called (`/goal` is a slash command, deterministic).
 *
 * What this does NOT cover: the autonomous continuation itself (the idle ticker
 * firing a real LLM turn under `QUANTA_GOAL_ENFORCE`) — that needs a live model
 * + a real idle window and is verified by the unit/chain hellgates instead.
 *
 * Gated on `PTY_AVAILABLE` (visible skip on a Bun build without openpty).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { drivePtyCli, PTY_AVAILABLE, type PtyCli } from "./pty-harness"

const BOOT = "Ctrl+C quit" // welcome-banner footer ⇒ REPL is at the prompt
const T = 30_000

describe.skipIf(!PTY_AVAILABLE)("CLI /goal (Pursuing goal) e2e (PTY)", () => {
  let sessionsDir: string
  let cwd: string
  let cli: PtyCli | undefined

  beforeEach(() => {
    sessionsDir = mkdtempSync(join(tmpdir(), "e2e-goal-sessions-")) // empty ⇒ no resume picker
    cwd = mkdtempSync(join(tmpdir(), "e2e-goal-cwd-"))
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
    "/help lists /goal — the command is registered at the surface",
    async () => {
      const c = await boot()
      c.send("/help\r")
      await c.waitFor("/goal", T)
      expect(c.screen()).toContain("/goal")
    },
    T,
  )

  test(
    "/goal <objective> records an active pursuing goal in the live CLI",
    async () => {
      const c = await boot()
      c.send("/goal ship the pursuit feature\r")
      // The surface minted the store and populated ctx.goal ⇒ the command sets
      // it (NOT the "not wired" degrade path).
      const screen = await c.waitFor(/Pursuing goal set|not wired/, T)
      expect(screen).toContain("Pursuing goal set")
      expect(screen).not.toContain("not wired")
    },
    T,
  )

  test(
    "the goal persists in the surface store — /goal echoes it back as active",
    async () => {
      const c = await boot()
      c.send("/goal measure twice cut once\r")
      await c.waitFor("Pursuing goal set", T)
      c.send("/goal\r")
      await c.waitFor("Pursuing goal: measure twice cut once", T)
      expect(c.screen()).toContain("active")
    },
    T,
  )
})
