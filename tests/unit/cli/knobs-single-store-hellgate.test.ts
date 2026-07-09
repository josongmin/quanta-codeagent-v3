/**
 * WS-D batch-1 (UUX-6-04 + UUX-4-21) — `/knobs` single-override-store hellgate.
 *
 * Template: **"saved N override(s)" / show output that does not reflect the
 * store the user actually mutated ⇒ RED.** `/knobs set` must write ONE
 * override store that `show`, `all`, `save`, live readers (`readCliKnob`) and
 * `preset` all consume — set→show→save→fresh-readback must be one coherent
 * chain (fresh readback = `readKnobConfig` re-parse of the persisted file, not
 * an in-memory echo).
 *
 * Legacy dual-store bug: catalog-knob sets went to the shared
 * `@/shared/knob-overrides` store while show/save read the module-level
 * `DEFAULT_OVERRIDES` bag — `/knobs save` persisted a store the user never
 * changed. Runner-knob sets had the INVERSE hole: they landed only in the
 * module bag, invisible to `readCliKnob`/`runtimeConfig` live readers.
 *
 * UUX-4-21 rider: preset apply computes hot-toggle warnings then drops them —
 * they must surface in the output.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
// Populate the runner-knob registry (side-effect import, same as the CLI boot).
import "@/apps/cli/knobs-bootstrap"
import { __resetCliKnobOverrides, readCliKnob } from "@/apps/cli/cli-knobs-accessor"
import { buildKnobCatalog } from "@/apps/cli/knob-catalog-wire"
import type { SlashContext } from "@/apps/cli/slash-commands"
import { knobsCmd } from "@/apps/cli/slash-commands-knobs"
import { allKnobs, readKnobConfig } from "@/runner/knobs"

/* ------------------------------------------------------------------ */
/* harness                                                             */
/* ------------------------------------------------------------------ */

let homeRoot = ""
const envBefore = { config: process.env.QUANTA_CONFIG_DIR, home: process.env.QUANTA_HOME }

beforeAll(() => {
  homeRoot = mkdtempSync(join(tmpdir(), "knobs-single-store-"))
})
afterAll(() => {
  rmSync(homeRoot, { recursive: true, force: true })
  if (envBefore.config === undefined) delete process.env.QUANTA_CONFIG_DIR
  else process.env.QUANTA_CONFIG_DIR = envBefore.config
  if (envBefore.home === undefined) delete process.env.QUANTA_HOME
  else process.env.QUANTA_HOME = envBefore.home
})
afterEach(() => {
  __resetCliKnobOverrides()
})

let caseSeq = 0
/** Fresh isolated quanta-home per test so save/readback never cross-talk. */
const freshHome = (): string => {
  caseSeq += 1
  const dir = join(homeRoot, `case-${caseSeq}`)
  process.env.QUANTA_CONFIG_DIR = dir
  return dir
}

interface Io {
  readonly ctx: SlashContext
  readonly stdout: () => string
  readonly stderr: () => string
}

const makeCtx = (): Io => {
  let out = ""
  let err = ""
  const ctx = {
    out: (s: string) => {
      out += s
    },
    err: (s: string) => {
      err += s
    },
    cwd: "/tmp",
  } as SlashContext
  return { ctx, stdout: () => out, stderr: () => err }
}

/** A catalog knob (envKey-addressed) that is NOT a runner-registry knob and is
 *  bool-kinded (so its value renders unredacted). */
const pickCatalogOnlyBoolKnob = (): string => {
  const runnerEnvKeys = new Set([...allKnobs().values()].map((k) => k.envKey))
  for (const [envKey, k] of buildKnobCatalog()) {
    if (k.kind === "bool" && !runnerEnvKeys.has(envKey) && !allKnobs().has(envKey)) return envKey
  }
  throw new Error("no catalog-only bool knob found")
}

/* ------------------------------------------------------------------ */
/* hellgate — one store for set / show / save / read                   */
/* ------------------------------------------------------------------ */

describe("/knobs — ONE override store across set/show/save/read", () => {
  test("HELLGATE (catalog knob): set → save → FRESH readback of the persisted file contains the set value", async () => {
    const home = freshHome()
    const key = pickCatalogOnlyBoolKnob()
    const io = makeCtx()

    expect(await knobsCmd.run(["set", `${key}=1`], io.ctx)).toBe(0)
    expect(await knobsCmd.run(["save"], io.ctx)).toBe(0)

    // Fresh readback: re-parse the file from disk, no in-memory echo.
    const persisted = await readKnobConfig(join(home, "knobs.json"))
    expect(persisted?.user_defaults[key]).toBe("1")
    // And the save line must not claim success for a store missing the change.
    expect(io.stdout()).toContain("saved")
  })

  test("HELLGATE (catalog knob): set → `/knobs all` displays the session value, not a stale default", async () => {
    freshHome()
    const key = pickCatalogOnlyBoolKnob()
    const io = makeCtx()

    expect(await knobsCmd.run(["set", `${key}=1`], io.ctx)).toBe(0)
    const show = makeCtx()
    expect(await knobsCmd.run(["all"], show.ctx)).toBe(0)
    // renderAll marks non-default values with '*': `KEY=1*`.
    expect(show.stdout()).toContain(`${key}=1*`)
  })

  test("HELLGATE (runner knob): set is live-visible to readCliKnob (the shared store), and show + save see the SAME store", async () => {
    const home = freshHome()
    const io = makeCtx()

    // `advisor` is a cli-surface runner knob; "gpt-5" is on its allowlist.
    expect(await knobsCmd.run(["set", "advisor=gpt-5"], io.ctx)).toBe(0)

    // Live reader (shared knob-overrides store) must see the set.
    expect(readCliKnob("QUANTA_ADVISOR_MODEL", "string")).toBe("gpt-5")

    // show reflects the set value (the fixed-width box truncates the trailing
    // "(source: session)" for long values — the value itself is the receipt).
    const show = makeCtx()
    expect(await knobsCmd.run(["show"], show.ctx)).toBe(0)
    expect(show.stdout()).toContain("advisor")
    expect(show.stdout()).toContain("gpt-5")

    // save persists it; fresh readback from disk.
    expect(await knobsCmd.run(["save"], io.ctx)).toBe(0)
    const persisted = await readKnobConfig(join(home, "knobs.json"))
    expect(persisted?.user_defaults.advisor).toBe("gpt-5")
  })

  test("paired control: reset clears the ONE store — show no longer lists it, save persists without it, live reader unset", async () => {
    const home = freshHome()
    const io = makeCtx()
    expect(await knobsCmd.run(["set", "advisor=gpt-5"], io.ctx)).toBe(0)
    expect(await knobsCmd.run(["reset", "advisor"], io.ctx)).toBe(0)

    expect(readCliKnob("QUANTA_ADVISOR_MODEL", "string")).toBeUndefined()
    const show = makeCtx()
    await knobsCmd.run(["show"], show.ctx)
    expect(show.stdout()).not.toContain("advisor")

    await knobsCmd.run(["save"], io.ctx)
    const persisted = await readKnobConfig(join(home, "knobs.json"))
    expect(persisted?.user_defaults.advisor).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ */
/* UUX-4-21 — preset hot-toggle warnings must surface                  */
/* ------------------------------------------------------------------ */

describe("/knobs preset — hot-toggle warnings surface in output", () => {
  test("HELLGATE: applying a preset containing non-hot-toggleable knobs prints the warning(s) instead of dropping them", async () => {
    freshHome()
    const io = makeCtx()
    const exit = await knobsCmd.run(["preset", "agentless-v1"], io.ctx)
    expect(exit).toBe(0)
    expect(io.stdout()).toContain("applied")
    // agentless-v1 contains boot-frozen (non-hot-toggleable) knobs — the
    // computed warnings must be visible, not silently discarded.
    expect(io.stdout()).toContain("warning")
  })
})
