import { describe, expect, test } from "bun:test"
import { createRejectCounter } from "../../../../src/apps/cli/reject-counter"

describe("reject-counter", () => {
  test("initial count is 0 and shouldAutoExit=false", () => {
    const r = createRejectCounter()
    expect(r.count()).toBe(0)
    expect(r.shouldAutoExit()).toBe(false)
  })

  test("recordDeny increments and returns the new total", () => {
    const r = createRejectCounter()
    expect(r.recordDeny()).toBe(1)
    expect(r.recordDeny()).toBe(2)
    expect(r.count()).toBe(2)
  })

  test("recordAccept resets the consecutive counter to 0", () => {
    const r = createRejectCounter()
    r.recordDeny()
    r.recordDeny()
    r.recordDeny()
    r.recordAccept()
    expect(r.count()).toBe(0)
  })

  test("default threshold 20 fires shouldAutoExit on the 20th deny (Cursor §4.1)", () => {
    const r = createRejectCounter()
    for (let i = 0; i < 19; i += 1) {
      r.recordDeny()
      expect(r.shouldAutoExit()).toBe(false)
    }
    r.recordDeny()
    expect(r.count()).toBe(20)
    expect(r.shouldAutoExit()).toBe(true)
  })

  test("custom threshold honored", () => {
    const r = createRejectCounter({ threshold: 3 })
    r.recordDeny()
    r.recordDeny()
    expect(r.shouldAutoExit()).toBe(false)
    r.recordDeny()
    expect(r.shouldAutoExit()).toBe(true)
  })

  test("19 deny + 1 accept + 19 deny ⇒ shouldAutoExit=false (consecutive)", () => {
    const r = createRejectCounter()
    for (let i = 0; i < 19; i += 1) r.recordDeny()
    r.recordAccept()
    for (let i = 0; i < 19; i += 1) r.recordDeny()
    expect(r.count()).toBe(19)
    expect(r.shouldAutoExit()).toBe(false)
  })

  test("reset clears the counter", () => {
    const r = createRejectCounter({ threshold: 2 })
    r.recordDeny()
    r.recordDeny()
    expect(r.shouldAutoExit()).toBe(true)
    r.reset()
    expect(r.count()).toBe(0)
    expect(r.shouldAutoExit()).toBe(false)
  })

  test("Infinity / 0 / negative threshold disables auto-exit", () => {
    const a = createRejectCounter({ threshold: Number.POSITIVE_INFINITY })
    for (let i = 0; i < 100; i += 1) a.recordDeny()
    expect(a.shouldAutoExit()).toBe(false)

    const b = createRejectCounter({ threshold: 0 })
    b.recordDeny()
    expect(b.shouldAutoExit()).toBe(false)

    const c = createRejectCounter({ threshold: -5 })
    c.recordDeny()
    expect(c.shouldAutoExit()).toBe(false)
  })

  test("recordDeny return value matches count() after each step", () => {
    const r = createRejectCounter({ threshold: 5 })
    for (let i = 1; i <= 5; i += 1) {
      expect(r.recordDeny()).toBe(i)
      expect(r.count()).toBe(i)
    }
    expect(r.shouldAutoExit()).toBe(true)
  })
})
