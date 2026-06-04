/** ADR-0196 — `pickMcpNegotiator` env-driven swap hellgate.
 *
 *  Verifies the apps/agent surface picks the right negotiator from env:
 *  absent / wrong value → default (`{}`), exactly `"full"` → full (4 caps).
 *  Any non-canonical input (uppercase, typo) must fall through to default. */

import { describe, expect, test } from "bun:test"
import { pickMcpNegotiator } from "@/../src/apps/agent/index"

const env = (v?: string): NodeJS.ProcessEnv => {
  const out: NodeJS.ProcessEnv = {}
  if (v !== undefined) out.QUANTA_MCP_CAPS = v
  return out
}

describe("pickMcpNegotiator", () => {
  test("absent env → default (byte-identical `{}`)", () => {
    expect(JSON.stringify(pickMcpNegotiator(env()).compile())).toBe("{}")
  })

  test("QUANTA_MCP_CAPS=full → full negotiator (fulfillable caps; sampling omitted, ADR-0470)", () => {
    const c = pickMcpNegotiator(env("full")).compile()
    expect(c.tools).toEqual({})
    expect(c.elicitation).toEqual({})
    expect(c.tasks).toEqual({ listChanged: false })
    // `pickMcpNegotiator` does not wire a sampling handler, so it must not
    // advertise sampling (advertise-iff-able). Wiring is a composition-root
    // follow-up (inject a SamplingHandlerPort + fullNegotiator({sampling:true})).
    expect(c.sampling).toBeUndefined()
  })

  test("H19 — roots advertised IFF opts.roots, under full caps, byte-canonical order", () => {
    // Without the opt, roots is omitted (advertise-iff-provider).
    expect(pickMcpNegotiator(env("full")).compile().roots).toBeUndefined()
    // With it, roots is present with the honest `listChanged:false`.
    const c = pickMcpNegotiator(env("full"), { roots: true }).compile()
    expect(c.roots).toEqual({ listChanged: false })
    // sampling + roots together stay in canonical (alphabetical) key order so the
    // on-wire bytes are deterministic: elicitation < roots < sampling < tasks < tools.
    const both = pickMcpNegotiator(env("full"), { sampling: true, roots: true }).compile()
    expect(Object.keys(both)).toEqual(["elicitation", "roots", "sampling", "tasks", "tools"])
  })

  test("H19 — roots opt is IGNORED without full caps (no base-caps ⇒ default `{}`)", () => {
    expect(JSON.stringify(pickMcpNegotiator(env(), { roots: true }).compile())).toBe("{}")
  })

  test("non-canonical values (Full / FULL / typo) fall through to default", () => {
    for (const bad of ["Full", "FULL", "true", "1", "fulll"]) {
      expect(JSON.stringify(pickMcpNegotiator(env(bad)).compile())).toBe("{}")
    }
  })

  test("empty string → default", () => {
    expect(JSON.stringify(pickMcpNegotiator(env("")).compile())).toBe("{}")
  })
})
