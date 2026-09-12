/**
 * Hellgate — `/knobs set` reports liveness from the catalog, through the REAL wire.
 *
 * WHY THIS EXISTS, and why it is a separate file.
 *
 * `setCatalogKnob` printed `(session override; live this session)` unconditionally.
 * Measured: the unified catalog has 674 rows and exactly ONE is
 * `hotToggleable: true` — `QUANTA_PERSONA`, whose own source says the apply path is
 * dead (`personaKnob` is not in `wireInteractiveKnobs`, there is no `/persona`
 * command, so `apply` never fires on a live surface). So the sentence was false on
 * every row an operator could reach.
 *
 * Worse, the runner path two functions away has warned correctly the whole time.
 * The same knob therefore answered differently depending on spelling: `/knobs set
 * advisor=x` (runner id) warned "not hot-toggleable", `/knobs set
 * QUANTA_ADVISOR_MODEL=x` (envKey, which is what `/knobs all` PRINTS and what a
 * user copies) claimed a live session override.
 *
 * `tests/unit/cli/slash-knobs.test.ts` could not catch this: its harness builds a
 * fake `KnobsSurfaceWire` whose `setOverride` RETURNS the warning string
 * (`slash-knobs.test.ts:208`), then asserts that returned string appears. The
 * producer — `defaultWire` and `setCatalogKnob` — is never executed. So this file
 * imports the ASSEMBLED `knobsCmd` (`buildKnobsSlash(defaultWire)`) and nothing
 * else, with one rule: no wire may be stubbed here. A stub reintroduces exactly the
 * blindness that let the message stay wrong.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { __resetCliKnobOverrides } from "../../../src/apps/cli/cli-knobs-accessor"
import { buildKnobCatalog } from "../../../src/apps/cli/knob-catalog-wire"
import "../../../src/apps/cli/knobs-bootstrap" // registry side-effect, as production does
import { knobsCmd } from "../../../src/apps/cli/slash-commands-knobs"
import type { SlashContext } from "../../../src/apps/cli/slash-contract"

/** A context that captures output. No wire indirection — `knobsCmd` already owns
 *  `defaultWire`, which is the whole point of this file. */
const capture = (): { ctx: SlashContext; out: () => string; err: () => string } => {
  let out = ""
  let err = ""
  const ctx = {
    out: (c: string) => {
      out += c
    },
    err: (c: string) => {
      err += c
    },
    cwd: "/tmp",
  } as unknown as SlashContext
  return { ctx, out: () => out, err: () => err }
}

const setKnob = async (pair: string): Promise<{ code: number; out: string; err: string }> => {
  const c = capture()
  const code = await knobsCmd.run(["set", pair], c.ctx)
  return { code: code as number, out: c.out(), err: c.err() }
}

const resetKnob = async (id: string): Promise<{ code: number; out: string; err: string }> => {
  const c = capture()
  const code = await knobsCmd.run(["reset", id], c.ctx)
  return { code: code as number, out: c.out(), err: c.err() }
}

afterEach(() => {
  __resetCliKnobOverrides()
})

describe("/knobs set liveness honesty (P2)", () => {
  /** The census this whole guard rests on, asserted rather than assumed: if a
   *  future change makes many rows hot-toggleable, the claim below stops being
   *  "every reachable row" and this test should be revisited, not silently kept. */
  test("the catalog's hotToggleable population is what the message logic assumes", () => {
    const catalog = buildKnobCatalog()
    expect(catalog.size, "empty catalog — this suite would assert nothing").toBeGreaterThan(400)
    const hot = [...catalog].filter(([, k]) => k.hotToggleable === true).map(([id]) => id)
    expect(hot, "no knob currently has a live apply path; see persona.ts").toEqual([])
  })

  test("a catalog knob addressed by envKey does NOT claim to be live", async () => {
    const r = await setKnob("QUANTA_ATTENTION_NAV=1")
    expect(r.code).toBe(0)
    expect(r.out).not.toContain("live this session")
    expect(r.out).toContain("session override stored")
    expect(r.out).toContain("read once at startup")
    // The advice must be the one that works.
    expect(r.out).toContain("export QUANTA_ATTENTION_NAV=1")
  })

  /**
   * NO message may recommend `/knobs save` as a way to make a knob take effect.
   *
   * The first fix to `setCatalogKnob` said "run `/knobs save` and restart, or
   * export it". `/knobs save` really does write `knobs.json`, but nothing in
   * production reads it back (see the ground-truth test below), so half the advice
   * was a command that does nothing — the same defect class, one revision later.
   */
  test("no set/reset message advises /knobs save as a way to take effect", async () => {
    const texts = [
      await setKnob("QUANTA_ATTENTION_NAV=1"),
      await setKnob("persona=friendly"),
      await resetKnob("QUANTA_ATTENTION_NAV"),
      await resetKnob("persona"),
    ].map((r) => r.out + r.err)
    for (const t of texts) {
      expect(t, `advises /knobs save: ${t}`).not.toContain("/knobs save")
      expect(t).not.toContain("saved for next session")
      expect(t).not.toMatch(/restart/i)
    }
  })

  /**
   * GROUND TRUTH for the wording above: a persisted `knobs.json` is NOT consulted.
   *
   * This is the fact that makes "export it" the only true advice. If someone wires
   * a production reader for the file — `bootstrapKnobs` exists and has zero callers,
   * and its own source says "the file is write-only in prod today" — this test goes
   * RED, and the message must be updated to mention the file again. That is the
   * intended coupling: the claim and the capability fail together.
   */
  test("a persisted knobs.json is not read back by the production accessor", async () => {
    const { readCliKnob } = await import("../../../src/apps/cli/cli-knobs-accessor")
    const home = mkdtempSync(join(tmpdir(), "knobs-save-read-"))
    writeFileSync(
      join(home, "knobs.json"),
      JSON.stringify({ version: 1, user_defaults: { QUANTA_ATTENTION_NAV: "1" } }),
      "utf8",
    )
    const prior = process.env.QUANTA_HOME
    process.env.QUANTA_HOME = home
    try {
      __resetCliKnobOverrides()
      expect(
        readCliKnob("QUANTA_ATTENTION_NAV", "bool"),
        "knobs.json is now being read — `/knobs set` must stop saying `export` is the only way",
      ).not.toBe(true)
    } finally {
      if (prior === undefined) delete process.env.QUANTA_HOME
      else process.env.QUANTA_HOME = prior
      rmSync(home, { recursive: true, force: true })
    }
  })

  /**
   * `/knobs reset` had the same per-spelling asymmetry `/knobs set` was fixed for:
   * the catalog branch printed "cleared" unconditionally while the runner branch
   * correctly said "no-op".
   */
  test("reset reports the same thing for both spellings when nothing was set", async () => {
    const byEnvKey = await resetKnob("QUANTA_ATTENTION_NAV")
    const byId = await resetKnob("persona")
    const cleared = (s: string): boolean => /session override cleared/.test(s)
    expect(cleared(byEnvKey.out)).toBe(false)
    expect(cleared(byId.out)).toBe(false)
    expect(byEnvKey.out).toContain("no session override")
    expect(byId.out).toContain("no session override")
  })

  test("reset DOES report cleared when something was set — not a blanket no-op", async () => {
    await setKnob("QUANTA_ATTENTION_NAV=1")
    const r = await resetKnob("QUANTA_ATTENTION_NAV")
    expect(r.out).toContain("session override cleared")
  })

  /** The spelling asymmetry, pinned as ONE fact rather than two: the same knob must
   *  not be described differently because the user typed the id the catalog prints
   *  instead of the id the runner registry uses. */
  test("runner-id and envKey spellings of the same knob agree about liveness", async () => {
    const byEnvKey = await setKnob("QUANTA_PERSONA=friendly")
    const byId = await setKnob("persona=friendly")
    const live = (s: string): boolean => /live this session/.test(s)
    expect(live(byEnvKey.out)).toBe(live(byId.out + byId.err))
  })

  test("an unknown knob is still refused, not reported as stored", async () => {
    const r = await setKnob("QUANTA_NOT_A_REAL_KNOB_ZZZ=1")
    expect(r.code).not.toBe(0)
    expect(r.out).not.toContain("session override")
  })

  /** GROUND TRUTH, not just wording: the override must actually be readable back
   *  through the accessor production uses. A message-only fix that stored nothing
   *  would pass every assertion above. */
  test("the override is genuinely stored — the message is about TIMING, not storage", async () => {
    const { readCliKnob } = await import("../../../src/apps/cli/cli-knobs-accessor")
    expect(readCliKnob("QUANTA_ATTENTION_NAV", "bool")).not.toBe(true)
    await setKnob("QUANTA_ATTENTION_NAV=1")
    expect(readCliKnob("QUANTA_ATTENTION_NAV", "bool")).toBe(true)
  })
})
