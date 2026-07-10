/**
 * P2 (jul-11, UUX-4-18) — /retry-with parity core. The web protocol carries no
 * per-turn model (TurnRunCommand is an empty envelope), so /retry-with is a
 * two-step: switch the model override, then RESEND the last user message. This
 * pins the pure core (last-user extraction + the honest two-step plan); the
 * palette entry wires it to postConfig + sendTurn.
 */
import { describe, expect, it } from "vitest"
import type { UiMessage } from "../types/protocol"
import { lastUserText, planRetryWith } from "./retry-with"

const msg = (role: UiMessage["role"], text: string, id = role + text): UiMessage => ({
  id,
  role,
  text,
  timestamp: "t",
})

describe("lastUserText", () => {
  it("returns the newest user message text", () => {
    expect(lastUserText([msg("user", "first"), msg("assistant", "a"), msg("user", "second")])).toBe(
      "second",
    )
  })
  it("skips non-user roles", () => {
    expect(lastUserText([msg("user", "u"), msg("assistant", "a"), msg("error", "e")])).toBe("u")
  })
  it("null when no user message exists", () => {
    expect(lastUserText([msg("assistant", "a")])).toBeNull()
    expect(lastUserText([])).toBeNull()
  })
  it("ignores an empty/whitespace user message", () => {
    expect(lastUserText([msg("user", "real"), msg("user", "   ")])).toBe("real")
  })
})

describe("planRetryWith", () => {
  it("rejects a blank slug", () => {
    expect(planRetryWith("", [msg("user", "hi")])).toEqual({ ok: false, reason: "no_slug" })
  })
  it("rejects when there is no prior user message", () => {
    expect(planRetryWith("gpt-5", [msg("assistant", "a")])).toEqual({
      ok: false,
      reason: "no_prior_turn",
    })
  })
  it("plans the model override + resend text", () => {
    expect(planRetryWith("  gpt-5  ", [msg("user", "explain X")])).toEqual({
      ok: true,
      slug: "gpt-5",
      resendText: "explain X",
    })
  })
})
