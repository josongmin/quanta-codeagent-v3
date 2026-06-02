/** RFC-09 (A) hellgate — `resolveNotifyChannel` gate: default-OFF opt-in,
 *  non-TTY suppression, TERM=dumb, channel selection, fail-closed unknowns. */

import { describe, expect, test } from "bun:test"
import { resolveNotifyChannel } from "../notify-enabled"

describe("RFC-09 A — resolveNotifyChannel", () => {
  test("non-TTY ⇒ off (never write OSC to a pipe), even with QUANTA_NOTIFY=bell", () => {
    expect(resolveNotifyChannel({ QUANTA_NOTIFY: "bell" }, false)).toBe("off")
    expect(resolveNotifyChannel({ QUANTA_NOTIFY: "bell" }, undefined)).toBe("off")
  })

  test("TTY + QUANTA_NOTIFY unset ⇒ off (default-OFF opt-in)", () => {
    expect(resolveNotifyChannel({}, true)).toBe("off")
  })

  test("TTY + QUANTA_NOTIFY=bell ⇒ bell", () => {
    expect(resolveNotifyChannel({ QUANTA_NOTIFY: "bell" }, true)).toBe("bell")
  })

  test("TTY + QUANTA_NOTIFY=title / title_only ⇒ title_only", () => {
    expect(resolveNotifyChannel({ QUANTA_NOTIFY: "title" }, true)).toBe("title_only")
    expect(resolveNotifyChannel({ QUANTA_NOTIFY: "title_only" }, true)).toBe("title_only")
  })

  test("TTY + truthy (1/on/true/yes) ⇒ bell", () => {
    for (const v of ["1", "on", "true", "yes", "ON", "True"]) {
      expect(resolveNotifyChannel({ QUANTA_NOTIFY: v }, true)).toBe("bell")
    }
  })

  test("TTY + falsy (0/off/false/no) ⇒ off", () => {
    for (const v of ["0", "off", "false", "no", "OFF"]) {
      expect(resolveNotifyChannel({ QUANTA_NOTIFY: v }, true)).toBe("off")
    }
  })

  test("TERM=dumb hard-gates to off even with opt-in", () => {
    expect(resolveNotifyChannel({ QUANTA_NOTIFY: "bell", TERM: "dumb" }, true)).toBe("off")
  })

  test("unknown value fails closed (off)", () => {
    expect(resolveNotifyChannel({ QUANTA_NOTIFY: "loud" }, true)).toBe("off")
  })

  test("whitespace + case insensitivity", () => {
    expect(resolveNotifyChannel({ QUANTA_NOTIFY: "  BELL  " }, true)).toBe("bell")
  })
})
