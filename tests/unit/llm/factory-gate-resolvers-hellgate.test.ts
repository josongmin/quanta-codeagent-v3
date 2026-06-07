/**
 * Hellgate — `@/llm/factory` env-gate resolvers (jun-7 gate-vocab unification).
 *
 * `resolveServiceTier` (QUANTA_FAST ⇒ "priority"), `resolveDebugOAuth`
 * (QUANTA_DEBUG_OAUTH) and `resolveReasoningCarryover` (QUANTA_REASONING_CARRYOVER)
 * were migrated from scattered strict `=== "1"` reads onto the broadened `gateOn`
 * SSOT vocabulary `{1,on,true,yes}`.
 *
 * VALUE-TESTABILITY (jun-7 structural fix): the three resolvers are pure
 * functions of `(opts?, env)` — side-effect-free — so they are now EXPORTED
 * from `@/llm/factory` as a zero-risk testability seam. This locks the actual
 * MAPPING (e.g. `QUANTA_FAST` truthy ⇒ `"priority"`), not just the upstream
 * `gateOn` vocab. A regression that re-narrows a read to strict `=== "1"`, or
 * changes the `"priority"` literal, or mis-wires an env key, now goes RED.
 *
 * What is locked here:
 *   1. `gateOn` vocabulary keyed by the EXACT env-var names those resolvers
 *      consume — so dropping `on`/`true`/`yes` upstream goes red.
 *   2. VALUE-level: the resolver outputs across the truthy/falsy matrix,
 *      pinning the exact env key + output literal/boolean and the opts/env
 *      precedence (explicit opt wins; `QUANTA_SERVICE_TIER` honored; empty ⇒
 *      undefined).
 *   3. `createLLM` constructs the Responses / chatgpt-oauth adapter across the
 *      whole gate matrix without throwing (the resolver runs on that path).
 *
 * Hermetic: env is passed explicitly to the resolvers / `createLLM` / `gateOn`;
 * no process.env.
 */

import { describe, expect, test } from "bun:test"
import {
  createLLM,
  resolveDebugOAuth,
  resolveReasoningCarryover,
  resolveServiceTier,
} from "@/llm/factory"
import { gateOn } from "@/shared"

const BROAD_TRUTHY = ["1", "on", "true", "yes"] as const
const NOT_ON = ["0", "", "off", "garbage", "no"] as const

describe("factory gate resolvers — broadened gateOn vocab on the EXACT env keys", () => {
  // resolveServiceTier: gateOn(env,"QUANTA_FAST") ? "priority" : … ?? QUANTA_SERVICE_TIER
  test("QUANTA_FAST: every broadened truthy spelling reads ON (would map to priority)", () => {
    for (const v of BROAD_TRUTHY) expect(gateOn({ QUANTA_FAST: v }, "QUANTA_FAST")).toBe(true)
  })
  test('QUANTA_FAST: "0"/""/absent/unknown do NOT read ON', () => {
    for (const v of NOT_ON) expect(gateOn({ QUANTA_FAST: v }, "QUANTA_FAST")).toBe(false)
    expect(gateOn({}, "QUANTA_FAST")).toBe(false)
  })

  // resolveDebugOAuth: opts.debugOAuth ?? gateOn(env,"QUANTA_DEBUG_OAUTH")
  test("QUANTA_DEBUG_OAUTH: every broadened truthy spelling reads ON", () => {
    for (const v of BROAD_TRUTHY)
      expect(gateOn({ QUANTA_DEBUG_OAUTH: v }, "QUANTA_DEBUG_OAUTH")).toBe(true)
  })
  test('QUANTA_DEBUG_OAUTH: "0"/""/absent/unknown do NOT read ON', () => {
    for (const v of NOT_ON)
      expect(gateOn({ QUANTA_DEBUG_OAUTH: v }, "QUANTA_DEBUG_OAUTH")).toBe(false)
    expect(gateOn({}, "QUANTA_DEBUG_OAUTH")).toBe(false)
  })

  // resolveReasoningCarryover: gateOn(env,"QUANTA_REASONING_CARRYOVER") (default-OFF)
  test("QUANTA_REASONING_CARRYOVER: every broadened truthy spelling reads ON", () => {
    for (const v of BROAD_TRUTHY)
      expect(gateOn({ QUANTA_REASONING_CARRYOVER: v }, "QUANTA_REASONING_CARRYOVER")).toBe(true)
  })
  test('QUANTA_REASONING_CARRYOVER: "0"/""/absent/unknown do NOT read ON', () => {
    for (const v of NOT_ON)
      expect(gateOn({ QUANTA_REASONING_CARRYOVER: v }, "QUANTA_REASONING_CARRYOVER")).toBe(false)
    expect(gateOn({}, "QUANTA_REASONING_CARRYOVER")).toBe(false)
  })
})

describe("createLLM — resolver code path runs on the Responses surface across the gate matrix", () => {
  // The serviceTier / reasoningCarryover resolvers run ONLY when the openai
  // surface resolves to "responses". Exercise the path with each truthy spelling
  // of QUANTA_FAST: the adapter must still construct (Responses surface) and not
  // throw — proving the resolver is invoked on a live build.
  for (const v of BROAD_TRUTHY) {
    test(`QUANTA_FAST=${v} → openai Responses adapter constructs (resolveServiceTier on path)`, () => {
      const llm = createLLM("openai", { model: "gpt-5-mini", apiKey: "k" }, { QUANTA_FAST: v })
      expect(llm.surfaceId).toBe("openai-responses")
    })
  }

  test("QUANTA_FAST does NOT flip the surface (FAST is a tier knob, not a surface knob)", () => {
    const off = createLLM("openai", { model: "gpt-5-mini", apiKey: "k" }, {})
    const on = createLLM("openai", { model: "gpt-5-mini", apiKey: "k" }, { QUANTA_FAST: "on" })
    expect(off.surfaceId).toBe("openai-responses")
    expect(on.surfaceId).toBe("openai-responses")
  })

  for (const v of BROAD_TRUTHY) {
    test(`QUANTA_DEBUG_OAUTH=${v} → chatgpt-oauth adapter constructs (resolveDebugOAuth on path)`, () => {
      // chatgpt-oauth needs no api key; the adapter is built eagerly so the
      // debugOAuth resolver runs during construction.
      const llm = createLLM("chatgpt-oauth", { model: "gpt-5" }, { QUANTA_DEBUG_OAUTH: v })
      expect(llm.provider).toBe("chatgpt-oauth")
    })
  }
})

describe("resolveServiceTier — VALUE mapping (QUANTA_FAST ⇒ 'priority')", () => {
  // Contract (source): opts.serviceTier wins; else gateOn(env,"QUANTA_FAST")
  //   ? "priority" : undefined, then ?? env.QUANTA_SERVICE_TIER; empty ⇒ undefined.
  test("every broadened truthy QUANTA_FAST maps to exactly 'priority'", () => {
    for (const v of BROAD_TRUTHY)
      expect(resolveServiceTier({}, { QUANTA_FAST: v })).toBe("priority")
  })

  test("QUANTA_FAST off/absent ⇒ undefined (no QUANTA_SERVICE_TIER fallback set)", () => {
    for (const v of NOT_ON) expect(resolveServiceTier({}, { QUANTA_FAST: v })).toBeUndefined()
    expect(resolveServiceTier({}, {})).toBeUndefined()
  })

  test("QUANTA_SERVICE_TIER is honored when QUANTA_FAST is off/absent", () => {
    expect(resolveServiceTier({}, { QUANTA_SERVICE_TIER: "flex" })).toBe("flex")
    expect(resolveServiceTier({}, { QUANTA_FAST: "0", QUANTA_SERVICE_TIER: "default" })).toBe(
      "default",
    )
  })

  test("empty QUANTA_SERVICE_TIER ⇒ undefined (empty collapses to undefined)", () => {
    expect(resolveServiceTier({}, { QUANTA_SERVICE_TIER: "" })).toBeUndefined()
  })

  test("QUANTA_FAST 'priority' shortcut OUTRANKS an explicit QUANTA_SERVICE_TIER", () => {
    // fromFast ?? env.QUANTA_SERVICE_TIER → priority wins when FAST is on.
    expect(resolveServiceTier({}, { QUANTA_FAST: "on", QUANTA_SERVICE_TIER: "flex" })).toBe(
      "priority",
    )
  })

  test("explicit opts.serviceTier wins over both env knobs", () => {
    expect(
      resolveServiceTier(
        { serviceTier: "scale" },
        { QUANTA_FAST: "1", QUANTA_SERVICE_TIER: "flex" },
      ),
    ).toBe("scale")
  })
})

describe("resolveDebugOAuth — VALUE mapping (QUANTA_DEBUG_OAUTH ⇒ boolean)", () => {
  // Contract (source): opts.debugOAuth ?? gateOn(env,"QUANTA_DEBUG_OAUTH").
  test("every broadened truthy QUANTA_DEBUG_OAUTH ⇒ true", () => {
    for (const v of BROAD_TRUTHY)
      expect(resolveDebugOAuth({}, { QUANTA_DEBUG_OAUTH: v })).toBe(true)
  })

  test("QUANTA_DEBUG_OAUTH off/absent ⇒ false (default-OFF)", () => {
    for (const v of NOT_ON) expect(resolveDebugOAuth({}, { QUANTA_DEBUG_OAUTH: v })).toBe(false)
    expect(resolveDebugOAuth({}, {})).toBe(false)
  })

  test("explicit opts.debugOAuth wins over env (true overrides off env)", () => {
    expect(resolveDebugOAuth({ debugOAuth: true }, { QUANTA_DEBUG_OAUTH: "0" })).toBe(true)
    expect(resolveDebugOAuth({ debugOAuth: false }, { QUANTA_DEBUG_OAUTH: "1" })).toBe(false)
  })
})

describe("resolveReasoningCarryover — VALUE mapping (QUANTA_REASONING_CARRYOVER ⇒ boolean)", () => {
  // Contract (source): gateOn(env,"QUANTA_REASONING_CARRYOVER"). Env-only — no
  // opts param (default-OFF: unset ⇒ false).
  test("every broadened truthy QUANTA_REASONING_CARRYOVER ⇒ true", () => {
    for (const v of BROAD_TRUTHY)
      expect(resolveReasoningCarryover({ QUANTA_REASONING_CARRYOVER: v })).toBe(true)
  })

  test("QUANTA_REASONING_CARRYOVER off/absent ⇒ false (default-OFF)", () => {
    for (const v of NOT_ON)
      expect(resolveReasoningCarryover({ QUANTA_REASONING_CARRYOVER: v })).toBe(false)
    expect(resolveReasoningCarryover({})).toBe(false)
  })
})
