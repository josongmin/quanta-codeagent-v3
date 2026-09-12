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
    expect(r.out).toContain("session override STORED")
    expect(r.out).toContain("read at startup")
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
