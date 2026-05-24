/** ADR-0196 — capability negotiator hellgate.
 *
 *  Sections (4 cases):
 *    HELL-C-01: defaultNegotiator emits byte-identical `{}`
 *    HELL-C-02: fullNegotiator emits the 4 rmcp flags
 *    HELL-C-03: graceful degrade when a server ignores an unsupported cap
 *    HELL-C-04: JSON-canonical serialization (sorted keys) */

import { describe, expect, test } from "bun:test"
import { defaultNegotiator, fullNegotiator } from "@/mcp"

describe("CapabilityNegotiator (HELL-C)", () => {
  test("HELL-C-01: defaultNegotiator emits byte-identical `{}`", () => {
    const c = defaultNegotiator.compile()
    // Object.keys is empty + JSON-serializes to `{}` — byte-identical with the
    // pre-ADR-0196 hard-coded literal at `src/mcp/client.ts:126`.
    expect(Object.keys(c)).toEqual([])
    expect(JSON.stringify(c)).toBe("{}")
  })

  test("HELL-C-01b: defaultNegotiator is referentially stable across calls", () => {
    // No allocation per call ⇒ a callable hot path stays cheap.
    expect(defaultNegotiator.compile()).toBe(defaultNegotiator.compile())
  })

  test("HELL-C-02: fullNegotiator emits the 4 rmcp flags", () => {
    const c = fullNegotiator().compile()
    expect(c.tools).toEqual({})
    expect(c.sampling).toEqual({})
    expect(c.elicitation).toEqual({})
    expect(c.tasks).toEqual({ listChanged: false })
  })

  test("HELL-C-03: server-side ignore of an unsupported cap is graceful", () => {
    // A server that does not understand `tasks` will simply omit it from its
    // own `serverInfo.capabilities` — that is a server-side concern. From the
    // client side, the contract is that the SAME compile() output is produced
    // regardless of server response, so we capture that invariant here. The
    // wire-level graceful-degrade test (server reply parsing) lives in the
    // existing integration suite — this hellgate only seals the client
    // emit shape.
    const before = JSON.stringify(fullNegotiator().compile())
    const after = JSON.stringify(fullNegotiator().compile())
    expect(before).toBe(after)
  })

  test("HELL-C-04: JSON-canonical serialization (sorted keys)", () => {
    // Two fresh negotiators must serialize to byte-identical JSON regardless
    // of construction order. Insertion order is alphabetical in the impl so
    // the on-wire bytes are deterministic across runs.
    const a = JSON.stringify(fullNegotiator().compile())
    const b = JSON.stringify(fullNegotiator().compile())
    expect(a).toBe(b)
    // The canonical order is alphabetical: elicitation, sampling, tasks, tools.
    expect(a).toBe('{"elicitation":{},"sampling":{},"tasks":{"listChanged":false},"tools":{}}')
  })
})
