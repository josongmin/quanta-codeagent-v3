/**
 * CLI e2e (PTY) — a PERSISTED `/model` pick is live on the REAL surface (aug-28).
 *
 * Everything else in this campaign is proven in-process. This is the ground-truth
 * leg: a real `quanta` boot over a real pseudo-terminal, reading a sticky-model
 * file written by a previous session, with NO LLM call (slash commands only, exit
 * before any turn — so it is deterministic and key-free).
 *
 * It pins the three things the in-process suites can only approximate:
 *   1. the WELCOME BANNER — painted before the surface (and thus before the
 *      `/model` adapter) exists, from its own boot read. It named the boot model
 *      for a whole session after a pick until aug-27.
 *   2. `/model` on the real registry — the command printed "not wired in this
 *      surface" on this exact path (the defect that opened the campaign).
 *   3. the MODE AXIS under a real shift+tab. The mode cycle is default-ON and the
 *      sticky key contains the mode, so pressing shift+tab changes WHICH pick is
 *      live. The boot seed used to give a port to the current mode's pick only,
 *      so after one shift+tab the loop silently ran the boot model.
 *
 * HERMETIC: `QUANTA_CONFIG_DIR` is a scratch dir this test writes the sticky file
 * into, and the harness already relocates HOME (so no real credentials/config are
 * reachable). The provider is the harness default (`anthropic` + a dummy key):
 * `tryCreateLLM` validates the CREDENTIAL's presence, not the slug, so ports for
 * the seeded ids are buildable without any network.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { drivePtyCli, PTY_AVAILABLE, type PtyCli } from "./pty-harness"

/** The reader's prompt glyph — painted only after the keypress listener attaches,
 *  so it is the only safe "ready" signal (see the input-layer suite's header for
 *  the measured flake data behind that). */
const BOOT = /›/
const T = 30_000

const DEFAULT_PICK = "claude-haiku-4-5-20251001"
const PLAN_PICK = "claude-opus-4-7"

describe.skipIf(!PTY_AVAILABLE)("CLI `/model` persistence e2e (PTY)", () => {
  let configDir = ""
  let cli: PtyCli | undefined

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "e2e-model-config-"))
    mkdirSync(configDir, { recursive: true })
    // What a PREVIOUS session persisted: one pick per posture, provider-keyed.
    writeFileSync(
      join(configDir, "sticky-model.json"),
      JSON.stringify({ "anthropic:default": DEFAULT_PICK, "anthropic:plan": PLAN_PICK }),
      "utf8",
    )
  })
  afterEach(() => {
    cli?.kill()
    cli = undefined
    rmSync(configDir, { recursive: true, force: true })
  })

  const boot = async (extraEnv: Record<string, string> = {}): Promise<PtyCli> => {
    // 200 cols: the status line elides segments to fit, and at 80 the model
    // segment is the first thing dropped — a narrow terminal would make the
    // status-line assertions below pass vacuously.
    const c = drivePtyCli({ env: { QUANTA_CONFIG_DIR: configDir, ...extraEnv }, cols: 200 })
    cli = c
    await c.waitFor(BOOT, T)
    return c
  }

  /** shift+tab cycles the 4 PERMISSION rungs (default → acceptEdits → plan →
   *  bypass) and only the `plan` rung projects `agentMode: "plan"` — which is the
   *  axis the sticky key uses. So reaching the plan pick takes two presses, not
   *  one. Measured: at 80 cols the pill is the only place the rung is visible. */
  const cycleToPlan = async (c: PtyCli): Promise<void> => {
    for (let i = 0; i < 4; i += 1) {
      if (/\[PLAN\]/.test(c.screen())) return
      c.send("\x1b[Z")
      await c.waitFor(/\[(ACCEPT-EDITS|PLAN|BYPASS|DEFAULT)\]/, T)
      await new Promise((r) => setTimeout(r, 150))
    }
    if (!/\[PLAN\]/.test(c.screen())) throw new Error("never reached the PLAN rung")
  }

  test(
    "the WELCOME BANNER announces the persisted pick, not the boot model",
    async () => {
      const c = await boot()
      expect(c.screen()).toContain(DEFAULT_PICK)
    },
    T,
  )

  test(
    "`/model` is WIRED and marks the persisted pick as current",
    async () => {
      const c = await boot()
      c.send("/model\r")
      await c.waitFor(new RegExp(`model: ${DEFAULT_PICK}`), T)
      const screen = c.screen()
      // The defect that opened this campaign, pinned on the real surface.
      expect(screen).not.toContain("not wired in this surface")
      // Both persisted picks are offered (the seed is per KEY, not just this mode's).
      expect(screen).toContain(PLAN_PICK)
    },
    T,
  )

  test(
    "shift+tab switches WHICH pick is live (the mode axis, on the real cycle)",
    async () => {
      const c = await boot()
      await cycleToPlan(c)
      c.send("/model\r")
      // The PLAN pick is now the current one — same file, different key. This is the
      // per-key seed proving out live: the plan pick has a PORT even though the
      // session booted in `default` and no `/model` has been run.
      await c.waitFor(new RegExp(`model: ${PLAN_PICK}`), T)
    },
    T,
  )

  test(
    "paired control — `QUANTA_MODEL` pins THIS invocation over the stored pick",
    async () => {
      // The interactive surface has NO `--model` flag (only `serve --stdio` and the
      // bench runner do); `QUANTA_MODEL` is the operator's per-invocation pin, and
      // `modelPinnedExplicitly` is derived from it. Measured while writing this: an
      // unknown flag makes the boot hang rather than error, so a test using
      // `--model` here would "prove" the precedence by timing out.
      const c = await boot({ QUANTA_MODEL: "claude-sonnet-4-6" })
      const screen = c.screen()
      expect(screen).toContain("claude-sonnet-4-6")
      // The stored pick did not seed this session (it is not erased — just not used).
      expect(screen).not.toContain(DEFAULT_PICK)
    },
    T,
  )

  test(
    "the STATUS LINE agrees with the banner (both name the persisted pick)",
    async () => {
      // The banner and the status line are painted by DIFFERENT producers: the
      // banner from its own boot read, the status line from `liveModelSource`, which
      // is seeded with the boot model and only repointed at the `/model` adapter once
      // the surface is composed. If that repoint were missing (or ran after the first
      // paint and never repainted), the two would disagree at the top of a session —
      // measured at 80 cols during this file's first run, where the status line read
      // `claude-sonnet-4-6` while the banner read the pick.
      const c = await boot()
      c.send("/model\r")
      await c.waitFor(new RegExp(`model: ${DEFAULT_PICK}`), T)
      // Assert on the STATUS-BAR SEGMENT specifically (`<provider> · <model> · …`),
      // not the whole frame: the boot model legitimately appears in `/model`'s
      // candidate list (it is the "(recommended)" row), so a frame-wide
      // `not.toContain` would be asserting something else entirely.
      const segments = [...c.screen().matchAll(/anthropic \u00b7 ([a-z0-9.-]+) \u00b7/g)].map(
        (m) => m[1],
      )
      expect(segments.length).toBeGreaterThan(0) // the bar DID paint (never vacuous)
      expect([...new Set(segments)]).toEqual([DEFAULT_PICK])
    },
    T,
  )
})
