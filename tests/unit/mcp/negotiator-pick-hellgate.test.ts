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

  test("QUANTA_MCP_CAPS=full → full negotiator (4 caps emitted)", () => {
    const c = pickMcpNegotiator(env("full")).compile()
    expect(c.tools).toEqual({})
    expect(c.sampling).toEqual({})
    expect(c.elicitation).toEqual({})
    expect(c.tasks).toEqual({ listChanged: false })
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
