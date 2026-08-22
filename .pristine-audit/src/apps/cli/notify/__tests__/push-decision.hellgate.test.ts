/** B5 (jul-03) hellgate — pure `shouldPush` presence-aware push decision.
 *  Truth table: config_off / user_present / no_transport / pushSent. Pure
 *  (no I/O). Mirrors Claude Code's presence-gated push (suppress the OSC/BEL
 *  when the user is actively at the keyboard). */

import { describe, expect, test } from "bun:test"
import { shouldPush } from "../push-decision"

describe("B5 — shouldPush truth table", () => {
  test("all clear (on + absent user + transport) ⇒ pushSent, no reason", () => {
    expect(shouldPush({ status: "on", present: false, transport: true })).toEqual({
      pushSent: true,
    })
  })

  test("config off ⇒ suppressed with reason config_off (highest precedence)", () => {
    expect(shouldPush({ status: "off", present: false, transport: true })).toEqual({
      pushSent: false,
      disabledReason: "config_off",
    })
  })

  test("config_off wins even when user present AND no transport", () => {
    expect(shouldPush({ status: "off", present: true, transport: false })).toEqual({
      pushSent: false,
      disabledReason: "config_off",
    })
  })

  test("no transport ⇒ suppressed with reason no_transport (before presence)", () => {
    expect(shouldPush({ status: "on", present: false, transport: false })).toEqual({
      pushSent: false,
      disabledReason: "no_transport",
    })
  })

  test("no_transport wins over user_present when both hold", () => {
    expect(shouldPush({ status: "on", present: true, transport: false })).toEqual({
      pushSent: false,
      disabledReason: "no_transport",
    })
  })

  test("user present (on + transport) ⇒ suppressed with reason user_present", () => {
    expect(shouldPush({ status: "on", present: true, transport: true })).toEqual({
      pushSent: false,
      disabledReason: "user_present",
    })
  })
})
